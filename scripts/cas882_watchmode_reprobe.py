#!/usr/bin/env python3
"""CAS-882: re-probe Watchmode per Brian Einhaus's 8 Sep corrections to the CAS-579/767 evals.

Read-only, same request seam (`get`) as scripts/cas579_watchmode_eval.py and
scripts/cas767_watchmode_trial_eval.py. Runs three probes and writes a Markdown report,
committing nothing:
  A. AU classification on the two titles Brian named - full request URL (API key REDACTED)
     and the raw JSON response, then whether `content_ratings.AU` is present.
  B. `relevance_percentile` vs `popularity_percentile` distribution over a 100-title sample
     drawn from the catalogue.
  C. The two changes endpoints Brian named (`titles_details_changed`, `titles_sources_changed`),
     page 1 only.

Deliberately does not change how the pipeline reads any field - this establishes what the API
actually returns. CAS882_MAX_CREDITS (default well under the ticket's 250-credit cap) guards
spend on Probe B's per-title calls; once reached, remaining fetches are skipped and the report
says so. Never prints the real WATCHMODE_API_KEY - only the literal text REDACTED stands in
for it, and it never appears anywhere else in the report.
"""
import csv, io, json, os, random, statistics, sys, urllib.error, urllib.parse, urllib.request
from datetime import date

BASE = "https://api.watchmode.com/v1"
CSV_URL = "https://api.watchmode.com/datasets/title_id_map.csv"
KEY = os.environ.get("WATCHMODE_API_KEY")
CATALOGUE = os.environ.get("CASCADE_CATALOGUE", "movies.json")
OUT = os.environ.get("CAS882_REPORT", "watchmode_reprobe_report.md")
_raw_max_credits = os.environ.get("CAS882_MAX_CREDITS", "").strip()
MAX_CREDITS = int(_raw_max_credits) if _raw_max_credits else 120  # ticket's hard cap is 250

# Probe A - the two titles Brian named by Watchmode id, with the AU rating he says each carries.
PROBE_A_TITLES = [
    ("1596439", "A Complete Unknown", "M"),
    ("1529898", "The Brutalist", "MA 15+"),
]
PROBE_B_SAMPLE_SIZE = 100
PROBE_C_ENDPOINTS = [
    ("/changes/titles_details_changed/", {"limit": 250, "page": 1}),
    ("/changes/titles_sources_changed/", {"limit": 250, "page": 1, "regions": "AU"}),
]

spent = 0
report = []


def say(line=""):
    print(line)
    report.append(line)


def capped():
    return spent >= MAX_CREDITS


def request_url(path, params=None):
    """The URL as urllib actually sends it - never carries the key (sent via header)."""
    return BASE + path + ("?" + urllib.parse.urlencode(params) if params else "")


def redacted_url(path, params=None):
    """Display-only: the URL plus Watchmode's documented `apiKey` query param, redacted - the
    form Brian will recognise, even though the real request authenticates via an X-API-Key
    header instead. Never carries the real key."""
    shown = dict(params or {})
    shown["apiKey"] = "REDACTED"
    return BASE + path + "?" + urllib.parse.urlencode(shown)


def get(path, params=None, cost=1):
    """JSON GET against BASE -> (data, http_status, err). Tests monkeypatch this name
    directly - no live call runs in a test."""
    global spent
    url = request_url(path, params)
    req = urllib.request.Request(url, headers={
        "X-API-Key": KEY, "Accept": "application/json",
        "User-Agent": "cascade-eval/1.0 (+https://cascademovies.com)"})
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            spent += cost
            return json.load(r), r.status, None
    except urllib.error.HTTPError as e:
        spent += cost
        body = e.read().decode("utf-8", "replace")
        try:
            parsed = json.loads(body)
        except ValueError:
            parsed = None
        return parsed, e.code, f"HTTP {e.code}: {body[:200]}"
    except Exception as e:                                        # noqa: BLE001
        return None, None, f"{type(e).__name__}: {e}"


def get_csv(url):
    """Free daily id-map dataset -> ({watchmode_id: imdb_id}, err). Zero API credits."""
    req = urllib.request.Request(url, headers={
        "X-API-Key": KEY, "User-Agent": "cascade-eval/1.0 (+https://cascademovies.com)"})
    try:
        with urllib.request.urlopen(req, timeout=900) as r:
            rows = list(csv.DictReader(io.StringIO(r.read().decode("utf-8", "replace"))))
    except Exception as e:                                        # noqa: BLE001
        return None, f"{type(e).__name__}: {e}"
    if not rows:
        return {}, None
    cols = list(rows[0].keys())
    id_col = next((c for c in cols if c.lower() in ("id", "watchmode_id")), cols[0])
    imdb_col = next((c for c in cols if "imdb" in c.lower()), None)
    if not imdb_col:
        return {}, None
    return {r[id_col]: r[imdb_col] for r in rows if r.get(id_col) and r.get(imdb_col)}, None


def load_catalogue():
    with open(CATALOGUE, encoding="utf-8") as fh:
        cat = json.load(fh)
    return cat.get("movies", cat) if isinstance(cat, dict) else cat


def finish(code=0):
    with open(OUT, "w", encoding="utf-8") as fh:
        fh.write("\n".join(report) + "\n")
    print(f"\nReport written to {OUT}")
    sys.exit(code)


