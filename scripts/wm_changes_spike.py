#!/usr/bin/env python3
"""CAS-990: spike measuring whether Watchmode's Changes endpoints
(`/changes/titles_details_changed`, `/changes/titles_sources_changed`) could replace most of the
30-day/7-day TTL re-fetch that is Cascade's entire recurring Watchmode bill (see the ticket's Why
section for the current ~4,000-credit/month figure). Read-only against Watchmode — writes only
`docs/appraisals/cas-watchmode-changes-spike.md`, never `movies.json`, `state/*`, `poc_pipeline.py`
or `monitor/`.

Five measurements, in the ticket's own order, sharing one credit budget (--max-credits, default
50). Every metered call checks the budget first; once it would be exceeded the run stops cleanly
and the doc records where:
  1. Seven-day counts    — for each of the last 7 full UTC days, `total_results` (page 1 only)
                            from both endpoints (`titles_sources_changed` with `regions=AU`, per
                            the ticket's own readout of the OpenAPI spec — `titles_details_changed`
                            takes no `regions` param).
  2. Most-recent-day      — the most recent of those 7 days, paged to exhaustion (or the credit
     breakdown             cap), classified against the published catalogue (`movies.json` +
                            `state/watchmode_ids.json`) and the candidate pool
                            (`state/candidates.json`, joined via the free `title_id_map.csv`
                            dataset — not credit-metered, same as `ingest_watchmode`'s own use of
                            it in `poc_pipeline.py`).
  3. Score sensitivity    — up to 10 published titles inside that day's details-changed set, and
                            up to 10 published titles outside the union of every details-changed
                            result over the last 30 days whose own cached fetch
                            (`wm_fields_fetched_at`) is more than 20 days old; title details fetched
                            for each and `user_rating`/`critic_score` compared with the cached
                            value.
  4. One-month credit     — arithmetic only, no calls: the real TTL model's monthly credits (from
     comparison            today's published count and ladder-cohort size) against a
                            changes-driven model (daily pages for both endpoints x 30, plus one
                            re-fetch per changed published title, extrapolated from measurement 2).

The endpoints' own row shape is NOT confirmed anywhere in this codebase — CAS-882's own probe
(`scripts/cas882_watchmode_reprobe.py`) never got a live run back. `_extract_rows`/`_row_id` below
try every key CAS-882 already tried (`changes`, `titles`, `results`, `items`) plus
`title_id_changes`, and each row may be a raw id or a dict carrying one. The appraisal doc's "row
shape" section is evidence from whatever a live run actually saw, not a foregone conclusion.

--dry-run fakes only the network: it swaps the Watchmode calls for a small recorded fixture (no
WATCHMODE_API_KEY, no HTTP) but still reads the real `movies.json` / `state/*` files on disk, so
the published-count/cohort-size numbers in measurement 4 are real even in a dry run. This is what
tests/test_cas990_wm_changes_spike.py exercises.

A live run needs WATCHMODE_API_KEY, a GitHub Actions secret only (CAS-579/767) — this script is
meant to run inside .github/workflows/wm_changes_spike.yml, dispatch-only, never on a dev machine.
"""
from __future__ import annotations
import argparse
import datetime
import json
import os
import sys

_REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _REPO_ROOT not in sys.path:
    sys.path.insert(0, _REPO_ROOT)

import poc_pipeline as pp  # noqa: E402

DOC_PATH = os.path.join(_REPO_ROOT, "docs", "appraisals", "cas-watchmode-changes-spike.md")
DEFAULT_MAX_CREDITS = 50
PAGE_LIMIT = 250
SEVEN_DAYS = 7
THIRTY_DAYS = 30
SCORE_SENSITIVITY_SAMPLE = 10
SCORE_STALE_DAYS = 20

DETAILS_PATH = "/changes/titles_details_changed/"
SOURCES_PATH = "/changes/titles_sources_changed/"

_LIST_KEYS = ("changes", "titles", "results", "items", "title_id_changes")

