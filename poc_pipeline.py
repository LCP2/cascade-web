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

# CAS-361: widen past the theatrical scope — the newest AU-available titles (stream/rent/buy),
# no release_type restriction, so recent streaming-only / direct-to-digital films that never
# played a cinema (and so never match with_release_type=2|3 above) are ingested too.
# CAS-422: this is the one ingest pass with real headroom — scripts/catalogue_sizing.py measured
# the widened AU-watchable pool at ~90,704 total_results, versus the theatrical pass's ~1,870
# (already near-saturated per CAS-335's appraisal). Raising this cap is what grows the catalogue;
# raising MAX_TITLES would buy nothing, since the theatrical pool itself is the smaller number.
MAX_STREAMING_ONLY = int(os.getenv("MAX_STREAMING_ONLY", "4000"))   # first 200 pages @ 20/page

# --- window heuristics (this is YOUR business logic, not something an API gives you) ---
PVOD_MIN_PRICE   = 19.99          # a buy/rent at or above this, with no subscription yet, = premium early window
RENTAL_MAX_PRICE = 9.99           # a rent at or below this = standard rental window
# CAS-395: how long after its AU cinema_date a title still counts as "in cinema now" — independent of
# whether it has ALSO picked up a home (buy/rent/stream) offer. A film can be simultaneously on a screen
# and on premium/rental/streaming; the two are not exclusive. Matches app_template.html's client-side
# CINEMA_RUN_DAYS (also 90) so the pipeline's claim and the client's own confirmed-path cap never disagree,
# the mismatch CAS-314/CAS-318 had to reconcile.
CINEMA_RUN_DAYS = int(os.getenv("CINEMA_RUN_DAYS", "90"))

STATE_DIR = os.path.join(os.path.dirname(__file__), "state")
SNAPSHOT_FILE = os.path.join(STATE_DIR, "last_snapshot.json")
ALERTS_FILE   = os.path.join(STATE_DIR, "alerts.json")
WM_CACHE_FILE = os.path.join(STATE_DIR, "watchmode_ids.json")   # imdb_id -> watchmode_id (never changes)
WINDOW_DATES_FILE = os.path.join(STATE_DIR, "window_dates.json")  # tmdb_id -> {window: first_seen_date}
API_BUDGET_FILE = os.path.join(STATE_DIR, "api_budget.json")    # CAS-384: today's cross-run provider spend
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
CATALOGUE_TARGET = int(os.getenv("CATALOGUE_TARGET", "6000"))
                         # CAS-128: persistent browsable catalogue size — was pinned to MAX_TITLES (the
                         # theatrical-pass cap) so the ~300 cap was gone and the full ingested AU set held.
                         # CAS-422: decoupled from MAX_TITLES — theatrical+upcoming+streaming can now sum
                         # past 5,000 (MAX_TITLES=5000 is the theatrical pass's own cap, not the merged
                         # total), so pinning this to it silently truncated the wider streaming ingest
                         # (CAS-361) back down. 6,000 covers the ~5,700 target with headroom; still
                         # env-overridable. Availability is free (TMDB Providers), so catalogue size no
                         # longer gates the daily budget.

# CAS-127 — TMDB Watch Providers is the primary availability source (free, no quota).
# It runs once per released title per day across the WHOLE catalogue, so pace it politely
# (TMDB historically allows ~50 req/s and no daily cap). Watchmode is now on-demand only.
TMDB_PACING      = float(os.getenv("TMDB_PACING", "0.05"))   # seconds between provider calls (~20/s)
ONDEMAND_WM_CAP  = int(os.getenv("ONDEMAND_WM_CAP", str(ps.ONDEMAND_RESERVE)))  # Watchmode enrich/day ceiling
# CAS-161: these two pots are spent against ONE shared free-tier allowance (~1000 requests/day, counted per
# key per day, not per run), so what matters is their SUM. It was 900+150 = 1050, i.e. already over the cap
# before a single retry — which is how the 2026-07-24 run earned a 401 the moment a second run happened the
# same day. Now 800+100 = 900, leaving ~10% headroom for retries and for a manual staging run alongside the
# scheduled one. Both stay env-overridable.
OMDB_DAILY_BUDGET = int(os.getenv("OMDB_DAILY_BUDGET", "800"))  # OMDb ratings enrich/day (free tier ~1000/day)
# CAS-156: a rating is only back-filled when a title has none, so the FIRST number OMDb ever returned was kept
# for good. For an obscure title that first read lands while a handful of people have rated it, and it is wrong
# almost immediately (Jellyfish: 9.4 off 8 votes, since settled to ~8.8). Titles under the vote bar are exactly
# the ones whose score is still moving, so they get re-read — on their own small budget, so that back-filling
# titles with NO rating at all keeps first claim on the free tier.
IMDB_MIN_VOTES      = int(os.getenv("IMDB_MIN_VOTES", "1000"))   # keep in step with app_template.html
OMDB_REFRESH_BUDGET = int(os.getenv("OMDB_REFRESH_BUDGET", "100"))
OMDB_FREE_TIER_CAP  = int(os.getenv("OMDB_FREE_TIER_CAP", "1000"))   # what we believe the key is allowed/day

