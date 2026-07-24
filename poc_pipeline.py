#!/usr/bin/env python3
"""
Cascade Movies — proof-of-concept backend pipeline
===================================================

Demonstrates the full daily loop for the release-window tracker:

    ingest (TMDB) -> enrich (OMDb) -> availability (TMDB Watch Providers, AU)
        -> derive status -> diff vs yesterday -> emit alerts

CAS-127: the PRIMARY availability source is TMDB Watch Providers (free, data by
JustWatch — no monthly quota), one call per title per day across the whole
catalogue. Watchmode is demoted to optional ON-DEMAND enrichment (exact rent/buy
prices + verified deep-links) for titles a user opens or saves — never the daily
sweep. This is what lets availability scale to a big catalogue (CAS-128).

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
import os, sys, json, time, datetime, subprocess, urllib.parse, urllib.request, urllib.error

REGION = "AU"                      # the country this instance tracks
CURRENCY = "AUD"

# --- catalogue scope: work BACKWARDS from cinema, not just "now playing" ---
# CAS-128: the ~300 cap is lifted now that availability is free (TMDB Providers, CAS-127).
# All three are env-driven so widening — including the Phase-3 "drop the cinema-release
# requirement → all films" — is a one-line config change, no code edit.
LOOKBACK_DAYS = int(os.getenv("LOOKBACK_DAYS", "1095"))   # AU theatrical release lookback (~3 years)
MAX_TITLES    = int(os.getenv("MAX_TITLES", "5000"))      # ingest breadth: pull the full AU set in the window, not a top-N slice
OPENING_WEEK_DAYS = 7            # a cinema release this recent counts as "opening week"

# --- and FORWARDS from cinema: films announced for AU cinemas but not out yet ---
# These fill the stepper's "Upcoming" slot and feed the Blockbuster-radar Cascade.
# They cost ZERO Watchmode calls: a film that hasn't opened has no AU home offers to
# poll, so the free-tier budget stays entirely with the released catalogue above.
# CAS-125: widen the upcoming window so announced tentpoles (e.g. Avengers: Doomsday) appear.
# Zero availability budget — an unreleased film has no AU home offers to poll (no provider/Watchmode
# calls; TMDB detail only), so this never touches the free-tier availability sweep. Env-driven to widen further.
UPCOMING_LOOKAHEAD_DAYS = int(os.getenv("UPCOMING_LOOKAHEAD_DAYS", "540"))   # ~18 months ahead
MAX_UPCOMING            = int(os.getenv("MAX_UPCOMING", "100"))              # announced AU theatrical; TMDB detail calls only

# --- window heuristics (this is YOUR business logic, not something an API gives you) ---
PVOD_MIN_PRICE   = 19.99          # a buy/rent at or above this, with no subscription yet, = premium early window
RENTAL_MAX_PRICE = 9.99           # a rent at or below this = standard rental window

STATE_DIR = os.path.join(os.path.dirname(__file__), "state")
SNAPSHOT_FILE = os.path.join(STATE_DIR, "last_snapshot.json")
ALERTS_FILE   = os.path.join(STATE_DIR, "alerts.json")
WM_CACHE_FILE = os.path.join(STATE_DIR, "watchmode_ids.json")   # imdb_id -> watchmode_id (never changes)
WINDOW_DATES_FILE = os.path.join(STATE_DIR, "window_dates.json")  # tmdb_id -> {window: first_seen_date}
OUTPUT_FILE   = os.path.join(os.path.dirname(__file__), "movies.json")
SAMPLE_FILE   = os.path.join(os.path.dirname(__file__), "sample_data.json")
TEMPLATE_FILE = os.path.join(os.path.dirname(__file__), "app_template.html")
APP_FILE      = os.path.join(os.path.dirname(__file__), "index.html")
VERSION_FILE  = os.path.join(os.path.dirname(__file__), "VERSION")        # hand-bumped SemVer (CAS-124)
VERSION_JSON  = os.path.join(os.path.dirname(__file__), "version.json")   # machine-readable build stamp

TMDB_KEY      = os.environ.get("TMDB_API_KEY")
OMDB_KEY      = os.environ.get("OMDB_API_KEY")
WATCHMODE_KEY = os.environ.get("WATCHMODE_API_KEY")
LIVE = bool(TMDB_KEY and OMDB_KEY and WATCHMODE_KEY)

# CAS-109 — poll-tiering + free-tier-capped scheduler (staging prototype).
import poll_scheduler as ps
CATALOGUE_TARGET = int(os.getenv("CATALOGUE_TARGET", str(MAX_TITLES)))
                         # CAS-128: persistent browsable catalogue size — defaults to MAX_TITLES so the
                         # ~300 cap is gone and the full ingested AU set is held. Availability is free
                         # (TMDB Providers), so catalogue size no longer gates the daily budget.

# CAS-127 — TMDB Watch Providers is the primary availability source (free, no quota).
# It runs once per released title per day across the WHOLE catalogue, so pace it politely
# (TMDB historically allows ~50 req/s and no daily cap). Watchmode is now on-demand only.
TMDB_PACING      = float(os.getenv("TMDB_PACING", "0.05"))   # seconds between provider calls (~20/s)
ONDEMAND_WM_CAP  = int(os.getenv("ONDEMAND_WM_CAP", str(ps.ONDEMAND_RESERVE)))  # Watchmode enrich/day ceiling
OMDB_DAILY_BUDGET = int(os.getenv("OMDB_DAILY_BUDGET", "900"))  # OMDb ratings enrich/day (free tier ~1000/day)
# CAS-156: a rating is only back-filled when a title has none, so the FIRST number OMDb ever returned was kept
# for good. For an obscure title that first read lands while a handful of people have rated it, and it is wrong
# almost immediately (Jellyfish: 9.4 off 8 votes, since settled to ~8.8). Titles under the vote bar are exactly
# the ones whose score is still moving, so they get re-read — on their own small budget, so that back-filling
# titles with NO rating at all keeps first claim on the free tier.
IMDB_MIN_VOTES      = int(os.getenv("IMDB_MIN_VOTES", "1000"))   # keep in step with app_template.html
OMDB_REFRESH_BUDGET = int(os.getenv("OMDB_REFRESH_BUDGET", "150"))


# ---------------------------------------------------------------------------
# tiny HTTP helper
# ---------------------------------------------------------------------------
def get_json(url: str, retries: int = 4) -> dict:
    """GET + parse JSON, with polite backoff on rate-limit / transient server errors.
    CAS-128: the full-catalogue ingest + daily provider sweep make many calls, so honour
    HTTP 429 (Retry-After when given, else exponential) and retry 5xx a few times."""
    req = urllib.request.Request(url, headers={"User-Agent": "cascade-poc/0.1"})
    for attempt in range(retries + 1):
        try:
            with urllib.request.urlopen(req, timeout=20) as r:
                return json.load(r)
        except urllib.error.HTTPError as e:
            if e.code in (429, 500, 502, 503, 504) and attempt < retries:
                wait = e.headers.get("Retry-After") if e.code == 429 else None
                delay = float(wait) if (wait and str(wait).isdigit()) else min(30.0, 2.0 ** attempt)
                time.sleep(delay)
                continue
            raise


# ---------------------------------------------------------------------------
# 1. INGEST — which films are/were recently in AU cinemas
# ---------------------------------------------------------------------------
TMDB_BASE = "https://api.themoviedb.org/3"

def _tmdb_record(detail: dict) -> dict:
    """Map one TMDB detail payload to our skeleton record."""
    cinema_date, age_rating = None, None
    for entry in detail.get("release_dates", {}).get("results", []):
        if entry["iso_3166_1"] == REGION:
            for rd in entry["release_dates"]:
                if rd["type"] in (2, 3):
                    cinema_date = rd["release_date"][:10]
                cert = (rd.get("certification") or "").strip()
                if cert and not age_rating:      # AU classification (G/PG/M/MA15+/R18+)
                    age_rating = cert
    lang = detail.get("original_language")
    countries = [c["iso_3166_1"] for c in detail.get("production_countries", [])]
    vids = (detail.get("videos") or {}).get("results", [])
    trailers = [v["key"] for v in vids
                if v.get("site") == "YouTube" and v.get("type") in ("Trailer", "Teaser") and v.get("key")][:4]
    credits = detail.get("credits") or {}
    directors = [c["name"] for c in credits.get("crew", []) if c.get("job") == "Director"]
    cast = [c["name"] for c in sorted(credits.get("cast", []),
                                      key=lambda c: c.get("order", 999))][:4]
    return {
        "tmdb_id": detail["id"],
        "imdb_id": detail.get("imdb_id"),
        "title": detail["title"],
        "year": (detail.get("release_date") or "----")[:4],
        "genres": [g["name"] for g in detail.get("genres", [])],
        "cinema_date": cinema_date,
        "age_rating": age_rating,
        "worldwide_gross": detail.get("revenue") or None,   # single global number, often incomplete
        "budget": detail.get("budget") or None,             # TMDB budget (0 when unknown) — a badge, never a ranker:
                                                            # TMDB knows it for only ~5 of our 12 upcoming titles
        "popularity": detail.get("popularity") or None,     # TMDB popularity — present for every title, so it's what
                                                            # ranks the un-released "Most anticipated" list
        "synopsis": (detail.get("overview") or "").strip(),
        "language": lang,
        "culture": _culture(lang, countries),
        "poster": detail.get("poster_path"),
        "trailers": trailers,
        "director": ", ".join(directors[:2]) or None,
        "cast": cast,
    }


def _discover_au_theatrical(start: str, end: str, cap: int, seen: set) -> list[dict]:
    """AU theatrical (type 3) or limited (2) releases dated in [start, end],
    most-popular first, up to `cap`. `seen` carries tmdb_ids already taken by an
    earlier pass so a title can't land in two groups.

    CAS-128: page depth scales with `cap` (was a hard 10 pages ≈ 200 titles) so a big
    cap pulls the full AU set, bounded by TMDB's 500-page discover limit. Detail calls
    are paced politely; get_json handles 429/5xx backoff."""
    movies, page = [], 1
    max_pages = min(500, max(1, -(-cap // 20)))              # ~20 results/page; ceil, capped at TMDB's max
    while len(movies) < cap and page <= max_pages:
        disc = get_json(
            f"{TMDB_BASE}/discover/movie?api_key={TMDB_KEY}&region={REGION}"
            f"&with_release_type=2|3"                         # AU theatrical (3) or limited (2)
            f"&release_date.gte={start}&release_date.lte={end}"
            f"&sort_by=popularity.desc&page={page}"
        )
        results = disc.get("results", [])
        if not results:
            break
        for m in results:
            if m["id"] in seen:
                continue
            seen.add(m["id"])
            detail = get_json(
                f"{TMDB_BASE}/movie/{m['id']}?api_key={TMDB_KEY}&append_to_response=release_dates,videos,credits"
            )
            movies.append(_tmdb_record(detail))
            if TMDB_PACING:
                time.sleep(TMDB_PACING)                       # polite pacing on the detail-call loop
            if len(movies) >= cap:
                break
        page += 1
    return movies


def ingest_tmdb(seen: set) -> list[dict]:
    """Work BACKWARDS from cinema: every film that had an AU theatrical release
    in the last LOOKBACK_DAYS, most-popular first — so the catalogue spans the
    whole cascade (still in cinemas -> PVOD -> rental -> included streaming),
    not just this week's new releases. Capped to MAX_TITLES for the Watchmode
    free-tier daily budget."""
    today = datetime.date.today()
    start = (today - datetime.timedelta(days=LOOKBACK_DAYS)).isoformat()
    return _discover_au_theatrical(start, today.isoformat(), MAX_TITLES, seen)


def ingest_tmdb_upcoming(seen: set) -> list[dict]:
    """Work FORWARDS from cinema: films with an announced AU theatrical date in the
    next UPCOMING_LOOKAHEAD_DAYS. These have not opened, so they carry no offers and
    derive to the "upcoming" window — the real state for the stepper's cinema slot,
    and the pool the Blockbuster-radar Cascade ranks by popularity ("Most anticipated")."""
    today = datetime.date.today()
    start = (today + datetime.timedelta(days=1)).isoformat()          # strictly future
    end   = (today + datetime.timedelta(days=UPCOMING_LOOKAHEAD_DAYS)).isoformat()
    return _discover_au_theatrical(start, end, MAX_UPCOMING, seen)


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
    movie["award"] = _oscar_status(data.get("Awards", ""))   # None | "nominated" | "won"
    aw = (data.get("Awards") or "").strip()
    movie["award_text"] = "" if aw == "N/A" else aw          # full text, shown when the icon is tapped
    # OMDb BoxOffice is US-domestic only; we keep TMDB worldwide as the headline gross
    return movie


# Map a film's original language (with production country as a tiebreak) to a
# broad "culture" bucket — an approximation of the audience it was made for.
_LANG_CULTURE = {
    "ko":"Korean", "ja":"Japanese", "zh":"Chinese", "cn":"Chinese", "yue":"Chinese",
    "hi":"Indian", "ta":"Indian", "te":"Indian", "ml":"Indian", "kn":"Indian",
    "bn":"Indian", "pa":"Indian", "mr":"Indian",
    "th":"Southeast Asian", "id":"Southeast Asian", "vi":"Southeast Asian", "tl":"Southeast Asian",
    "fr":"European", "de":"European", "it":"European", "ru":"European", "sv":"European",
    "es":"Spanish/Latin", "pt":"Spanish/Latin",
}
_WESTERN_COUNTRIES = {"US","GB","AU","NZ","CA","IE"}

def _culture(lang: str | None, countries: list[str]) -> str:
    if lang in _LANG_CULTURE:
        return _LANG_CULTURE[lang]
    if lang == "en":
        return "Western"
    if any(c in _WESTERN_COUNTRIES for c in countries):
        return "Western"
    return "Other"


def _oscar_status(awards: str) -> str | None:
    """Read OMDb's free-text Awards field for top-award (Oscar) status.
    OMDb phrases it as 'Won N Oscars. ...' or 'Nominated for N Oscars. ...'."""
    aw = (awards or "").strip()
    if not aw or aw == "N/A":
        return None
    head = aw.split(".")[0]                     # first clause carries the headline award
    if "Oscar" in head or "Academy Award" in head:
        return "won" if head.lstrip().lower().startswith("won") else "nominated"
    return None


# ---------------------------------------------------------------------------
# 3a. AVAILABILITY (PRIMARY) — AU watch providers via TMDB (free, data by JustWatch)
# ---------------------------------------------------------------------------
def tmdb_providers(tmdb_id, region=REGION, api_key=None) -> dict:
    """AU watch-provider rows for one title from TMDB (data sourced from JustWatch).
    FREE and unquota'd — this is the primary availability signal (CAS-127), replacing the
    daily Watchmode poll. TMDB gives provider NAMES per category but no price or format;
    Watchmode enrichment fills those on-demand for engaged titles."""
    api_key = api_key or TMDB_KEY
    data = get_json(f"{TMDB_BASE}/movie/{tmdb_id}/watch/providers?api_key={api_key}")
    r = (data.get("results") or {}).get(region) or {}
    return {
        "flatrate": [p["provider_name"] for p in r.get("flatrate", [])],  # subscription/streaming
        "rent":     [p["provider_name"] for p in r.get("rent", [])],
        "buy":      [p["provider_name"] for p in r.get("buy", [])],
        "ads":      [p["provider_name"] for p in r.get("ads", [])],       # ad-supported (free to watch)
        "free":     [p["provider_name"] for p in r.get("free", [])],
        "jw_link":  r.get("link"),        # JustWatch page for AU (attribution / deep-out)
    }


def provider_offers(prov: dict) -> list[dict]:
    """Every AU provider row as a normalised offer (service/type/price/format).
    TMDB carries no price or format, so those are None until Watchmode enriches an
    engaged title. ads/free both map to a free-to-watch 'free' offer."""
    rows  = [(s, "sub")  for s in prov.get("flatrate", [])]
    rows += [(s, "free") for s in (prov.get("free", []) + prov.get("ads", []))]
    rows += [(s, "rent") for s in prov.get("rent", [])]
    rows += [(s, "buy")  for s in prov.get("buy", [])]
    return [{"service": s, "type": t, "price": None, "format": None} for s, t in rows]


def derive_from_providers(movie: dict, prov: dict, today: datetime.date) -> list[str]:
    """Headline Cascade window from TMDB/JustWatch AU providers (CAS-127 cascade):
      flatrate|free|ads  -> included_streaming
      else rent|buy      -> rental (a rent offer exists) or pvod (buy-only, pre-rental).
                            TMDB gives no price, so premium vs standard can't use
                            PVOD_MIN_PRICE — a rentable title is the standard window,
                            a buy-only title is the earlier premium/PVOD window.
      else               -> in_cinema if it has opened, otherwise upcoming."""
    if prov.get("flatrate") or prov.get("free") or prov.get("ads"):
        return ["included_streaming"]
    if prov.get("rent") or prov.get("buy"):
        return ["rental"] if prov.get("rent") else ["pvod"]
    cd = movie.get("cinema_date")
    return ["in_cinema"] if (cd and cd <= today.isoformat()) else ["upcoming"]


def has_provider_rows(prov: dict) -> bool:
    """True if TMDB/JustWatch has ANY AU availability row for the title."""
    return any(prov.get(k) for k in ("flatrate", "free", "ads", "rent", "buy"))


# ---------------------------------------------------------------------------
# 3b. ENRICHMENT (ON-DEMAND ONLY) — exact AU prices / deep-links via Watchmode
#     Called for titles a user opens or saves, within a small bounded budget —
#     NOT the daily sweep (CAS-127). Prices/formats/deep-links TMDB can't give.
# ---------------------------------------------------------------------------
def poll_watchmode(movie: dict, wm_cache: dict) -> list[dict]:
    """Return normalised offers: [{service, type, price, format}].
    The IMDb->Watchmode id mapping never changes, so cache it: after the first
    sighting each title costs only ONE call/day (sources), ~halving API usage."""
    imdb = movie["imdb_id"]
    wm_id = wm_cache.get(imdb)
    if wm_id is None:                                    # first time we've seen this title
        lookup = get_json(
            "https://api.watchmode.com/v1/search/"
            f"?apiKey={WATCHMODE_KEY}&search_field=imdb_id&search_value={imdb}"
        )
        results = lookup.get("title_results", [])
        if not results:
            return []
        wm_id = results[0]["id"]
        wm_cache[imdb] = wm_id
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
        # A priced rent splits premium(pvod)/standard(rental) on PVOD_MIN_PRICE; a
        # price-less rent (TMDB providers give no price) is the standard rental window,
        # matching derive_from_providers so alert `services` line up with the window.
        return "rental" if (offer.get("price") or 0) <= RENTAL_MAX_PRICE else "pvod"
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
# CAS-109 — build the persistent catalogue, poll only the daily set, carry the rest
# ---------------------------------------------------------------------------
def build_live_catalogue(today, base_records, wm_cache, offsets=None, ondemand_ids=None):
    """Merge new TMDB ingest into the persistent base, then derive availability for the
    WHOLE released catalogue from TMDB Watch Providers (free, one call/title/day — CAS-127).
    Watchmode is spent only to ENRICH the on-demand set (titles a user opened/saved) with
    exact prices + deep-links, within a small bounded budget. OMDb ratings are back-filled
    for un-rated titles under a daily budget so new titles gain scores over runs.

    Deps (ingest_tmdb / ingest_tmdb_upcoming / enrich_omdb / poll_watchmode / tmdb_providers /
    derive_from_providers / derive_status) are module functions so tests can monkeypatch them.
    No file IO here — run() persists the result. Returns (catalogue_records, counts)."""
    offsets = offsets or ps.DEFAULT_OFFSETS
    base = {m["tmdb_id"]: m for m in base_records}
    seen = set(base)

    # grow the catalogue with new titles TMDB surfaces that we don't already hold
    new = []
    if len(base) < CATALOGUE_TARGET:
        new = ingest_tmdb(seen) + ingest_tmdb_upcoming(seen)
    catalogue = list(base.values()) + [m for m in new if m["tmdb_id"] not in base]
    catalogue.sort(key=lambda m: m.get("popularity") or 0, reverse=True)
    catalogue = catalogue[:CATALOGUE_TARGET]

    # Watchmode is on-demand only now: the poll-set matters just for the engaged titles.
    sched = ps.select_daily_poll_set(catalogue, today, ondemand_ids=ondemand_ids)
    ondemand_set = {m["tmdb_id"] for m in sched["ondemand"]}
    provider_calls = wm_calls = omdb_calls = 0
    omdb_budget, wm_budget = OMDB_DAILY_BUDGET, ONDEMAND_WM_CAP
    omdb_refresh = OMDB_REFRESH_BUDGET          # CAS-156: separate pot, so back-fill is never crowded out

    for m in catalogue:
        tier = ps.classify_tier(m, today)
        m["poll_tier"] = tier
        if tier == "none":                                   # upcoming — known from TMDB date
            m["offers"] = []
            m["status"] = ["upcoming"]
            m["availability_confidence"] = "confirmed"
            m["availability_source"] = "tmdb_date"
        else:
            # PRIMARY availability: free TMDB Watch Providers (AU), every released title, daily.
            prov = tmdb_providers(m["tmdb_id"]); provider_calls += 1
            m["jw_link"] = prov.get("jw_link")               # JustWatch deep-out + attribution
            if has_provider_rows(prov):
                m["offers"] = provider_offers(prov)
                m["status"] = derive_from_providers(m, prov, today)
                m["availability_confidence"] = "confirmed"   # as of today's provider snapshot
            else:                                            # JustWatch has no AU row -> honest estimate
                w, conf = ps.estimate_status(m, today, offsets)
                m["offers"] = []
                m["status"] = [w]
                m["availability_confidence"] = conf
            m["last_polled"] = today.isoformat()
            m["availability_source"] = "tmdb_providers"

            # OMDb back-fill for un-rated titles, bounded to stay under the free tier — plus a bounded re-read
            # of the thinly-voted (CAS-156), whose stored score is a first impression rather than a settled one.
            if m.get("imdb_id"):
                if not m.get("imdb_rating"):
                    if omdb_budget > 0:
                        enrich_omdb(m); omdb_calls += 1; omdb_budget -= 1
                elif (m.get("imdb_votes") or 0) < IMDB_MIN_VOTES and omdb_refresh > 0:
                    enrich_omdb(m); omdb_calls += 1; omdb_refresh -= 1

            # ON-DEMAND Watchmode enrichment: exact prices + deep-links for engaged titles only.
            if m["tmdb_id"] in ondemand_set and wm_budget > 0 and m.get("imdb_id"):
                wm_offers = poll_watchmode(m, wm_cache); wm_calls += 1; wm_budget -= 1
                if wm_offers:                                # richer than providers: real prices/formats
                    m["offers"] = wm_offers
                    m["status"] = derive_status(m, wm_offers, today)
                    m["availability_source"] = "watchmode_enriched"
                time.sleep(TMDB_PACING)
            if TMDB_PACING:
                time.sleep(TMDB_PACING)                      # polite pacing between provider calls

        st = set(m.get("status", []))
        if "included_streaming" in st and not (st & ps.ACTIVE_WINDOW):
            m.setdefault("settled_since", today.isoformat())
        else:
            m.pop("settled_since", None)

    counts = dict(sched["counts"])
    counts.update(provider_calls=provider_calls, wm_calls=wm_calls, omdb_calls=omdb_calls,
                  ondemand=len(ondemand_set), catalogue=len(catalogue))
    return catalogue, counts


# ---------------------------------------------------------------------------
# orchestration
# ---------------------------------------------------------------------------
def run(simulate_day: bool = False):
    today = datetime.date.today()

    if LIVE:
        print(f"[live] CAS-109 tiered poll — persistent catalogue, daily-active capped ...")
        wm_cache = json.load(open(WM_CACHE_FILE)) if os.path.exists(WM_CACHE_FILE) else {}
        base_records = json.load(open(SNAPSHOT_FILE)) if os.path.exists(SNAPSHOT_FILE) else []
        wd_seed = json.load(open(WINDOW_DATES_FILE)) if os.path.exists(WINDOW_DATES_FILE) else {}
        offsets = ps.compute_median_offsets(wd_seed)
        ondemand_file = os.path.join(STATE_DIR, "ondemand.json")
        ondemand_ids = json.load(open(ondemand_file)) if os.path.exists(ondemand_file) else []
        records, counts = build_live_catalogue(today, base_records, wm_cache,
                                               offsets=offsets, ondemand_ids=ondemand_ids)
        print(f"[live] catalogue {len(records)} | TMDB provider calls {counts['provider_calls']} (free, no quota) "
              f"| Watchmode on-demand {counts['wm_calls']}/{ONDEMAND_WM_CAP} | OMDb backfill {counts['omdb_calls']}")
        os.makedirs(STATE_DIR, exist_ok=True)
        json.dump(wm_cache, open(WM_CACHE_FILE, "w"), indent=2)
    else:
        print("[sample] no API keys set — using bundled illustrative data.")
        records = json.load(open(SAMPLE_FILE))["movies"]
        if simulate_day:
            _apply_scripted_change(records)
        for m in records:
            m["status"] = derive_status(m, m.get("offers", []), today)

    # Record the first date each title was seen in each window, so transition
    # dates become EXACT over time (no backfill — accrues from the first run).
    # The app uses these when present and falls back to estimates otherwise.
    wd = json.load(open(WINDOW_DATES_FILE)) if os.path.exists(WINDOW_DATES_FILE) else {}
    tstamp = today.isoformat()
    for m in records:
        key = str(m["tmdb_id"]); rec = wd.get(key, {})
        for w in m.get("status", []):
            rec.setdefault(w, tstamp)
        wd[key] = rec
        m["window_dates"] = rec
        m.setdefault("availability_confidence", "confirmed")   # CAS-109 (sample/legacy default)
        m.setdefault("poll_tier", ps.classify_tier(m, today))
    os.makedirs(STATE_DIR, exist_ok=True)
    json.dump(wd, open(WINDOW_DATES_FILE, "w"), indent=2)

    events = diff_and_alert(records)

    payload = {
        "generated": today.isoformat(),
        "region": REGION,
        "currency": CURRENCY,
        "live": LIVE,
        "movies": records,
    }
    json.dump(payload, open(OUTPUT_FILE, "w"), indent=2)
    os.makedirs(STATE_DIR, exist_ok=True)     # this run's changes, for the email step / CI
    json.dump(events, open(os.path.join(STATE_DIR, "last_run_events.json"), "w"), indent=2)
    build_html(records)                       # regenerate the double-clickable app

    n_up = sum(1 for m in records if "upcoming" in m.get("status", []))
    print(f"\n{len(records)} titles written to movies.json  ({'LIVE' if LIVE else 'sample'} data)"
          + (f" — {n_up} of them upcoming (not yet in cinemas)" if n_up else ""))
    print(f"index.html rebuilt — open it in any browser.")
    print(f"{len(events)} status-change alert(s) this run:")
    for e in events:
        svc = f" on {', '.join(e['services'])}" if e["services"] else ""
        print(f"   • {e['title']}  ->  {e['label']}{svc}")
    if not events:
        print("   (none — run again with --simulate-day to see the alert path fire)")


def _git(*args) -> str:
    """Best-effort git call from the repo dir; '' on any failure (no git, detached, etc.)."""
    try:
        r = subprocess.run(["git", *args], cwd=os.path.dirname(__file__),
                           capture_output=True, text=True, timeout=10)
        return r.stdout.strip() if r.returncode == 0 else ""
    except Exception:
        return ""


def build_version_info() -> dict:
    """Assemble the release + build stamp (CAS-124).
    version              — hand-bumped SemVer from the committed VERSION file (the only manual step).
    major/minor/patch    — parsed from version.
    build/commit/builtAt — derived automatically from git at build time; never hand-edited.
    env                  — the environment this artifact was BUILT for: CASCADE_ENV if set, else the
                           branch (main -> production, else staging). NOTE: the visible in-app badge
                           re-derives env from the hostname at RUNTIME, so the live site self-labels
                           correctly even though promote is a plain staging->main merge (no rebuild).
                           This baked value is the build-branch record for /version.json consumers."""
    version = "0.0.0"
    try:
        version = (open(VERSION_FILE, encoding="utf-8").read().strip() or version)
    except Exception:
        pass
    def _int(x):
        try:    return int(x)
        except Exception: return 0
    major, minor, patch = ([_int(p) for p in version.split(".")] + [0, 0, 0])[:3]
    branch = _git("rev-parse", "--abbrev-ref", "HEAD")
    env    = os.environ.get("CASCADE_ENV") or ("production" if branch == "main" else "staging")
    return {
        "version": version, "major": major, "minor": minor, "patch": patch,
        "build":   _int(_git("rev-list", "--count", "HEAD")),
        "commit":  _git("rev-parse", "--short", "HEAD") or "unknown",
        "builtAt": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "env":     env,
    }


def build_html(records: list[dict] | None = None):
    """Inject the latest movies + date into app_template.html -> index.html.
    Keeps the app a single double-clickable file (no server, no CORS).
    Also stamps the release/build version (CAS-124) into the app and /version.json."""
    if records is None:  # --build-html on its own: rebuild from the last movies.json
        records = json.load(open(OUTPUT_FILE))["movies"]
    if not os.path.exists(TEMPLATE_FILE):
        print("! app_template.html not found — cannot build index.html"); return
    info = build_version_info()
    html = open(TEMPLATE_FILE, encoding="utf-8").read()
    html = html.replace("__MOVIES_JSON__", json.dumps(records))
    html = html.replace("__TODAY__", datetime.date.today().isoformat())
    html = html.replace("__BUILD_INFO__", json.dumps(info))
    open(APP_FILE, "w", encoding="utf-8").write(html)
    # Machine-readable stamp served at /version.json (same origin as the app).
    with open(VERSION_JSON, "w", encoding="utf-8") as f:
        json.dump(info, f, separators=(",", ":")); f.write("\n")
    print(f"stamped v{info['version']} · build {info['build']} · {info['commit']} · env {info['env']}")


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
