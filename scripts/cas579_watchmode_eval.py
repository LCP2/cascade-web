#!/usr/bin/env python3
"""CAS-579: one-off Watchmode capability evaluation, run in CI.

Decides whether Watchmode can replace TMDB as Cascade's data spine. Read-only:
touches no repo file except the report it writes. Reads WATCHMODE_API_KEY from
the environment (the existing GitHub secret), sends it as a header, and never
prints it.

Cost: ~20 credits of the free tier's 2,500/month. Q5 costs zero.
"""
import csv, io, json, os, sys, urllib.error, urllib.parse, urllib.request
from datetime import date, timedelta

BASE = "https://api.watchmode.com/v1"
CSV_URL = "https://api.watchmode.com/datasets/title_id_map.csv"
KEY = os.environ.get("WATCHMODE_API_KEY")
CATALOGUE = os.environ.get("CASCADE_CATALOGUE", "movies.json")
OUT = os.environ.get("CAS579_REPORT", "watchmode_eval_report.md")

spent = 0
report = []


def say(line=""):
    print(line)
    report.append(line)


def get(path, params=None, cost=1):
    global spent
    url = BASE + path + ("?" + urllib.parse.urlencode(params) if params else "")
    req = urllib.request.Request(url, headers={
        "X-API-Key": KEY, "Accept": "application/json",
        "User-Agent": "cascade-eval/1.0 (+https://cascademovies.com)"})
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            spent += cost
            return json.load(r), None
    except urllib.error.HTTPError as e:
        spent += cost
        return None, f"HTTP {e.code}: {e.read().decode('utf-8', 'replace')[:200]}"
    except Exception as e:                                        # noqa: BLE001
        return None, f"{type(e).__name__}: {e}"


def finish(code=0):
    with open(OUT, "w", encoding="utf-8") as fh:
        fh.write("\n".join(report) + "\n")
    print(f"\nReport written to {OUT}")
    sys.exit(code)


if not KEY:
    say("**WATCHMODE_API_KEY is not set.** The workflow must pass the secret through.")
    finish(1)

say("# Watchmode evaluation for Cascade (CAS-579)")
say()
say(f"Run {date.today().isoformat()} · free Developer key · region AU")
say()

st, err = get("/status/", cost=0)
if err:
    say(f"**Could not reach the API.** {err}")
    finish(1)
say(f"Quota before: **{st.get('quotaUsed')} / {st.get('quota')}**")
say()

# Q1 -------------------------------------------------------------------------
say("## Q1 — Is AU tier 1, and enabled on this plan?")
say()
regions, err = get("/regions/")
if err:
    say(f"FAILED: {err}")
else:
    au = next((r for r in regions if r.get("country") == "AU"), None)
    if not au:
        say("**AU is not in the supported region list.**")
    else:
        say(f"- `data_tier`: **{au.get('data_tier')}** (1 = highest)")
        say(f"- `plan_enabled`: **{au.get('plan_enabled')}**")
        say()
        if au.get("data_tier") != 1:
            say("> **AU is not tier 1.** Availability quality is second-rank — that is the product.")
        if not au.get("plan_enabled"):
            say("> **AU is not enabled on this key.** The free plan covers 3 chosen "
                "countries; AU may simply not be one of them. Check before concluding anything.")
    say()
    say(f"{sum(1 for r in regions if r.get('data_tier') == 1)} of {len(regions)} regions are tier 1.")
say()

# Q2 -------------------------------------------------------------------------
say("## Q2 — AU streaming sources")
say()
sources, err = get("/sources/", {"regions": "AU"})
if err:
    say(f"FAILED: {err}")
else:
    by_type = {}
    for s in sources:
        by_type.setdefault(s.get("type", "?"), []).append(s.get("name") or "")
    say(f"**{len(sources)} sources** for AU:")
    say()
    for t in sorted(by_type):
        names = sorted(n for n in by_type[t] if n)
        say(f"- **{t}** ({len(names)}): {', '.join(names[:20])}" + (" …" if len(names) > 20 else ""))
    local = sorted({s.get("name") for s in sources if s.get("name") in (
        "Stan", "BINGE", "Foxtel Now", "Kayo Sports", "ABC iview", "SBS On Demand",
        "7plus", "9Now", "tenplay", "OzFlix", "Fetch TV", "Beamafilm", "Optus Sport")})
    say()
    say(f"AU-local services: **{len(local)}** — {', '.join(local) or 'NONE'}")
say()

# Q3 -------------------------------------------------------------------------
say("## Q3 — Does AU discovery work?")
say()
disc, err = get("/list-titles/", {"regions": "AU", "types": "movie",
                                  "sort_by": "release_date_desc", "limit": 250})
if err:
    say(f"FAILED: {err}")
    disc = {}
else:
    say(f"- AU movies `total_results`: **{disc.get('total_results'):,}**")
    say(f"- `total_pages`: {disc.get('total_pages'):,} (no 10k ceiling ⇒ no year-sharding)")
    say()
    for t in (disc.get("titles") or [])[:8]:
        say(f"  - {t.get('title')} ({t.get('year')}) · id {t.get('id')}")
say()
start = (date.today() - timedelta(days=120)).strftime("%Y%m%d")
recent, err = get("/list-titles/", {"regions": "AU", "types": "movie",
                                    "release_date_start": start,
                                    "sort_by": "release_date_desc", "limit": 250})
if not err:
    say(f"AU movies released since {start}: **{recent.get('total_results'):,}**")
say()