# A small recorded stand-in for a real /changes/* response — see the module docstring on why the
# row shape is unconfirmed. Keyed (endpoint, days_ago) so --dry-run can answer both the 7-day count
# loop and the 30-day union scan from the same table.
_DRY_RUN_TOTALS = {
    ("details", 1): 3, ("sources", 1): 2,
    ("details", 2): 5, ("sources", 2): 1,
    ("details", 3): 4, ("sources", 3): 2,
    ("details", 4): 2, ("sources", 4): 0,
    ("details", 5): 6, ("sources", 5): 3,
    ("details", 6): 3, ("sources", 6): 1,
    ("details", 7): 4, ("sources", 7): 2,
}
_DRY_RUN_DETAILS_IDS_RECENT_DAY = ["101", "202", "303"]
_DRY_RUN_SOURCES_IDS_RECENT_DAY = ["202", "404"]
_DRY_RUN_IDMAP = {"101": 9101, "202": 9202, "303": 9303, "404": 9404}
_DRY_RUN_TITLE_DETAILS = {
    "101": {"user_rating": 7.0, "critic_score": 55},
    "303": {"user_rating": 6.5, "critic_score": 60},
}


def _extract_rows(data: dict) -> list:
    if not isinstance(data, dict):
        return []
    for key in _LIST_KEYS:
        value = data.get(key)
        if isinstance(value, list):
            return value
    return []


def _row_id(row) -> str:
    if isinstance(row, dict):
        for key in ("id", "title_id", "wm_id"):
            if row.get(key) is not None:
                return str(row[key])
        return ""
    return str(row)


def _changes_url(path: str, day: datetime.date, page: int, regions: str | None) -> str:
    ymd = day.strftime("%Y%m%d")
    params = ["types=movie", f"start_date={ymd}", f"end_date={ymd}", f"page={page}",
              f"limit={PAGE_LIMIT}"]
    if regions:
        params.append(f"regions={regions}")
    return f"{pp.WATCHMODE_BASE}{path}?apiKey={pp.WATCHMODE_KEY}&" + "&".join(params)


def fetch_changes_page(endpoint: str, day: datetime.date, page: int, today: datetime.date,
                        dry_run: bool = False) -> dict:
    """endpoint is 'details' or 'sources'. Live shape unconfirmed (see module docstring) — reads
    `total_results`/`total_pages` plus whichever list key `_extract_rows` finds. `today` is the
    caller's own run date (never recomputed here), so a fixture lookup can't disagree with the
    caller about which day is "the most recent day" across a UTC-midnight boundary."""
    if dry_run:
        days_ago = (today - day).days
        total = _DRY_RUN_TOTALS.get((endpoint, days_ago), 0)
        if days_ago == 1 and page == 1:
            ids = (_DRY_RUN_DETAILS_IDS_RECENT_DAY if endpoint == "details"
                   else _DRY_RUN_SOURCES_IDS_RECENT_DAY)
        else:
            ids = []
        return {"titles": ids, "total_results": total, "total_pages": 1}
    path = DETAILS_PATH if endpoint == "details" else SOURCES_PATH
    regions = "AU" if endpoint == "sources" else None
    return pp.get_json(_changes_url(path, day, page, regions))


def fetch_title_details(wm_id: str, dry_run: bool = False) -> dict:
    if dry_run:
        return _DRY_RUN_TITLE_DETAILS.get(wm_id, {})
    return pp.get_json(f"{pp.WATCHMODE_BASE}/title/{wm_id}/details/?apiKey={pp.WATCHMODE_KEY}")


def fetch_idmap(dry_run: bool = False) -> dict:
    """Watchmode id (str) -> tmdb_id (int). The free `title_id_map.csv` dataset — not one of the
    credit-metered calls this spike is measuring, so it is never charged against --max-credits,
    matching how `ingest_watchmode` already treats it in poc_pipeline.py."""
    if dry_run:
        return dict(_DRY_RUN_IDMAP)
    return pp._fetch_watchmode_idmap()


