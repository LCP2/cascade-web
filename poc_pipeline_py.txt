#!/usr/bin/env python3
"""
Cascade Movies — proof-of-concept backend pipeline
===================================================

Demonstrates the full daily loop for the release-window tracker:

    ingest (TMDB)  ->  enrich (OMDb)  ->  poll (Watchmode)
        -> derive status set -> diff vs yesterday -> emit alerts

Run WITHOUT keys and it uses the bundled illustrative sample data so you can
see the whole flow end-to-end. Set the three env vars and it hits the live
APIs instead. Nothing else changes.

    export TMDB_API_KEY=...          # https://www.themoviedb.org/settings/api   (free)
    export OMDB_API_KEY=...          # https://www.omdbapi.com/apikey.aspx        (free 1k/day)
    export WATCHMODE_API_KEY=...     # https://api.watchmode.com/requestApiKey    (free 2.5k/mo)

    python3 poc_pipeline.py                 # one daily run
    python3 poc_pipeline.py --simulate-day  # run again with a scripted change, to see alerts fire

State persists between runs in ./state/ so the diff engine has a "yesterday"
to compare against. Output for the app front-end is written to movies.json.
"""

from __future__ import annotations
import os, sys, json, time, datetime, urllib.parse, urllib.request

REGION = "AU"                      # the country this instance tracks
CURRENCY = "AUD"

# --- window heuristics (this is YOUR business logic, not something an API gives you) ---
PVOD_MIN_PRICE   = 19.99          # a buy/rent at or above this, with no subscription yet, = premium early window
RENTAL_MAX_PRICE = 9.99           # a rent at or below this = standard rental window

STATE_DIR = os.path.join(os.path.dirname(__file__), "state")
SNAPSHOT_FILE = os.path.join(STATE_DIR, "last_snapshot.json")
ALERTS_FILE   = os.path.join(STATE_DIR, "alerts.json")
OUTPUT_FILE   = os.path.join(os.path.dirname(__file__), "movies.json")
SAMPLE_FILE   = os.path.join(os.path.dirname(__file__), "sample_data.json")
TEMPLATE_FILE = os.path.join(os.path.dirname(__file__), "app_template.html")
APP_FILE      = os.path.join(os.path.dirname(__file__), "index.html")

TMDB_KEY      = os.environ.get("TMDB_API_KEY")
OMDB_KEY      = os.environ.get("OMDB_API_KEY")
WATCHMODE_KEY = os.environ.get("WATCHMODE_API_KEY")
LIVE = bool(TMDB_KEY and OMDB_KEY and WATCHMODE_KEY)


# ---------------------------------------------------------------------------
# tiny HTTP helper
# ---------------------------------------------------------------------------
def get_json(url: str) -> dict:
    req = urllib.request.Request(url, headers={"User-Agent": "cascade-poc/0.1"})
    with urllib.request.urlopen(req, timeout=20) as r:
        return json.load(r)


# ---------------------------------------------------------------------------
# 1. INGEST — which films are/were recently in AU cinemas
# ---------------------------------------------------------------------------
def ingest_tmdb() -> list[dict]:
    """Return skeleton records: tmdb_id, imdb_id, title, year, genres, cinema_date, gross."""
    base = "https://api.themoviedb.org/3"
    movies = []
    now_playing = get_json(
        f"{base}/movie/now_playing?api_key={TMDB_KEY}&region={REGION}&page=1"
    )
    for m in now_playing.get("results", []):
        detail = get_json(
            f"{base}/movie/{m['id']}?api_key={TMDB_KEY}&append_to_response=release_dates"
        )
        # AU theatrical (type 3) or limited (type 2)
        cinema_date = None
        for entry in detail.get("release_dates", {}).get("results", []):
            if entry["iso_3166_1"] == REGION:
                for rd in entry["release_dates"]:
                    if rd["type"] in (2, 3):
                        cinema_date = rd["release_date"][:10]
        movies.append({
            "tmdb_id": detail["id"],
            "imdb_id": detail.get("imdb_id"),
            "title": detail["title"],
            "year": (detail.get("release_date") or "----")[:4],
            "genres": [g["name"] for g in detail.get("genres", [])],
            "cinema_date": cinema_date,
            "worldwide_gross": detail.get("revenue") or None,   # single global number, often incomplete
            "poster": detail.get("poster_path"),
        })
    return movies


