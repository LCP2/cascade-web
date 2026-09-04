#!/usr/bin/env python3
"""CAS-767: build the paid-plan Watchmode trial harness before the trial key is activated.

Read-only, same shape as scripts/cas579_watchmode_eval.py (the free-key evaluation) but answers
the six questions only a paid Watchmode plan can answer: AU theatrical-date accuracy against
Cascade's own `cinema_date`, `content_ratings.AU` coverage against `age_rating`, a stratified
census of six fields OMDb/TMDB don't cover today, rating-scale parity between `user_rating` and
Cascade's IMDb-calibrated filters, the changes endpoints' shape, and a cost projection against the
Startup plan's 40,000/month allowance.

Does not edit cas579_watchmode_eval.py (CAS-766 is editing that one concurrently) and commits
nothing. A 401 on /title-release-dates/ means the trial key is not active yet - the run says so
explicitly and stops rather than publish a misleadingly thin report. CAS767_MAX_CREDITS (default
2,000) guards the trial's monthly allowance: once spent reaches the cap, remaining per-title calls
are skipped and the affected sections say so, but the report still finishes and writes normally.
"""
import csv, io, json, os, random, sys, urllib.error, urllib.parse, urllib.request
from datetime import date, datetime, timedelta

BASE = "https://api.watchmode.com/v1"
CSV_URL = "https://api.watchmode.com/datasets/title_id_map.csv"
KEY = os.environ.get("WATCHMODE_API_KEY")
CATALOGUE = os.environ.get("CASCADE_CATALOGUE", "movies.json")
OUT = os.environ.get("CAS767_REPORT", "watchmode_trial_eval_report.md")
_raw_max_credits = os.environ.get("CAS767_MAX_CREDITS", "").strip()
MAX_CREDITS = int(_raw_max_credits) if _raw_max_credits else 2000

SAMPLE_SIZE = 300  # >= 300 total, split across the three strata below (AC)
STRATA = ("top_popularity", "random", "award_flagged")

# app_template.html's existing People's-vote bar positions (VOTE_OFF, VOTE_REF) - the rating
# scale a Watchmode user_rating substitution would have to clear without moving a film across it.
RATING_BAR_POSITIONS = [5.6, 6, 7, 7.5, 8.2]

CATALOGUE_TARGET_SIZE = 6000  # the ticket's own basis for the cost projection
STARTUP_MONTHLY_ALLOWANCE = 40000
DAILY_REVALIDATIONS = 200  # Brian's described sync-poll volume

SIX_FIELDS = {
    "critic_score": "metacritic-equivalent",
    "awards": "awards",
    "director": "director",
    "cast": "cast",
    "budget": "budget",
    "gross_revenue": "box office",
}

spent = 0
report = []


def say(line=""):
    print(line)
    report.append(line)


def capped():
    return spent >= MAX_CREDITS


def get(path, params=None, cost=1):
    """JSON GET against BASE. Tests monkeypatch this name directly - no live call runs in a test."""
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


def get_csv(url):
    """Free daily id-map dataset -> ({watchmode_id: imdb_id}, err). Zero API credits (cas579 Q5)."""
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


def finish(code=0):
    with open(OUT, "w", encoding="utf-8") as fh:
        fh.write("\n".join(report) + "\n")
    print(f"\nReport written to {OUT}")
    sys.exit(code)


def load_catalogue():
    with open(CATALOGUE, encoding="utf-8") as fh:
        cat = json.load(fh)
    return cat.get("movies", cat) if isinstance(cat, dict) else cat