def load_movies(path: str) -> list:
    with open(path, encoding="utf-8") as fh:
        data = json.load(fh)
    return data.get("movies", data) if isinstance(data, dict) else data


def load_wm_id_cache(path: str) -> dict:
    """imdb_id -> Watchmode id, from state/watchmode_ids.json — absent is not an error, just an
    empty cache (CAS-989/991 treat every state/*.json input this way)."""
    if not os.path.exists(path):
        return {}
    with open(path, encoding="utf-8") as fh:
        return json.load(fh)


def build_wm_id_movie_map(movies: list, wm_cache: dict) -> dict:
    """Watchmode id (str) -> movie record, for every published title whose imdb_id has already
    resolved to a Watchmode id in state/watchmode_ids.json. A title with no cache hit contributes
    nothing — under-counting rather than guessing an id."""
    out = {}
    for m in movies:
        wm_id = wm_cache.get(m.get("imdb_id"))
        if wm_id is not None:
            out[str(wm_id)] = m
    return out


class Budget:
    """Enforces --max-credits against `calls` — every simulated call counts against the cap even
    in --dry-run, so a low cap still exercises the real stopping logic in a dry run. `credits_spent`
    is the number shown to the user/doc: the real figure live, but always 0 in a dry run, since no
    dry run ever spends a real Watchmode credit (the ticket's own AC1 requirement)."""
    def __init__(self, cap: int, dry_run: bool = False):
        self.cap = cap
        self.calls = 0
        self.stopped = False
        self.dry_run = dry_run

    def take(self) -> bool:
        """True and counts one call against the cap if it allows it; False (and sets `stopped`)
        if not."""
        if self.calls >= self.cap:
            self.stopped = True
            return False
        self.calls += 1
        return True

    @property
    def credits_spent(self) -> int:
        return 0 if self.dry_run else self.calls


def measurement_1_seven_day_counts(days: list, budget: Budget, dry_run: bool,
                                    cache: dict, today: datetime.date) -> list:
    rows = []
    for day in days:
        row = {"date": day.isoformat(), "details_total": None, "sources_total": None}
        for endpoint in ("details", "sources"):
            key = (endpoint, day.isoformat(), 1)
            if key in cache:
                data = cache[key]
            elif budget.take():
                data = fetch_changes_page(endpoint, day, 1, today, dry_run=dry_run)
                cache[key] = data
            else:
                data = None
            row[f"{endpoint}_total"] = (data or {}).get("total_results") if data else None
        rows.append(row)
        if budget.stopped:
            break
    return rows


def measurement_2_recent_day(recent_day: datetime.date, budget: Budget, dry_run: bool,
                              cache: dict, published_wm_ids: set, candidate_tmdb_ids: set,
                              idmap: dict, today: datetime.date) -> dict:
    ids_by_endpoint = {"details": set(), "sources": set()}
    total_pages_by_endpoint = {"details": 1, "sources": 1}
    for endpoint in ("details", "sources"):
        page = 1
        while True:
            key = (endpoint, recent_day.isoformat(), page)
            if key in cache:
                data = cache[key]
            elif budget.take():
                data = fetch_changes_page(endpoint, recent_day, page, today, dry_run=dry_run)
                cache[key] = data
            else:
                break
            for row in _extract_rows(data):
                ids_by_endpoint[endpoint].add(_row_id(row))
            total_pages = data.get("total_pages") or 1
            total_pages_by_endpoint[endpoint] = total_pages
            if page >= total_pages:
                break
            page += 1
        if budget.stopped:
            break

    all_ids = ids_by_endpoint["details"] | ids_by_endpoint["sources"]
    published_changed = all_ids & published_wm_ids
    candidate_changed = {tid for wid in all_ids
                          if (tid := idmap.get(wid)) is not None and str(tid) in candidate_tmdb_ids}
    return {
        "date": recent_day.isoformat(),
        "details_ids": ids_by_endpoint["details"],
        "sources_ids": ids_by_endpoint["sources"],
        "all_ids_count": len(all_ids),
        "published_changed_count": len(published_changed),
        "candidate_changed_count": len(candidate_changed),
        "details_total_pages": total_pages_by_endpoint["details"],
        "sources_total_pages": total_pages_by_endpoint["sources"],
    }