# CAS-379: cinema_release (CAS-360) was added after the persistent catalogue already existed, and
# build_live_catalogue carries every pre-existing base record forward unchanged — only NEW titles
# `ingest_tmdb*` discovers ever pass through `_tmdb_record`. So every record from before the field
# existed is permanently missing it, which is why the streaming Mission's "Cinema Release" toggle
# matched nothing. Back-fill it under its own budget; TMDB has no daily cap (unlike OMDb/Watchmode)
# but a one-shot full re-fetch of the whole catalogue is still wasteful, so this converges over a
# handful of runs instead.
CINEMA_RELEASE_BACKFILL_BUDGET = int(os.getenv("CINEMA_RELEASE_BACKFILL_BUDGET", "500"))

# CAS-322: specific Oscar categories/winners from Wikidata (free SPARQL endpoint, no API key —
# so unlike OMDb/Watchmode this needs no key to be "live", only a network path). Scope is bounded
# to titles OMDb already flagged as having Oscar activity (movie["award"] in won/nominated), and
# each title is looked up once and cached (`oscar_detail_checked`) — a converging backfill, not a
# per-run full sweep, and politely paced against a public shared endpoint.
WIKIDATA_ENDPOINT = "https://query.wikidata.org/sparql"
WIKIDATA_BACKFILL_BUDGET = int(os.getenv("WIKIDATA_BACKFILL_BUDGET", "200"))
WIKIDATA_PACING = float(os.getenv("WIKIDATA_PACING", "0.2"))


# ---------------------------------------------------------------------------
# tiny HTTP helper
# ---------------------------------------------------------------------------
def get_json(url: str, retries: int = 4, headers: dict | None = None) -> dict:
    """GET + parse JSON, with polite backoff on rate-limit / transient server errors.
    CAS-128: the full-catalogue ingest + daily provider sweep make many calls, so honour
    HTTP 429 (Retry-After when given, else exponential) and retry 5xx a few times."""
    req = urllib.request.Request(url, headers={"User-Agent": "cascade-poc/0.1", **(headers or {})})
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
# CAS-161: one bad API answer must not cost us the whole day's refresh
# ---------------------------------------------------------------------------
# enrich_omdb used to call get_json with no guard at all, so a single OMDb hiccup raised straight out of
# build_live_catalogue and killed the run: no movies.json, no index.html, no version.json committed, for a
# whole day, because one title out of ~1,950 failed. That is exactly what happened on 2026-07-24, when the
# free tier's daily cap answered 401.
#
# The rule now: enrichment is BEST-EFFORT. A title whose enrichment fails keeps the data it already has —
# which is real, just a day older — and the run carries on to derive, build and commit. Only two outcomes
# are possible beyond success:
#   · skip — this title only. Transient, could work next time.
#   · stop — every remaining call to that API this run would get the same answer, so stop asking. A daily
#     cap or a bad key is not per-title, and burning ~1,900 more requests to be told so again is pure waste.
_LIMIT_MARKERS = ("limit reached", "request limit", "too many requests", "invalid api key")


class ApiDeclined(RuntimeError):
    """An API answered, but refused to give us data (OMDb's HTTP-200 `Response:"False"` shape)."""


def _api_call(label: str, fn, *args):
    """Run one enrichment call. Returns (value, outcome) with outcome in {'ok','skip','stop'}."""
    try:
        return fn(*args), "ok"
    except urllib.error.HTTPError as e:
        body = ""
        try:
            body = (e.read() or b"").decode("utf-8", "replace")[:200].strip()
        except Exception:
            pass
        # 401/403 is the daily cap or a bad key — never a property of this one title.
        stop = e.code in (401, 403) or any(k in body.lower() for k in _LIMIT_MARKERS)
        detail = f" — {body}" if body else ""
        print(f"[warn] {label}: HTTP {e.code}{detail}"
              f"{f' — no further {label} calls this run' if stop else ' — skipping this title'}")
        return None, ("stop" if stop else "skip")
    except Exception as e:
        stop = any(k in str(e).lower() for k in _LIMIT_MARKERS)
        print(f"[warn] {label}: {type(e).__name__}: {e}"
              f"{f' — no further {label} calls this run' if stop else ' — skipping this title'}")
        return None, ("stop" if stop else "skip")


# ---------------------------------------------------------------------------
# 1. INGEST — which films are/were recently in AU cinemas
# ---------------------------------------------------------------------------
TMDB_BASE = "https://api.themoviedb.org/3"