# ---------------------------------------------------------------------------
# 2. ENRICH — IMDb + Rotten Tomatoes(critic) + Metacritic via OMDb
# ---------------------------------------------------------------------------
def enrich_omdb(movie: dict) -> dict:
    if not movie.get("imdb_id"):
        return movie
    data = get_json(f"https://www.omdbapi.com/?i={movie['imdb_id']}&apikey={OMDB_KEY}")
    movie["imdb_rating"] = _num(data.get("imdbRating"))
    movie["imdb_votes"]  = _int(data.get("imdbVotes"))
    for r in data.get("Ratings", []):
        if r["Source"] == "Rotten Tomatoes":
            movie["rt_critic"] = _int(r["Value"].replace("%", ""))
        elif r["Source"] == "Metacritic":
            movie["metacritic"] = _int(r["Value"].split("/")[0])
    # OMDb BoxOffice is US-domestic only; we keep TMDB worldwide as the headline gross
    return movie


# ---------------------------------------------------------------------------
# 3. POLL — current AU offers (service / type / price / format) via Watchmode
# ---------------------------------------------------------------------------
def poll_watchmode(movie: dict) -> list[dict]:
    """Return normalised offers: [{service, type, price, format}]."""
    # map to a Watchmode id via IMDb id
    lookup = get_json(
        "https://api.watchmode.com/v1/search/"
        f"?apiKey={WATCHMODE_KEY}&search_field=imdb_id&search_value={movie['imdb_id']}"
    )
    results = lookup.get("title_results", [])
    if not results:
        return []
    wm_id = results[0]["id"]
    sources = get_json(
        f"https://api.watchmode.com/v1/title/{wm_id}/sources/"
        f"?apiKey={WATCHMODE_KEY}&regions={REGION}"
    )
    offers = []
    for s in sources:
        if s.get("region") != REGION:
            continue
        offers.append({
            "service": s.get("name"),
            "type": s.get("type"),          # sub | rent | buy | free
            "price": _num(s.get("price")),
            "format": s.get("format"),      # SD | HD | 4K
        })
    return offers


# ---------------------------------------------------------------------------
# 4. DERIVE — turn raw offers + cinema date into a SET of active windows
# ---------------------------------------------------------------------------
def derive_status(movie: dict, offers: list[dict], today: datetime.date) -> list[str]:
    status = set()

    has_sub  = any(o["type"] in ("sub", "free") for o in offers)
    buys     = [o for o in offers if o["type"] == "buy" and o.get("price")]
    rents    = [o for o in offers if o["type"] == "rent" and o.get("price")]
    cheapest_rent = min((o["price"] for o in rents), default=None)
    dearest_buy   = max((o["price"] for o in buys),  default=None)

    # In cinema: theatrical date has passed and it hasn't hit any home offer yet
    cd = movie.get("cinema_date")
    in_cinema_window = cd and cd <= today.isoformat() and not offers
    if in_cinema_window:
        status.add("in_cinema")

    # Premium (PVOD): a dear buy/rent exists and it's not yet on subscription
    if not has_sub and ((dearest_buy and dearest_buy >= PVOD_MIN_PRICE) or
                        (cheapest_rent and cheapest_rent >= PVOD_MIN_PRICE)):
        status.add("pvod")

    # Standard rental: a rent at/under the everyday-rental price
    if cheapest_rent is not None and cheapest_rent <= RENTAL_MAX_PRICE:
        status.add("rental")

    # Included streaming: on a subscription or free/ad-supported service
    if has_sub:
        status.add("included_streaming")

    if not status:
        status.add("in_cinema" if cd and cd <= today.isoformat() else "upcoming")
    return sorted(status)


# ---------------------------------------------------------------------------
# 5. DIFF — compare today's status set to the stored one, emit change events
# ---------------------------------------------------------------------------
STATUS_LABEL = {
    "upcoming": "Upcoming",
    "in_cinema": "In Cinema",
    "pvod": "Premium Buy/Rent (~$30)",
    "rental": "Standard Rental (~$7)",
    "included_streaming": "Included Streaming",
}