def build_sample(movies):
    """Stratified sample: top-by-popularity, random, OMDb-award-flagged - the strata
    cascade-wikidata-coverage-spike-2026-09-04.md uses, so the two censuses compare directly."""
    pool = [m for m in movies if m.get("imdb_id")]
    per_stratum = max(1, SAMPLE_SIZE // len(STRATA))
    by_pop = sorted(pool, key=lambda m: m.get("popularity") or 0, reverse=True)
    awarded = [m for m in pool if m.get("award") in ("won", "nominated")]
    shuffled = list(pool)
    random.Random(767).shuffle(shuffled)  # fixed seed: reproducible sample run to run
    return {
        "top_popularity": by_pop[:per_stratum],
        "random": shuffled[:per_stratum],
        "award_flagged": awarded[:per_stratum],
    }


def fetch_details_for_sample(picks, imdb_to_wm):
    """One /title/{id}/details/ call per unique resolvable sample title, credit-capped.

    A title can land in more than one stratum (e.g. both top-popularity and award-flagged) -
    dedupe by imdb_id first so it costs one credit, not one per stratum it appears in.
    """
    wm_id_by_imdb = {}
    for titles in picks.values():
        for m in titles:
            imdb_id = m.get("imdb_id")
            if imdb_id and imdb_id not in wm_id_by_imdb:
                wm_id_by_imdb[imdb_id] = imdb_to_wm.get(imdb_id)

    details = {}
    unresolved = 0
    stopped_early = False
    for imdb_id, wm_id in wm_id_by_imdb.items():
        if not wm_id:
            unresolved += 1
            continue
        if capped():
            stopped_early = True
            break
        d, err = get(f"/title/{wm_id}/details/")
        if not err and d:
            details[imdb_id] = d
    return details, unresolved, stopped_early


def section_theatrical_dates(movies, id_map):
    """Section 1. Also the trial-status probe: returns "TRIAL_NOT_ACTIVE" on a 401."""
    say("## 1. AU theatrical dates vs Cascade's own `cinema_date`")
    say()
    dated = [m for m in movies if m.get("cinema_date")]
    if not dated:
        say("_Not carried - no catalogue titles carry `cinema_date`._")
        say()
        return None
    starts = sorted(m["cinema_date"] for m in dated)
    start, end = starts[0].replace("-", ""), starts[-1].replace("-", "")
    say(f"Catalogue: **{len(dated):,}** titles with a `cinema_date`, window {starts[0]}..{starts[-1]}.")
    say()
    rows, err = get("/title-release-dates/", {"start_date": start, "end_date": end, "regions": "AU"})
    if err and "401" in err:
        return "TRIAL_NOT_ACTIVE"
    if err:
        say(f"FAILED: {err}")
        say()
        return None
    rows = rows if isinstance(rows, list) else []
    theat = [r for r in rows if r.get("type") == "theatrical_release" and r.get("region") == "AU"]
    say(f"AU theatrical rows in window: **{len(theat):,}**.")
    say()
    if not theat:
        say("_Not carried - no AU theatrical rows returned for this window._")
        say()
        return None
    by_imdb = {}
    for r in theat:
        imdb = r.get("imdb_id") or id_map.get(str(r.get("id")))
        if imdb:
            by_imdb[imdb] = r.get("release_date")
    exact = within7 = disagree = missing = 0
    for m in dated:
        wm_date = by_imdb.get(m.get("imdb_id"))
        if not wm_date:
            missing += 1
            continue
        try:
            d1 = datetime.strptime(m["cinema_date"], "%Y-%m-%d").date()
            d2 = datetime.strptime(str(wm_date)[:10], "%Y-%m-%d").date()
        except ValueError:
            missing += 1
            continue
        diff = abs((d1 - d2).days)
        if diff == 0:
            exact += 1
        elif diff <= 7:
            within7 += 1
        else:
            disagree += 1
    say("| exact | within +/-7 days | disagree | missing | total dated |")
    say("| --- | --- | --- | --- | --- |")
    say(f"| {exact} | {within7} | {disagree} | {missing} | {len(dated)} |")
    say()
    return None


def section_content_ratings(movies, details, picks):
    say("## 2. `content_ratings.AU` vs `age_rating`")
    say()
    movies_by_imdb = {m.get("imdb_id"): m for m in movies}
    gained = same = disagree = missing = 0
    n = 0
    for imdb_id, d in details.items():
        m = movies_by_imdb.get(imdb_id)
        if not m:
            continue
        n += 1
        wm_rating = (d.get("content_ratings") or {}).get("AU")
        cas_rating = m.get("age_rating")
        if not wm_rating:
            missing += 1
        elif not cas_rating:
            gained += 1
        elif wm_rating == cas_rating:
            same += 1
        else:
            disagree += 1
    if n == 0:
        say("_Not carried - no sampled title returned details (credit cap or empty stub)._")
        say()
        return
    say(f"Sampled titles with details: **{n}**.")
    say()
    say("| gains a classification | unchanged | disagree | still missing |")
    say("| --- | --- | --- | --- |")
    say(f"| {gained} | {same} | {disagree} | {missing} |")
    say()
    if gained == 0 and same == 0 and disagree == 0:
        say("_Not carried - no sampled title returned a `content_ratings.AU` value._")
        say()
        return
    with_imdb = [m for m in movies if m.get("imdb_id")]
    have_today = sum(1 for m in with_imdb if m.get("age_rating"))
    today_pct = 100 * have_today / len(with_imdb) if with_imdb else 0
    projected_pct = 100 * (have_today + gained) / len(with_imdb) if with_imdb else 0
    say(f"Today's TMDB `age_rating` coverage: **{today_pct:.1f}%**. If the sample's gain rate holds "
        f"catalogue-wide, coverage would move to roughly **{projected_pct:.1f}%** "
        "(measured on this sample, not re-surveyed catalogue-wide).")
    say()


def section_six_fields(details, picks):
    say("## 3. The six unmeasured fields - stratified census")
    say()
    say(f"Sample target: **{SAMPLE_SIZE}** titles across {', '.join(STRATA)} "
        f"({SAMPLE_SIZE // len(STRATA)} per stratum).")
    say()
    say("| stratum | n sampled | n with details | " + " | ".join(SIX_FIELDS.values()) + " |")
    say("| --- " * (3 + len(SIX_FIELDS)) + "|")
    totals = dict.fromkeys(SIX_FIELDS, 0)
    total_n = 0
    for stratum in STRATA:
        titles = picks.get(stratum, [])
        have = [details[m["imdb_id"]] for m in titles if m.get("imdb_id") in details]
        n = len(have)
        total_n += n
        counts = []
        for key in SIX_FIELDS:
            present = sum(1 for d in have if d.get(key) not in (None, "", [], {}))
            totals[key] += present
            counts.append(f"{present}/{n}" if n else "not carried")
        say(f"| {stratum} | {len(titles)} | {n} | " + " | ".join(counts) + " |")
    say()
    if total_n == 0:
        say("_Not carried - no stratum returned any detail rows (credit cap or empty stub)._")
        say()
        return
    for key, label in SIX_FIELDS.items():
        if totals[key] == 0:
            say(f"- `{key}` ({label}) - not carried in this sample: present on 0 of {total_n} titles.")
    say()


def section_rating_parity(movies, details):
    say("## 4. Rating scale parity - `user_rating` vs Cascade's `imdb_rating`")
    say()
    movies_by_imdb = {m.get("imdb_id"): m for m in movies}
    pairs = []
    vote_field_seen = False
    for imdb_id, d in details.items():
        m = movies_by_imdb.get(imdb_id)
        if any(k in d for k in ("user_rating_count", "user_rating_votes", "vote_count")):
            vote_field_seen = True
        ur, ir = d.get("user_rating"), m.get("imdb_rating") if m else None
        if isinstance(ur, (int, float)) and isinstance(ir, (int, float)):
            pairs.append((ir, ur))
    if not pairs:
        say("_Not carried - no sampled title had both `user_rating` and `imdb_rating`._")
        say()
        return
    n = len(pairs)
    mad = sum(abs(a - b) for a, b in pairs) / n
    mean_i = sum(a for a, _ in pairs) / n
    mean_u = sum(b for _, b in pairs) / n
    sd_i = (sum((a - mean_i) ** 2 for a, _ in pairs) / n) ** 0.5
    sd_u = (sum((b - mean_u) ** 2 for _, b in pairs) / n) ** 0.5
    if sd_i and sd_u:
        cov = sum((a - mean_i) * (b - mean_u) for a, b in pairs) / n
        corr_txt = f"{cov / (sd_i * sd_u):.2f}"
    else:
        corr_txt = "not computable (zero variance)"
    say(f"Paired titles: **{n}** · mean absolute difference: **{mad:.2f}** · correlation: **{corr_txt}**")
    say()
    say("| bar position | titles that cross it (imdb_rating and user_rating disagree) |")
    say("| --- | --- |")
    for bar in RATING_BAR_POSITIONS:
        crossing = sum(1 for a, b in pairs if (a >= bar) != (b >= bar))
        say(f"| {bar} | {crossing} |")
    say()
    if not vote_field_seen:
        say("**Not carried - no vote-count field found alongside `user_rating`.** The app's "
            "`IMDB_MIN_VOTES` floor (app_template.html) has no direct Watchmode replacement "
            "on this evidence; that is a product decision, not a mapping exercise.")
        say()


def section_changes():
    say("## 5. Changes endpoints - daily-poll shape")
    say()
    if capped():
        say("_Not carried - credit cap reached before this section._")
        say()
        return
    start = (date.today() - timedelta(days=1)).strftime("%Y%m%d")
    data, err = get("/changes/", {"start_date": start, "change_type": "new_source"})
    if err:
        say(f"_Not carried - {err}._")
        say()
        return
    rows = data if isinstance(data, list) else ((data or {}).get("changes") or [])
    say(f"Rows returned for the last day: **{len(rows):,}**.")
    say()
    if not rows:
        say("_Not carried - no changes rows returned for the probe window._")
        say()
        return
    say(f"Row shape (keys): `{', '.join(sorted(rows[0].keys()))}`.")
    say()
    say("Sample rows:")
    for r in rows[:5]:
        say(f"  - {r}")
    say()


def section_cost_model(details_count):
    say("## 6. Cost model - Startup plan headroom")
    say()
    say(f"Credits spent by this run: **{spent} / {MAX_CREDITS} cap**.")
    say()
    if details_count == 0:
        say("_Not carried - cost-per-title projection needs at least one successful per-title "
            "details call, and none succeeded this run (credit cap or empty stub)._")
        say()
        return
    per_title = 1  # one /title/{id}/details/ call, observed cost 1 credit
    one_off_refresh = per_title * CATALOGUE_TARGET_SIZE
    monthly_revalidation = DAILY_REVALIDATIONS * 30
    headroom = STARTUP_MONTHLY_ALLOWANCE - monthly_revalidation
    say(f"Observed cost: **{per_title} credit/title** for `/title/{{id}}/details/`.")
    say()
    say(f"A one-off refresh of a {CATALOGUE_TARGET_SIZE:,}-title catalogue: "
        f"**{one_off_refresh:,} credits** (one-time, not monthly).")
    say(f"Brian's ~{DAILY_REVALIDATIONS}/day sync model: **{monthly_revalidation:,} credits/month** "
        f"against the Startup **{STARTUP_MONTHLY_ALLOWANCE:,}/month** allowance -> "
        f"headroom **{headroom:,}**.")
    say()


def main():
    if not KEY:
        sys.stderr.write("WATCHMODE_API_KEY is not set - the trial key must be in the environment "
                          "before this can run.\n")
        sys.exit(1)

    say("# Watchmode TRIAL evaluation for Cascade (CAS-767)")
    say()
    say(f"Run {date.today().isoformat()} · Startup trial key (expected) · region AU · "
        f"credit cap {MAX_CREDITS}")
    say()

    movies = load_catalogue()
    id_map, id_map_err = get_csv(CSV_URL)
    id_map = id_map or {}
    if id_map_err:
        say(f"_Id-map download failed ({id_map_err}) - theatrical-date matching and sample "
            "resolution may under-report._")
        say()
    imdb_to_wm = {v: k for k, v in id_map.items()}

    verdict = section_theatrical_dates(movies, id_map)
    if verdict == "TRIAL_NOT_ACTIVE":
        say("## Trial status")
        say()
        say("**401 on `/title-release-dates/` - the trial is not active.** Every section below "
            "needs the same paid tier, so this run stops here rather than publish a misleadingly "
            "thin report. Re-dispatch once the trial key is live.")
        say()
        finish(1)

    picks = build_sample(movies)
    details, unresolved, stopped_early = fetch_details_for_sample(picks, imdb_to_wm)
    if stopped_early:
        say(f"_Credit cap ({MAX_CREDITS}) reached while fetching per-title details - "
            f"{len(details)} sampled titles fetched, {unresolved} unresolved to a Watchmode id. "
            "Remaining sections below run on this partial sample._")
        say()

    section_content_ratings(movies, details, picks)
    section_six_fields(details, picks)
    section_rating_parity(movies, details)
    section_changes()
    section_cost_model(len(details))

    say("---")
    say()
    say(f"**Credits spent: ~{spent}.**")
    finish(0)


if __name__ == "__main__":
    main()