def _tmdb_record(detail: dict) -> dict:
    """Map one TMDB detail payload to our skeleton record."""
    cinema_date, age_rating = None, None
    # CAS-360: every AU release_dates entry (all types 1-6), kept for future use — only type 3
    # (general theatrical) is acted on today, via cinema_release below.
    release_dates, cinema_release = [], False
    for entry in detail.get("release_dates", {}).get("results", []):
        if entry["iso_3166_1"] == REGION:
            for rd in entry["release_dates"]:
                rtype = rd["type"]
                release_dates.append({"region": REGION, "type": rtype, "date": rd["release_date"][:10]})
                if rtype == 3:
                    cinema_release = True
                if rtype in (2, 3):
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
        "cinema_release": cinema_release,     # CAS-360: had an AU type-3 (general theatrical) release
        "release_dates": release_dates,       # CAS-360: every AU release_dates type, stored for future use
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


def enrich_cinema_release(movie: dict) -> dict:
    """CAS-379: back-fill `cinema_release`/`release_dates` on a record built before CAS-360
    added them. One lighter release_dates-only call (not the full detail _tmdb_record uses,
    since everything else on the record is already populated)."""
    data = get_json(f"{TMDB_BASE}/movie/{movie['tmdb_id']}/release_dates?api_key={TMDB_KEY}")
    cinema_release, release_dates = False, []
    for entry in data.get("results", []):
        if entry["iso_3166_1"] == REGION:
            for rd in entry["release_dates"]:
                release_dates.append({"region": REGION, "type": rd["type"], "date": rd["release_date"][:10]})
                if rd["type"] == 3:
                    cinema_release = True
    movie["cinema_release"] = cinema_release
    movie["release_dates"] = release_dates
    return movie


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