def _fetch_stale(movie: dict, today: datetime.date, stale_days: int = SCORE_STALE_DAYS) -> bool:
    stamp = movie.get("wm_fields_fetched_at")
    if not stamp:
        return True
    try:
        stamped = datetime.date.fromisoformat(stamp)
    except ValueError:
        return True
    return (today - stamped).days > stale_days


def measurement_3_score_sensitivity(days: list, m2: dict, budget: Budget, dry_run: bool,
                                     cache: dict, wm_id_movie_map: dict,
                                     today: datetime.date) -> dict:
    details_30d_ids = set()
    for day in days:
        key = ("details", day.isoformat(), 1)
        if key in cache:
            data = cache[key]
        elif budget.take():
            data = fetch_changes_page("details", day, 1, today, dry_run=dry_run)
            cache[key] = data
        else:
            continue
        details_30d_ids.update(_row_id(r) for r in _extract_rows(data))

    published_wm_ids = set(wm_id_movie_map)
    group_a_ids = sorted(published_wm_ids & m2["details_ids"])[:SCORE_SENSITIVITY_SAMPLE]
    group_b_ids = sorted(
        wid for wid in published_wm_ids
        if wid not in details_30d_ids and _fetch_stale(wm_id_movie_map[wid], today)
    )[:SCORE_SENSITIVITY_SAMPLE]

    def sample(group_ids):
        sampled = changed = 0
        for wm_id in group_ids:
            if not budget.take():
                break
            data = fetch_title_details(wm_id, dry_run=dry_run)
            sampled += 1
            movie = wm_id_movie_map[wm_id]
            if (data.get("user_rating") != movie.get("wm_user_rating")
                    or data.get("critic_score") != movie.get("wm_critic_score")):
                changed += 1
        return {"candidates": len(group_ids), "sampled": sampled, "changed": changed}

    return {
        "in_details_changed": sample(group_a_ids),
        "stale_and_unchanged_30d": sample(group_b_ids),
        "details_30d_union_count": len(details_30d_ids),
    }


def measurement_4_one_month_comparison(movies: list, m2: dict) -> dict:
    published_count = len(movies)
    cohort_size = sum(1 for m in movies if pp._is_ladder_cohort(m))
    current_monthly = (published_count * (30 / pp.WATCHMODE_CACHE_TTL_DAYS)
                        + cohort_size * (30 / pp.WM_NIGHTLY_COHORT_TTL_DAYS))
    pages_per_day = m2["details_total_pages"] + m2["sources_total_pages"]
    changed_published_per_day = m2["published_changed_count"]
    changes_monthly = pages_per_day * 30 + changed_published_per_day * 30
    return {
        "published_count": published_count,
        "cohort_size": cohort_size,
        "current_monthly_credits": round(current_monthly, 1),
        "changes_monthly_credits": changes_monthly,
        "pages_per_day_sampled": pages_per_day,
        "changed_published_per_day_sampled": changed_published_per_day,
    }