# Q4 -------------------------------------------------------------------------
say("## Q4 — Does `/title-release-dates` carry AU THEATRICAL dates?")
say()
say("Decisive: Cascade's In-Cinema window depends on it.")
say()
trd, err = get("/title-release-dates/", {
    "start_date": (date.today() - timedelta(days=60)).strftime("%Y%m%d"),
    "end_date": (date.today() + timedelta(days=60)).strftime("%Y%m%d"),
    "regions": "AU"})
if err and "401" in err:
    say("**401 — paid plan required.** Confirmed untestable on the free key; "
        "this is the question for Watchmode sales.")
elif err:
    say(f"FAILED (not a 401): {err}")
else:
    rows = trd if isinstance(trd, list) else []
    theat = [r for r in rows if r.get("type") == "theatrical_release"]
    au_theat = [r for r in theat if r.get("region") == "AU"]
    say(f"- rows: {len(rows)} · `theatrical_release`: **{len(theat)}** · region AU: **{len(au_theat)}**")
    say()
    if au_theat:
        say("> **AU theatrical dates exist.** In-Cinema can be sourced here.")
        for r in au_theat[:10]:
            say(f"  - {r.get('release_date')}  {r.get('title')}")
    else:
        say("> **No AU theatrical rows.** Theatrical looks US-centric; Cascade would "
            "still need TMDB for cinema dates.")
say()

# Q5 -------------------------------------------------------------------------
say("## Q5 — What share of Cascade's catalogue does Watchmode know?")
say()
say("_Public daily id-map. Zero API credits._")
say()
movies, cas_imdb = [], set()
try:
    with open(CATALOGUE, encoding="utf-8") as fh:
        cat = json.load(fh)
    movies = cat.get("movies", cat) if isinstance(cat, dict) else cat
    cas_imdb = {m.get("imdb_id") for m in movies if m.get("imdb_id")}
    say(f"Cascade: **{len(movies):,} titles**, {len(cas_imdb):,} with an IMDb id.")
except Exception as ex:                                           # noqa: BLE001
    say(f"Could not read `{CATALOGUE}`: {ex}")

if cas_imdb:
    try:
        req = urllib.request.Request(CSV_URL, headers={
            "X-API-Key": KEY,
            "User-Agent": "cascade-eval/1.0 (+https://cascademovies.com)"})
        with urllib.request.urlopen(req, timeout=900) as r:
            rows = list(csv.DictReader(io.StringIO(r.read().decode("utf-8", "replace"))))
        cols = list(rows[0].keys()) if rows else []
        imdb_col = next((c for c in cols if "imdb" in c.lower()), None)
        wm_imdb = {r[imdb_col] for r in rows if imdb_col and r.get(imdb_col)}
        say(f"Watchmode id map: **{len(rows):,} rows** · columns: {', '.join(cols)}")
        say()
        hit = cas_imdb & wm_imdb
        pct = 100 * len(hit) / len(cas_imdb)
        say(f"### Overlap: **{len(hit):,} / {len(cas_imdb):,} = {pct:.1f}%**")
        say()
        if pct >= 95:
            say("> Watchmode knows effectively all of Cascade's catalogue.")
        elif pct >= 80:
            say("> Good, with a tail Watchmode lacks. Inspect the misses before deciding.")
        else:
            say(f"> **Coverage problem.** A migration would silently drop "
                f"{len(cas_imdb) - len(hit):,} titles.")
        idx = {m.get("imdb_id"): m for m in movies}
        miss = sorted(cas_imdb - hit)[:15]
        if miss:
            say()
            say("Sample of misses:")
            for i in miss:
                m = idx.get(i, {})
                say(f"  - {m.get('title')} ({m.get('year')})  {i}")
    except Exception as ex:                                       # noqa: BLE001
        say(f"id-map download failed: {ex}")
say()

# Q6 -------------------------------------------------------------------------
say("## Q6 — Can one Watchmode record replace OMDb *and* TMDB's ranking signal?")
say()
sample = [t.get("id") for t in (disc.get("titles") or [])[:8]]
if not sample:
    say("No sample ids (Q3 failed).")
else:
    fields = ["user_rating", "critic_score", "popularity_percentile", "release_date",
              "poster", "plot_overview", "genre_names", "us_rating",
              "runtime_minutes", "trailer", "imdb_id", "tmdb_id"]
    present = dict.fromkeys(fields, 0)
    n = 0
    say("| title | user_rating | critic_score | popularity | poster |")
    say("| --- | --- | --- | --- | --- |")
    for tid in sample:
        d, e2 = get(f"/title/{tid}/details/")
        if e2 or not d:
            continue
        n += 1
        for f in fields:
            if d.get(f) not in (None, "", [], {}):
                present[f] += 1
        say(f"| {d.get('title')} | {d.get('user_rating')} | {d.get('critic_score')} "
            f"| {d.get('popularity_percentile')} | {'yes' if d.get('poster') else 'no'} |")
    say()
    if n:
        say(f"Field presence across {n} titles:")
        say()
        for f in fields:
            say(f"- `{f}`: {present[f]}/{n}")
        say()
        say("> `user_rating` + `critic_score` are the OMDb replacement. "
            "`popularity_percentile` is the TMDB `popularity` replacement (CAS-549's bar). "
            "A poster URL is returned but **Watchmode grants no licence to the image**.")
say()

say("---")
say()
say(f"**Credits spent: ~{spent}.**")
post, _ = get("/status/", cost=0)
if post:
    say(f"Quota after: {post.get('quotaUsed')} / {post.get('quota')}.")
say()
say("### Not answered here")
say()
say("- AU theatrical dates, if Q4 returned 401 — Watchmode sales.")
say("- AU classification (G/PG/M/MA15+/R18+): only `us_rating` exists, so a straight "
    "migration takes Cascade's `age_rating` to zero.")
say("- Poster rights — unsolved by every provider, this one included.")
finish(0)