def _discover_au_streaming(cap: int, seen: set) -> list[dict]:
    """CAS-361: the widened AU-available scope — watch_region + monetization types, no
    release_type filter, newest-first (primary_release_date.desc). Catches recent
    streaming-only/direct-to-digital titles `_discover_au_theatrical`'s type=2|3 filter
    excludes. `seen` is shared with the theatrical/upcoming passes so nothing double-lands."""
    movies, page = [], 1
    max_pages = min(500, max(1, -(-cap // 20)))              # ~20 results/page; ceil, capped at TMDB's max
    while len(movies) < cap and page <= max_pages:
        disc = get_json(
            f"{TMDB_BASE}/discover/movie?api_key={TMDB_KEY}&watch_region={REGION}"
            f"&with_watch_monetization_types=flatrate|rent|buy"
            f"&sort_by=primary_release_date.desc&page={page}"
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


def ingest_tmdb_streaming(seen: set) -> list[dict]:
    """CAS-361: the 2000 most-recently-released AU-available movies (incl. streaming-only),
    merged/deduped into the persistent catalogue alongside the theatrical + upcoming ingest."""
    return _discover_au_streaming(MAX_STREAMING_ONLY, seen)


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
    # CAS-161: OMDb signals soft failures with HTTP 200 + {"Response":"False","Error":...} — an unknown id,
    # and sometimes the daily cap. Every getter below would then return None and we would write "no rating"
    # over a perfectly good stored one. Bail BEFORE touching `movie`, so a failed enrich leaves the record
    # exactly as it was; _api_call turns the daily-cap wording into a stop and anything else into a skip.
    if str(data.get("Response", "True")).lower() == "false":
        raise ApiDeclined(data.get("Error") or "OMDb returned Response:False")
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


# CAS-322: SPARQL for one film's Academy Award record by IMDb id (P345). Film-level categories
# come off the film item's own P166 (award received) / P1411 (nominated for) statements; personal
# categories (Best Actor, Best Director, ...) come off a person's P166/P1411 statement carrying a
# P1686 ("for work") qualifier pointing back at this film. wd:Q19020 = "Academy Awards".
#
# Validated live against Oppenheimer (tt15398776) during the build: this correctly returns Best
# Picture (Won) and Best Director (Won, Christopher Nolan) — the ticket's own worked example. The
# ticket also offers a label-match fallback ("or a label contains 'Academy Award'") for
# categories Wikidata hasn't tagged with P361; tried live, it reliably timed out the query (WDQS's
# label-service labels are indexed, but a raw rdfs:label + FILTER(CONTAINS(...)) scan is not), so
# it was dropped rather than shipped as a source of flaky, slow enrichment runs. Net effect: some
# categories that exist in Wikidata but aren't P361-tagged (this ticket's own Best Actor example,
# Cillian Murphy, among them) won't surface — a coverage gap in the free source's tagging
# consistency, not a defect in this query; "Oscars first... best-effort" per the ticket's scope.
_WIKIDATA_AWARDS_SPARQL = """
SELECT ?awardLabel ?result ?personLabel WHERE {{
  ?film wdt:P345 "{imdb_id}".
  {{ ?film p:P166 ?s. ?s ps:P166 ?award. BIND("Won" AS ?result) }}
  UNION {{ ?film p:P1411 ?s. ?s ps:P1411 ?award. BIND("Nominated" AS ?result) }}
  UNION {{ ?p p:P166 ?s. ?s ps:P166 ?award; pq:P1686 ?film. BIND("Won" AS ?result).
           ?p rdfs:label ?personLabel . FILTER(LANG(?personLabel)="en") }}
  UNION {{ ?p p:P1411 ?s. ?s ps:P1411 ?award; pq:P1686 ?film. BIND("Nominated" AS ?result).
           ?p rdfs:label ?personLabel . FILTER(LANG(?personLabel)="en") }}
  ?award wdt:P361 wd:Q19020 .
  SERVICE wikibase:label {{ bd:serviceParam wikibase:language "en". }}
}}
"""


def enrich_wikidata_awards(movie: dict) -> dict:
    """CAS-322: specific Oscar categories (+ winner name for personal ones), from Wikidata by
    IMDb id — richer than OMDb's free-text award count. Only called for titles OMDb already
    flagged as having Oscar activity; cached onto the record (`oscar_detail`,
    `oscar_detail_checked`) so a title is looked up once, not on every run.

    Wikidata sometimes carries redundant statements for one category — a film both "won" and
    "nominated" for the same category (an editor kept the nomination record after the win), and an
    ensemble award like Best Picture qualified onto several different producers' items. Neither is
    a second fact worth a second card line, so results are grouped by category: the best result
    (Won beats Nominated) wins, and a person is only named when exactly one is credited for that
    result — Best Director names its one winner; Best Picture's several producers collapse to the
    plain category line, same as the ticket's own worked example shows."""
    sparql = _WIKIDATA_AWARDS_SPARQL.format(imdb_id=movie["imdb_id"])
    url = WIKIDATA_ENDPOINT + "?query=" + urllib.parse.quote(sparql) + "&format=json"
    data = get_json(url, headers={
        "Accept": "application/sparql-results+json",
        "User-Agent": "cascade-movies-poc/0.1 (https://cascademovies.com; lee@codynamics.com.au) award-enrichment",
    })
    by_category = {}
    for row in data.get("results", {}).get("bindings", []):
        category = (row.get("awardLabel") or {}).get("value")
        result = (row.get("result") or {}).get("value")
        if not category or not result:
            continue
        person = (row.get("personLabel") or {}).get("value")
        g = by_category.setdefault(category, {"results": set(), "won_by": set(), "nom_by": set()})
        g["results"].add(result)
        if person:
            (g["won_by"] if result == "Won" else g["nom_by"]).add(person)
    detail = []
    for category, g in by_category.items():
        result = "Won" if "Won" in g["results"] else "Nominated"
        persons = g["won_by"] if result == "Won" else g["nom_by"]
        entry = {"category": category, "result": result}
        if len(persons) == 1:
            entry["person"] = next(iter(persons))
        detail.append(entry)
    movie["oscar_detail"] = detail
    movie["oscar_detail_checked"] = True
    return movie


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
      else               -> in_cinema if it has opened, otherwise upcoming.
    CAS-395: a title still inside its AU theatrical run (cinema_date within CINEMA_RUN_DAYS) carries
    in_cinema ALONGSIDE whatever home window its offers resolve to — a film that has just opened often
    already has a pre-order/rent row, and the old code let that one row erase in_cinema entirely, which
    is why the shipped catalogue's In Cinema list had collapsed to a couple of titles."""
    windows = []
    if prov.get("flatrate") or prov.get("free") or prov.get("ads"):
        windows.append("included_streaming")
    elif prov.get("rent") or prov.get("buy"):
        windows.append("rental" if prov.get("rent") else "pvod")
    cd = movie.get("cinema_date")
    opened = bool(cd and cd <= today.isoformat())
    still_running = opened and cd >= (today - datetime.timedelta(days=CINEMA_RUN_DAYS)).isoformat()
    # CAS-418 (walk back CAS-395): in_cinema is EXCLUSIVE with home offers — a film with a rent/stream/
    # buy offer is never filed under the big screen (engine invariant #55). So in_cinema is only ever the
    # answer when NO home window resolved. An offer-less title is in_cinema only within CINEMA_RUN_DAYS of
    # opening (still_running); past its run, an offer-less title falls to upcoming (CAS-418 item 4) rather
    # than staying stamped in_cinema forever.
    if not windows:
        windows.append("in_cinema" if still_running else "upcoming")
    return windows


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

    # In cinema: theatrical date has passed and is still inside its AU run (CAS-395: no longer gated on
    # having zero home offers — a film can be in cinemas and on premium/rental/streaming at once).
    cd = movie.get("cinema_date")
    # CAS-418 (walk back CAS-395): in_cinema is EXCLUSIVE with home offers — only assigned in the
    # offer-less fallback below, never alongside a rent/stream/buy window.

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
# 4b. MONOTONIC GUARD (CAS-355) — the single source of truth for "how far a title
#     has travelled" toward more availability, and the gate that stops a transient
#     JustWatch AU sync gap from writing a backward status. Both poc_pipeline (below)
#     and monitor/transitions.py (which imports AVAILABILITY_TIERS/tier_rank from here)
#     use it, so "forward" means the same thing to the writer and the alert reader.
# ---------------------------------------------------------------------------
AVAILABILITY_TIERS = ["upcoming", "in_cinema", "pvod", "rental", "included_streaming"]
DOWNGRADE_CONFIRM_RUNS = 2   # consecutive runs a lower reading must repeat before it is trusted

def tier_rank(status) -> int:
    """Highest AVAILABILITY_TIERS rank held anywhere in `status` (a status list/set), or
    -1 if it holds none of the named tiers."""
    ranks = [AVAILABILITY_TIERS.index(w) for w in status if w in AVAILABILITY_TIERS]
    return max(ranks) if ranks else -1

def apply_monotonic_status(m: dict, candidate: list[str], confidence: str, today: datetime.date) -> None:
    """Commit `candidate` as m['status'] — unless it is a BACKWARD move (a lower tier than
    the status m already holds), in which case the existing status is kept and the
    regression is only committed once the SAME candidate has been read on
    DOWNGRADE_CONFIRM_RUNS consecutive runs. That is the difference between a real
    de-listing and a one-day gap in the AU provider feed (CAS-334/CAS-355): the feed can
    drop a title's rows for a day and pick it back up the next, and a single such gap must
    never write a status a user could be alerted on losing.

    CAS-418: that protection is only earned by a tier a real offer once backed. A tier
    stamped "estimated" was never confirmed by an offer in the first place (or already lost
    the one it had), so holding it back just freezes a phantom listing for longer — commit
    the offer-honest candidate immediately instead of waiting on DOWNGRADE_CONFIRM_RUNS."""
    prev = m.get("status") or []
    prev_confidence = m.get("availability_confidence")
    if not prev or tier_rank(candidate) >= tier_rank(prev) or prev_confidence == "estimated":
        m["status"] = candidate
        m["availability_confidence"] = confidence
        m.pop("pending_downgrade", None)
        return
    pending = m.get("pending_downgrade")
    if pending and pending.get("to") == candidate:
        pending["runs"] = pending.get("runs", 1) + 1
    else:
        pending = {"to": candidate, "runs": 1, "since": today.isoformat()}
    if pending["runs"] >= DOWNGRADE_CONFIRM_RUNS:
        m["status"] = candidate
        m["availability_confidence"] = confidence
        m.pop("pending_downgrade", None)
    else:
        m["pending_downgrade"] = pending   # held back — m["status"] stays at `prev`


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
        before_rank = tier_rank(before)
        for w in opened:
            # CAS-355: a newly-present window only alerts when it is FORWARD progress —
            # strictly further along AVAILABILITY_TIERS than anything the title already
            # held. Without this, a title that lost a high tier and landed on a lower one
            # (included_streaming -> rental, via a transient AU provider gap) read as
            # "gained rental" and fired a false alert; a real backward move never should.
            if before and tier_rank([w]) > before_rank:
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


def _dedupe_by_tmdb_id(movies: list[dict]) -> list[dict]:
    """CAS-383: a title must never appear twice in the catalogue. The ingest passes already
    thread a shared `seen` set so this shouldn't happen from a single run, but a corrupted
    base snapshot (e.g. a git merge of two divergent histories touching the same generated
    file) can still hand this function a list with repeats — so collapse defensively rather
    than trust the caller. When a tmdb_id repeats, keep the record with the most recent
    `last_polled` (freshest availability data); fall back to the first occurrence."""
    best: dict[int, dict] = {}
    for m in movies:
        tid = m["tmdb_id"]
        prior = best.get(tid)
        if prior is None or (m.get("last_polled") or "") > (prior.get("last_polled") or ""):
            best[tid] = m
    return list(best.values())


# ---------------------------------------------------------------------------
# CAS-384: cross-run per-day provider spend, so a second run the same UTC day sees what an
# earlier run already spent instead of getting its own full allowance. OMDb/Watchmode free
# tiers are counted per key per day, not per run (CAS-161) — this is the concrete gap CAS-161's
# own comment predicted: "how a second run happened the same day" earned the 2026-07-24 401,
# and it recurred on 2026-08-05 for exactly that reason.
# ---------------------------------------------------------------------------
def _load_daily_spend(today):
    """Anything on file from a stale date is a new day's fresh allowance."""
    if not os.path.exists(API_BUDGET_FILE):
        return {}
    try:
        data = json.load(open(API_BUDGET_FILE))
    except Exception:
        return {}
    return data if data.get("date") == today.isoformat() else {}


def _save_daily_spend(today, omdb_spent, wm_spent):
    os.makedirs(STATE_DIR, exist_ok=True)
    json.dump({"date": today.isoformat(), "omdb_spent": omdb_spent, "wm_spent": wm_spent},
               open(API_BUDGET_FILE, "w"), indent=2)


# ---------------------------------------------------------------------------
# CAS-109 — build the persistent catalogue, poll only the daily set, carry the rest
# ---------------------------------------------------------------------------
def build_live_catalogue(today, base_records, wm_cache, offsets=None, ondemand_ids=None,
                         omdb_spent_today=0, wm_spent_today=0):
    """Merge new TMDB ingest into the persistent base, then derive availability for the
    WHOLE released catalogue from TMDB Watch Providers (free, one call/title/day — CAS-127).
    Watchmode is spent only to ENRICH the on-demand set (titles a user opened/saved) with
    exact prices + deep-links, within a small bounded budget. OMDb ratings are back-filled
    for un-rated titles under a daily budget so new titles gain scores over runs.

    `omdb_spent_today` / `wm_spent_today` (CAS-384) are what an earlier run already spent
    against TODAY's free-tier allowance — this run's pots shrink by that much so the two
    stay under one real per-key-per-day cap. No file IO here — run() loads/persists spend,
    same pattern as wm_cache below.

    Deps (ingest_tmdb / ingest_tmdb_upcoming / enrich_omdb / poll_watchmode / tmdb_providers /
    derive_from_providers / derive_status) are module functions so tests can monkeypatch them.
    No file IO here — run() persists the result. Returns (catalogue_records, counts)."""
    offsets = offsets or ps.DEFAULT_OFFSETS
    base = {m["tmdb_id"]: m for m in base_records}
    seen = set(base)

    # grow the catalogue with new titles TMDB surfaces that we don't already hold
    new = []
    if len(base) < CATALOGUE_TARGET:
        new = ingest_tmdb(seen) + ingest_tmdb_upcoming(seen) + ingest_tmdb_streaming(seen)
    catalogue = list(base.values()) + [m for m in new if m["tmdb_id"] not in base]
    catalogue = _dedupe_by_tmdb_id(catalogue)
    catalogue.sort(key=lambda m: m.get("popularity") or 0, reverse=True)
    catalogue = catalogue[:CATALOGUE_TARGET]

    # Watchmode is on-demand only now: the poll-set matters just for the engaged titles.
    sched = ps.select_daily_poll_set(catalogue, today, ondemand_ids=ondemand_ids)
    ondemand_set = {m["tmdb_id"] for m in sched["ondemand"]}
    provider_calls = wm_calls = omdb_calls = cinema_calls = 0
    # CAS-384: shrink today's pots by whatever an earlier run already spent against the SAME free-tier
    # day, so two runs sharing one real cap can't each claim a full allowance.
    omdb_cap_remaining = max(0, OMDB_FREE_TIER_CAP - omdb_spent_today)
    omdb_budget  = min(OMDB_DAILY_BUDGET, omdb_cap_remaining)
    omdb_refresh = min(OMDB_REFRESH_BUDGET, max(0, omdb_cap_remaining - omdb_budget))  # CAS-156: separate pot
    wm_budget = max(0, ONDEMAND_WM_CAP - wm_spent_today)
    cinema_backfill = CINEMA_RELEASE_BACKFILL_BUDGET   # CAS-379: its own pot, same reasoning
    # CAS-161: per-API health for this run. `*_open` goes False the first time an API says something that is
    # true of the whole run (cap hit, key rejected) rather than of one title; the `*_fails` tallies are the
    # honest count of titles that kept yesterday's data, printed at the end so a degraded run is visible.
    omdb_open = wm_open = prov_open = cinema_open = wikidata_open = True
    omdb_fails = wm_fails = prov_fails = cinema_fails = wikidata_fails = 0
    wikidata_calls = 0

    def _omdb(m):
        """One guarded OMDb enrich. Returns True if the caller should count a spend."""
        nonlocal omdb_open, omdb_fails
        _, outcome = _api_call("OMDb", enrich_omdb, m)
        if outcome == "stop":
            omdb_open = False
        if outcome != "ok":
            omdb_fails += 1
        return True

    for m in catalogue:
        # CAS-379: back-fill pre-CAS-360 records regardless of poll tier — an upcoming title carried
        # forward from before the field existed is just as stuck as a released one.
        if "cinema_release" not in m and cinema_open and cinema_backfill > 0:
            _, cinema_outcome = _api_call("TMDB release_dates", enrich_cinema_release, m)
            cinema_calls += 1; cinema_backfill -= 1
            if cinema_outcome == "stop":
                cinema_open = False
            if cinema_outcome != "ok":
                cinema_fails += 1

        tier = ps.classify_tier(m, today)
        m["poll_tier"] = tier
        if tier == "none":                                   # upcoming — known from TMDB date
            m["offers"] = []
            m["status"] = ["upcoming"]
            m["availability_confidence"] = "confirmed"
            m["availability_source"] = "tmdb_date"
        else:
            # PRIMARY availability: free TMDB Watch Providers (AU), every released title, daily.
            prov, prov_outcome = (_api_call("TMDB providers", tmdb_providers, m["tmdb_id"])
                                  if prov_open else (None, "skip"))
            if prov_open:
                provider_calls += 1
            if prov_outcome == "stop":
                prov_open = False
            if prov_outcome == "ok":
                m["jw_link"] = prov.get("jw_link")           # JustWatch deep-out + attribution
                if has_provider_rows(prov):
                    m["offers"] = provider_offers(prov)
                    apply_monotonic_status(m, derive_from_providers(m, prov, today), "confirmed", today)
                else:
                    # CAS-412: JustWatch has no AU row at all, so there is no real offer to back a home
                    # window (pvod/rental/included_streaming). estimate_status's age ladder used to be
                    # used here, but it can invent a paid tier (e.g. "pvod", once a title outlives the
                    # in-cinema estimate cap) with zero offers behind it and no route back to in_cinema,
                    # since the ladder never re-computes a lower answer as the same title ages further.
                    # derive_from_providers' own cinema-date-only fallback (empty `prov` in every window
                    # check) is offer-honest: in_cinema while the title is still opened, upcoming before.
                    m["offers"] = []
                    apply_monotonic_status(m, derive_from_providers(m, prov, today), "estimated", today)
                m["last_polled"] = today.isoformat()
                m["availability_source"] = "tmdb_providers"
            else:
                # CAS-161: the call failed, so we know nothing new. Yesterday's confirmed window is worth far
                # more than an estimate invented from a failed read, so keep it — and deliberately do NOT
                # stamp last_polled, because the app's confirmed/estimated badge must never claim a read that
                # did not happen. A title we have never successfully polled has nothing to keep, so it falls
                # back to the honest date-based estimate rather than being left window-less.
                prov_fails += 1
                if not m.get("status"):
                    w, conf = ps.estimate_status(m, today, offsets)
                    m["offers"] = []
                    m["status"] = [w]
                    m["availability_confidence"] = conf
                    m["availability_source"] = "estimated_unpolled"
                elif m.get("availability_confidence") == "estimated":
                    # CAS-418: the held tier was already offer-less, so a failed poll must not
                    # freeze it either — fall back to the same offer-honest, date-based window
                    # the "no AU rows" branch above uses, not the age ladder (CAS-412), which
                    # can reinvent a paid tier with nothing backing it.
                    apply_monotonic_status(m, derive_from_providers(m, {}, today), "estimated", today)
                    m["offers"] = []
                    m["availability_source"] = "estimated_unpolled"

            # ON-DEMAND Watchmode enrichment: exact prices + deep-links for engaged titles only.
            if m["tmdb_id"] in ondemand_set and wm_budget > 0 and m.get("imdb_id") and wm_open:
                wm_offers, wm_outcome = _api_call("Watchmode", poll_watchmode, m, wm_cache)
                wm_calls += 1; wm_budget -= 1
                if wm_outcome == "stop":
                    wm_open = False
                if wm_outcome != "ok":
                    # Keep the TMDB-provider answer already set above: less precise (no real prices), but
                    # true. Watchmode only ever SHARPENS availability, so losing it is a downgrade, not a gap.
                    wm_fails += 1
                elif wm_offers:                              # richer than providers: real prices/formats
                    m["offers"] = wm_offers
                    apply_monotonic_status(m, derive_status(m, wm_offers, today), "confirmed", today)
                    m["availability_source"] = "watchmode_enriched"
                time.sleep(TMDB_PACING)
            if TMDB_PACING:
                time.sleep(TMDB_PACING)                      # polite pacing between provider calls

        st = set(m.get("status", []))
        if "included_streaming" in st and not (st & ps.ACTIVE_WINDOW):
            m.setdefault("settled_since", today.isoformat())
        else:
            m.pop("settled_since", None)

    # CAS-384: OMDb back-fill for un-rated titles, bounded to stay under the free tier — plus a bounded
    # re-read of the thinly-voted (CAS-156), whose stored score is a first impression rather than a
    # settled one. This used to run inline while walking `catalogue` in popularity order, so a handful
    # of popular-but-slow-tier titles could exhaust the budget before every active title got scored, and
    # a title skipped one run had no better odds of being reached the next. Ordering the candidates by
    # (active tier first, then oldest last_polled) instead means coverage advances around the whole pool
    # every run rather than stalling wherever popularity order happened to run out of budget.
    omdb_candidates = [m for m in catalogue
                       if m.get("poll_tier") != "none" and m.get("imdb_id")
                       and (not m.get("imdb_rating") or (m.get("imdb_votes") or 0) < IMDB_MIN_VOTES)]
    omdb_candidates.sort(key=lambda m: (0 if m.get("poll_tier") == "active" else 1,
                                        m.get("last_polled") or ""))
    for m in omdb_candidates:
        if not omdb_open:
            break
        if not m.get("imdb_rating"):
            if omdb_budget > 0:
                _omdb(m); omdb_calls += 1; omdb_budget -= 1
        elif (m.get("imdb_votes") or 0) < IMDB_MIN_VOTES and omdb_refresh > 0:
            _omdb(m); omdb_calls += 1; omdb_refresh -= 1

    # CAS-322: Wikidata Oscar-detail backfill. Scope is a title OMDb already flagged as having Oscar
    # activity (`award` in won/nominated) and not yet looked up — bounded, converging over runs, not
    # the whole catalogue. No API key needed (Wikidata's SPARQL endpoint is free/public), so this pot
    # is spent whenever there are candidates, independent of the TMDB/OMDb/Watchmode LIVE keys.
    wikidata_backfill = WIKIDATA_BACKFILL_BUDGET
    wikidata_candidates = [m for m in catalogue
                           if m.get("award") in ("won", "nominated") and m.get("imdb_id")
                           and not m.get("oscar_detail_checked")]
    for m in wikidata_candidates:
        if not wikidata_open or wikidata_backfill <= 0:
            break
        _, outcome = _api_call("Wikidata", enrich_wikidata_awards, m)
        wikidata_calls += 1; wikidata_backfill -= 1
        if outcome == "stop":
            wikidata_open = False
        if outcome != "ok":
            wikidata_fails += 1
        if WIKIDATA_PACING:
            time.sleep(WIKIDATA_PACING)

    counts = dict(sched["counts"])
    counts.update(provider_calls=provider_calls, wm_calls=wm_calls, omdb_calls=omdb_calls,
                  cinema_calls=cinema_calls, wikidata_calls=wikidata_calls,
                  ondemand=len(ondemand_set), catalogue=len(catalogue),
                  # CAS-161: a degraded run must SAY it was degraded. Silence here would let the catalogue
                  # quietly go stale for days while every run still reported success.
                  omdb_fails=omdb_fails, wm_fails=wm_fails, provider_fails=prov_fails, cinema_fails=cinema_fails,
                  wikidata_fails=wikidata_fails,
                  omdb_stopped=not omdb_open, wm_stopped=not wm_open, providers_stopped=not prov_open,
                  cinema_stopped=not cinema_open, wikidata_stopped=not wikidata_open)
    if omdb_fails or wm_fails or prov_fails or cinema_fails or wikidata_fails:
        print(f"[warn] degraded enrichment: {prov_fails} TMDB-provider, {omdb_fails} OMDb, {wm_fails} "
              f"Watchmode, {cinema_fails} TMDB-release_dates, {wikidata_fails} Wikidata title(s) kept "
              f"their previous data"
              + (" — OMDb stopped early" if not omdb_open else "")
              + (" — Watchmode stopped early" if not wm_open else "")
              + (" — TMDB providers stopped early" if not prov_open else "")
              + (" — TMDB release_dates stopped early" if not cinema_open else "")
              + (" — Wikidata stopped early" if not wikidata_open else ""))
    if OMDB_DAILY_BUDGET + OMDB_REFRESH_BUDGET > OMDB_FREE_TIER_CAP:
        print(f"[warn] OMDb budgets total {OMDB_DAILY_BUDGET + OMDB_REFRESH_BUDGET} against a "
              f"{OMDB_FREE_TIER_CAP}/day cap — a single run can exhaust the key.")
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
        prior_spend = _load_daily_spend(today)   # CAS-384: what an earlier run today already spent
        records, counts = build_live_catalogue(today, base_records, wm_cache,
                                               offsets=offsets, ondemand_ids=ondemand_ids,
                                               omdb_spent_today=prior_spend.get("omdb_spent", 0),
                                               wm_spent_today=prior_spend.get("wm_spent", 0))
        print(f"[live] catalogue {len(records)} | TMDB provider calls {counts['provider_calls']} (free, no quota) "
              f"| Watchmode on-demand {counts['wm_calls']}/{ONDEMAND_WM_CAP} | OMDb backfill {counts['omdb_calls']} "
              f"| cinema_release backfill {counts['cinema_calls']}/{CINEMA_RELEASE_BACKFILL_BUDGET} "
              f"| Wikidata Oscar backfill {counts['wikidata_calls']}/{WIKIDATA_BACKFILL_BUDGET}")
        os.makedirs(STATE_DIR, exist_ok=True)
        json.dump(wm_cache, open(WM_CACHE_FILE, "w"), indent=2)
        _save_daily_spend(today, prior_spend.get("omdb_spent", 0) + counts["omdb_calls"],
                                  prior_spend.get("wm_spent", 0) + counts["wm_calls"])
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

    No "env" field here (CAS-324): version.json is mirrored byte-for-byte from staging to main by
    promote.yml's pure merge, so a value baked in at build time (necessarily on staging) would still
    read "staging" once mirrored to prod — there is no build-time value that is correct in both places.
    env is instead resolved at RUNTIME from the hostname, by whoever is reading the stamp (see
    RUNTIME_ENV in app_template.html for the in-app badge)."""
    version = "0.0.0"
    try:
        version = (open(VERSION_FILE, encoding="utf-8").read().strip() or version)
    except Exception:
        pass
    def _int(x):
        try:    return int(x)
        except Exception: return 0
    major, minor, patch = ([_int(p) for p in version.split(".")] + [0, 0, 0])[:3]
    return {
        "version": version, "major": major, "minor": minor, "patch": patch,
        "build":   _int(_git("rev-list", "--count", "HEAD")),
        "commit":  _git("rev-parse", "--short", "HEAD") or "unknown",
        "builtAt": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
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
    print(f"stamped v{info['version']} · build {info['build']} · {info['commit']}")


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