def _write_doc(path: str, run_date: str, budget: Budget, stopped_note: str | None,
                m1_rows: list, m2: dict, m3: dict, m4: dict) -> None:
    lines = [
        "# Watchmode Changes endpoints — cost spike (CAS-990)",
        "",
        f"Measured {run_date} by `scripts/wm_changes_spike.py`, dispatched via "
        "`.github/workflows/wm_changes_spike.yml` (WATCHMODE_API_KEY is a GitHub Actions secret "
        "only).",
        "",
        f"Credits spent: {budget.credits_spent} (cap {budget.cap}).",
    ]
    if stopped_note:
        lines.append(stopped_note)
    lines.append("")

    lines.append("## 1. Seven-day counts")
    lines.append("")
    lines.append("| Date | details_changed total_results | sources_changed total_results (AU) |")
    lines.append("| --- | --- | --- |")
    for row in m1_rows:
        d = row["details_total"] if row["details_total"] is not None else "—"
        s = row["sources_total"] if row["sources_total"] is not None else "—"
        lines.append(f"| {row['date']} | {d} | {s} |")
    lines.append("")

    lines.append("## 2. Most-recent-day breakdown")
    lines.append("")
    lines.append(f"Date: {m2['date']}.")
    lines.append(f"Total distinct IDs returned (both endpoints, page 1..{m2['details_total_pages']}"
                  f"/{m2['sources_total_pages']}): {m2['all_ids_count']}.")
    lines.append(f"Published titles among them: {m2['published_changed_count']}.")
    lines.append(f"Candidate-pool titles among them: {m2['candidate_changed_count']} "
                  "(joined via the free title_id_map.csv dataset).")
    lines.append("")

    lines.append("## 3. Score sensitivity")
    lines.append("")
    a, b = m3["in_details_changed"], m3["stale_and_unchanged_30d"]
    lines.append(f"Group A (published, in the recent day's details-changed set): "
                  f"{a['sampled']}/{a['candidates']} sampled, {a['changed']} changed.")
    lines.append(f"Group B (published, outside the {m3['details_30d_union_count']}-id 30-day "
                  f"details-changed union, cached fetch >{SCORE_STALE_DAYS}d old): "
                  f"{b['sampled']}/{b['candidates']} sampled, {b['changed']} changed.")
    lines.append("")

    lines.append("## 4. One-month credit comparison")
    lines.append("")
    lines.append(f"Published count: {m4['published_count']}. Ladder-cohort size: "
                  f"{m4['cohort_size']}.")
    lines.append(f"Current TTL model: ~{m4['current_monthly_credits']} credits/month "
                  f"(published x 30/{pp.WATCHMODE_CACHE_TTL_DAYS}d + cohort x "
                  f"30/{pp.WM_NIGHTLY_COHORT_TTL_DAYS}d).")
    lines.append(f"Changes-driven model: ~{m4['changes_monthly_credits']} credits/month "
                  f"({m4['pages_per_day_sampled']} page(s)/day sampled x 30 + "
                  f"{m4['changed_published_per_day_sampled']} re-fetch(es)/day sampled x 30).")
    lines.append("_The current-model figure assumes every published title is actually re-fetched "
                 "once per WATCHMODE_CACHE_TTL_DAYS; the real nightly pass is capped by "
                 "SCOREABILITY_PROBE_BUDGET, which is why the ticket's own estimate (~4,000 "
                 "credits/month) reads lower than this. Both models would carry the same cap in "
                 "practice, so the comparison still holds even though this line runs higher._")
    if m4["changes_monthly_credits"] < m4["current_monthly_credits"]:
        verdict = (f"Recommendation: adopt the changes-driven model — saves roughly "
                   f"{round(m4['current_monthly_credits'] - m4['changes_monthly_credits'], 1)} "
                   "credits/month at this sample's rates.")
    else:
        verdict = (f"Recommendation: keep the TTL model — the changes-driven model costs roughly "
                   f"{round(m4['changes_monthly_credits'] - m4['current_monthly_credits'], 1)} "
                   "more credits/month at this sample's rates.")
    lines.append(verdict)
    lines.append("")

    lines.append("## What could not be established")
    lines.append("")
    lines.append("- The real row shape of `/changes/titles_details_changed` and "
                  "`/changes/titles_sources_changed` — CAS-882's own probe never got a live run "
                  "back, so this script tries every list key CAS-882 already tried plus "
                  "`title_id_changes`; a live run's actual shape should be read off the raw "
                  "response, not assumed from this doc.")
    lines.append("- Whether a change to `user_rating`/`critic_score` alone is what puts a title in "
                  "`titles_details_changed` — measurement 3 is this spike's only evidence, and its "
                  "sample sizes (up to 10 each) are small.")
    lines.append("- Measurements 1 and 3 read only page 1 (limit 250) of each day queried; a day "
                  "with more than 250 changes would under-count that day, and this could not be "
                  "confirmed without spending more credits than the cap allowed.")
    lines.append("")

    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as fh:
        fh.write("\n".join(lines) + "\n")