def diff_and_alert(today_records: list[dict]) -> list[dict]:
    prev = {}
    if os.path.exists(SNAPSHOT_FILE):
        prev = {m["tmdb_id"]: m for m in json.load(open(SNAPSHOT_FILE))}

    events = []
    for m in today_records:
        before = set(prev.get(m["tmdb_id"], {}).get("status", []))
        after  = set(m["status"])
        opened = after - before
        for w in opened:
            if before:  # only alert on genuine transitions, not first sighting
                events.append({
                    "tmdb_id": m["tmdb_id"],
                    "title": m["title"],
                    "new_window": w,
                    "label": STATUS_LABEL.get(w, w),
                    "services": [o["service"] for o in m.get("offers", [])
                                 if _window_of(o) == w][:3],
                    "detected": today_records_date(),
                })
    # persist
    os.makedirs(STATE_DIR, exist_ok=True)
    json.dump(today_records, open(SNAPSHOT_FILE, "w"), indent=2)
    existing = json.load(open(ALERTS_FILE)) if os.path.exists(ALERTS_FILE) else []
    json.dump(existing + events, open(ALERTS_FILE, "w"), indent=2)
    return events


def _window_of(offer: dict) -> str:
    if offer["type"] in ("sub", "free"): return "included_streaming"
    if offer["type"] == "buy":  return "pvod"
    if offer["type"] == "rent":
        return "rental" if (offer.get("price") or 99) <= RENTAL_MAX_PRICE else "pvod"
    return ""


# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------
def _num(v):
    try: return round(float(str(v).replace("$", "").replace(",", "")), 2)
    except (TypeError, ValueError): return None

def _int(v):
    try: return int(str(v).replace(",", "").replace("$", ""))
    except (TypeError, ValueError): return None

_RUN_DATE = datetime.date.today().isoformat()
def today_records_date(): return _RUN_DATE


# ---------------------------------------------------------------------------
# orchestration
# ---------------------------------------------------------------------------
def run(simulate_day: bool = False):
    today = datetime.date.today()

    if LIVE:
        print(f"[live] ingesting AU cinema releases from TMDB ...")
        records = ingest_tmdb()
        for m in records:
            enrich_omdb(m)
            m["offers"] = poll_watchmode(m)
            m["status"] = derive_status(m, m["offers"], today)
            time.sleep(0.3)  # be polite to free tiers
    else:
        print("[sample] no API keys set — using bundled illustrative data.")
        records = json.load(open(SAMPLE_FILE))["movies"]
        if simulate_day:
            _apply_scripted_change(records)
        for m in records:
            m["status"] = derive_status(m, m.get("offers", []), today)

    events = diff_and_alert(records)

    payload = {
        "generated": today.isoformat(),
        "region": REGION,
        "currency": CURRENCY,
        "live": LIVE,
        "movies": records,
    }
    json.dump(payload, open(OUTPUT_FILE, "w"), indent=2)
    build_html(records)                       # regenerate the double-clickable app

    print(f"\n{len(records)} titles written to movies.json  ({'LIVE' if LIVE else 'sample'} data)")
    print(f"index.html rebuilt — open it in any browser.")
    print(f"{len(events)} status-change alert(s) this run:")
    for e in events:
        svc = f" on {', '.join(e['services'])}" if e["services"] else ""
        print(f"   • {e['title']}  ->  {e['label']}{svc}")
    if not events:
        print("   (none — run again with --simulate-day to see the alert path fire)")


def build_html(records: list[dict] | None = None):
    """Inject the latest movies + date into app_template.html -> index.html.
    Keeps the app a single double-clickable file (no server, no CORS)."""
    if records is None:  # --build-html on its own: rebuild from the last movies.json
        records = json.load(open(OUTPUT_FILE))["movies"]
    if not os.path.exists(TEMPLATE_FILE):
        print("! app_template.html not found — cannot build index.html"); return
    html = open(TEMPLATE_FILE, encoding="utf-8").read()
    html = html.replace("__MOVIES_JSON__", json.dumps(records))
    html = html.replace("__TODAY__", datetime.date.today().isoformat())
    open(APP_FILE, "w", encoding="utf-8").write(html)


def _apply_scripted_change(records: list[dict]):
    """Demo only: nudge a couple of titles into their next window so the diff fires."""
    for m in records:
        if m["title"].startswith("The Long Walk Home"):
            m["offers"] = [o for o in m["offers"] if o["type"] != "buy"] + [
                {"service": "Netflix", "type": "sub", "price": None, "format": "4K"}]
        if m["title"].startswith("Harbour Lights"):
            m["offers"] += [{"service": "Apple TV", "type": "rent", "price": 6.99, "format": "HD"}]


if __name__ == "__main__":
    if "--build-html" in sys.argv:
        build_html()                          # rebuild index.html from existing movies.json only
        print("index.html rebuilt from movies.json — open it in any browser.")
    else:
        run(simulate_day="--simulate-day" in sys.argv)