def probe_a():
    say("## Probe A - AU classification (`content_ratings.AU`)")
    say()
    say("Brian named two titles directly, each with the AU rating he says Watchmode carries. "
        "CAS-767's census reported `content_ratings.AU` absent on all 242 sampled titles - "
        "this checks his two examples byte-for-byte.")
    say()
    for wm_id, title, expected in PROBE_A_TITLES:
        say(f"### {title} (`{wm_id}`) - Brian says `{expected}`")
        say()
        say(f"Request URL: `{redacted_url(f'/title/{wm_id}/details/')}`")
        say()
        data, status, err = get(f"/title/{wm_id}/details/")
        say(f"HTTP status: **{status if status is not None else 'no response'}**.")
        say()
        if data is None:
            say(f"FAILED: {err or 'no JSON body returned'}")
            say()
            continue
        say("Raw response:")
        say()
        say("```json")
        say(json.dumps(data, indent=2, ensure_ascii=False))
        say("```")
        say()
        ratings = data.get("content_ratings") if isinstance(data, dict) else None
        if not isinstance(ratings, dict):
            say("`content_ratings` key: **absent**.")
        else:
            say(f"`content_ratings` key: **present** - `{json.dumps(ratings)}`.")
            au = ratings.get("AU")
            say(f"`content_ratings.AU` lookup: **{au if au is not None else 'absent'}**.")
        say()


def probe_b(movies, imdb_to_wm):
    say("## Probe B - `relevance_percentile` vs `popularity_percentile`")
    say()
    pool = [m for m in movies if m.get("imdb_id") and imdb_to_wm.get(m["imdb_id"])]
    random.Random(882).shuffle(pool)  # fixed seed: reproducible sample run to run
    sample = pool[:PROBE_B_SAMPLE_SIZE]
    say(f"Sample: **{len(sample)}** / {PROBE_B_SAMPLE_SIZE} requested catalogue titles "
        "resolving through the id map.")
    say()

    relevance, popularity = [], []
    fetched = 0
    stopped_early = False
    for m in sample:
        if capped():
            stopped_early = True
            break
        wm_id = imdb_to_wm[m["imdb_id"]]
        data, status, err = get(f"/title/{wm_id}/details/")
        if err or not isinstance(data, dict):
            continue
        fetched += 1
        if data.get("relevance_percentile") is not None:
            relevance.append(data["relevance_percentile"])
        if data.get("popularity_percentile") is not None:
            popularity.append(data["popularity_percentile"])

    if stopped_early:
        say(f"_Credit cap ({MAX_CREDITS}) reached after {fetched} titles fetched - the "
            "statistics below run on this partial sample._")
        say()

    say(f"Titles with details fetched: **{fetched}**.")
    say()

    def stats(name, values):
        if not values:
            say(f"- `{name}`: present on **0 / {fetched}** - not carried in this sample.")
            return
        say(f"- `{name}`: present on **{len(values)} / {fetched}** · "
            f"min **{min(values)}** · max **{max(values)}** · "
            f"median **{statistics.median(values)}** · "
            f"distinct values **{len(set(values))}**.")

    stats("relevance_percentile", relevance)
    stats("popularity_percentile", popularity)
    say()


def probe_c():
    say("## Probe C - changes endpoints")
    say()
    say("Brian's correction: the documented calls are `GET /v1/changes/titles_details_changed/` "
        "and `GET /v1/changes/titles_sources_changed/` (the latter with `regions=AU`), not the "
        "`/changes/` path CAS-767 got a 400 from. Page 1 only.")
    say()
    for path, params in PROBE_C_ENDPOINTS:
        say(f"### `{path}`")
        say()
        data, status, err = get(path, params)
        say(f"HTTP status: **{status if status is not None else 'no response'}**.")
        say()
        if status != 200:
            say(f"FAILED: {err or 'non-200 status'}")
            say()
            continue
        if not isinstance(data, dict):
            say("_Unexpected response shape - not a JSON object._")
            say()
            continue
        say(f"Top-level keys: `{', '.join(sorted(data.keys()))}`.")
        say(f"`total_pages`: **{data.get('total_pages', 'absent')}**.")
        say()
        rows = None
        for key in ("changes", "titles", "results", "items"):
            if isinstance(data.get(key), list):
                rows = data[key]
                break
        if rows is None:
            rows = next((v for v in data.values() if isinstance(v, list)), [])
        if rows:
            say("Shape of one row:")
            say()
            say("```json")
            say(json.dumps(rows[0], indent=2, ensure_ascii=False))
            say("```")
        else:
            say("_No rows returned to show a shape for._")
        say()


def main():
    if not KEY:
        sys.stderr.write("WATCHMODE_API_KEY is not set - it must be in the environment "
                          "before this can run.\n")
        sys.exit(1)

    say("# Watchmode re-probe for Cascade (CAS-882)")
    say()
    say(f"Run {date.today().isoformat()} · answering Brian Einhaus's 8 Sep corrections · "
        f"credit cap {MAX_CREDITS}")
    say()

    probe_a()

    movies = load_catalogue()
    id_map, id_map_err = get_csv(CSV_URL)
    id_map = id_map or {}
    if id_map_err:
        say(f"_Id-map download failed ({id_map_err}) - Probe B sample resolution may "
            "under-report._")
        say()
    imdb_to_wm = {v: k for k, v in id_map.items()}
    probe_b(movies, imdb_to_wm)

    probe_c()

    say("---")
    say()
    say(f"**Credits spent: ~{spent}.**")
    finish(0)


if __name__ == "__main__":
    main()