def run(max_credits: int, dry_run: bool, movies_path: str | None = None,
        wm_ids_path: str | None = None, candidates_path: str | None = None,
        doc_path: str | None = None) -> dict:
    doc_path = doc_path or DOC_PATH
    movies_path = movies_path or pp.OUTPUT_FILE
    wm_ids_path = wm_ids_path or pp.WM_CACHE_FILE

    today = datetime.datetime.now(datetime.timezone.utc).date()
    days = [today - datetime.timedelta(days=i) for i in range(1, THIRTY_DAYS + 1)]
    seven_days = days[:SEVEN_DAYS]
    recent_day = days[0]

    movies = load_movies(movies_path)
    wm_cache = load_wm_id_cache(wm_ids_path)
    wm_id_movie_map = build_wm_id_movie_map(movies, wm_cache)
    published_wm_ids = set(wm_id_movie_map)

    if candidates_path is not None:
        if os.path.exists(candidates_path):
            with open(candidates_path, encoding="utf-8") as fh:
                candidates = json.load(fh)
        else:
            candidates = {}
    else:
        candidates = pp.load_candidates()
    candidate_tmdb_ids = set(candidates)

    idmap = fetch_idmap(dry_run=dry_run)

    budget = Budget(max_credits, dry_run=dry_run)
    cache: dict = {}

    m1_rows = measurement_1_seven_day_counts(seven_days, budget, dry_run, cache, today)
    m2 = measurement_2_recent_day(recent_day, budget, dry_run, cache, published_wm_ids,
                                   candidate_tmdb_ids, idmap, today)
    m3 = measurement_3_score_sensitivity(days, m2, budget, dry_run, cache, wm_id_movie_map, today)
    m4 = measurement_4_one_month_comparison(movies, m2)

    stopped_note = (f"Stopped early — max_credits={max_credits} reached before every measurement "
                     "could finish; sections above reflect only what was fetched.") \
        if budget.stopped else None

    _write_doc(doc_path, today.isoformat(), budget, stopped_note, m1_rows, m2, m3, m4)
    print(f"credits spent: {budget.credits_spent}")
    if budget.stopped:
        print(f"stopped early (max_credits={max_credits} reached)")
    return {"credits_spent": budget.credits_spent, "stopped": budget.stopped, "m1": m1_rows,
            "m2": m2, "m3": m3, "m4": m4}


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__,
                                      formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--max-credits", type=int, default=DEFAULT_MAX_CREDITS)
    parser.add_argument("--dry-run", action="store_true",
                         help="run against a recorded fixture, no network call")
    parser.add_argument("--doc-path", default=None, help="output path (testing)")
    parser.add_argument("--movies-path", default=None, help="movies.json path (testing)")
    parser.add_argument("--wm-ids-path", default=None, help="state/watchmode_ids.json path (testing)")
    parser.add_argument("--candidates-path", default=None, help="state/candidates.json path (testing)")
    args = parser.parse_args(argv)

    if not args.dry_run and not os.environ.get("WATCHMODE_API_KEY"):
        print("WATCHMODE_API_KEY is not set — nothing to do here (pass --dry-run to exercise "
              "this script without it).")
        return 0

    run(args.max_credits, args.dry_run, movies_path=args.movies_path,
        wm_ids_path=args.wm_ids_path, candidates_path=args.candidates_path,
        doc_path=args.doc_path)
    return 0


if __name__ == "__main__":
    sys.exit(main())
