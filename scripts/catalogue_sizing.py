#!/usr/bin/env python3
"""
CAS-354 — live-size the catalogue via TMDB discover `total_results`.
CAS-522 added the third, 3yr-bounded widened-scope query.
CAS-548 added the "Quality-gated pool" section: four vote_average.gte=5.9 pre-screen
variants, to test whether TMDB's own user score can stand in for a cheap pre-OMDb filter.

Runs discover/movie queries and reports total_results + total_pages for each:
  1. current scope — pipeline-identical params (see poc_pipeline._discover_au_theatrical),
     directly comparable to today's catalogue size.
  2. widened scope, unbounded — everything watchable in AU (watch_region + monetization
     types, no release_type restriction, no date bound), the whole AU-watchable universe
     across all of film history.
  3. widened scope, 3yr-bounded — same AU-watchable query as #2, but bounded to the same
     LOOKBACK_DAYS window as current-scope, so it's directly comparable to #1: how many
     extra non-cinema-release titles exist within the 3 years we already cover.
  4. quality-gated pool — four AU-watchable, vote_average.gte=5.9 variants (vote_count.gte
     0/50/250 in-window, plus one pre-window at vote_count.gte=50) sizing the pool Phase 1
     of the catalogue expansion (CAS-549) would actually screen.

Requires TMDB_API_KEY in env. That key is a GitHub Actions secret only (not on the dev
PC, per CAS-335) — this script is a no-op without it, by design; it is meant to run in
CI (.github/workflows/daily.yml), never locally.
"""
from __future__ import annotations
import datetime, os, sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from poc_pipeline import TMDB_BASE, REGION, LOOKBACK_DAYS, TMDB_KEY, get_json  # noqa: E402

DOC_FILE = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                         "docs", "appraisals", "cas-catalogue-sizing.md")


def current_scope_totals() -> dict:
    """Pipeline-identical discover query — same params poc_pipeline uses to ingest
    (with_release_type=2|3, AU region, the same lookback window, popularity sort)."""
    today = datetime.date.today()
    start = (today - datetime.timedelta(days=LOOKBACK_DAYS)).isoformat()
    end = today.isoformat()
    disc = get_json(
        f"{TMDB_BASE}/discover/movie?api_key={TMDB_KEY}&region={REGION}"
        f"&with_release_type=2|3"
        f"&release_date.gte={start}&release_date.lte={end}"
        f"&sort_by=popularity.desc&page=1"
    )
    return {"total_results": disc.get("total_results"), "total_pages": disc.get("total_pages"),
            "start": start, "end": end}


def widened_scope_totals() -> dict:
    """Everything watchable in AU right now — no release_type restriction, no date bound."""
    disc = get_json(
        f"{TMDB_BASE}/discover/movie?api_key={TMDB_KEY}&watch_region={REGION}"
        f"&with_watch_monetization_types=flatrate|free|ads|rent|buy"
        f"&sort_by=popularity.desc&page=1"
    )
    return {"total_results": disc.get("total_results"), "total_pages": disc.get("total_pages")}


def widened_scope_bounded_totals() -> dict:
    """Everything watchable in AU — no release_type restriction, bounded to the same
    LOOKBACK_DAYS window as current_scope_totals()."""
    today = datetime.date.today()
    start = (today - datetime.timedelta(days=LOOKBACK_DAYS)).isoformat()
    end = today.isoformat()
    disc = get_json(
        f"{TMDB_BASE}/discover/movie?api_key={TMDB_KEY}&watch_region={REGION}"
        f"&with_watch_monetization_types=flatrate|free|ads|rent|buy"
        f"&release_date.gte={start}&release_date.lte={end}"
        f"&sort_by=popularity.desc&page=1"
    )
    return {"total_results": disc.get("total_results"), "total_pages": disc.get("total_pages"),
            "start": start, "end": end}


def quality_gated_totals() -> list[dict]:
    """Four AU-watchable discover queries pre-screened by vote_average.gte=5.9, per CAS-548.

    Variants 1-3 vary vote_count.gte within the same LOOKBACK_DAYS window as current-scope,
    to size the qualifying in-window pool and how much of it is vote-count noise. Variant 4
    is bounded above by the window floor (no lower bound), sizing Phase 2's backwards-in-time
    pool."""
    today = datetime.date.today()
    window_start = (today - datetime.timedelta(days=LOOKBACK_DAYS)).isoformat()
    window_end = today.isoformat()
    pre_window_end = (today - datetime.timedelta(days=LOOKBACK_DAYS + 1)).isoformat()

    variants = [
        {"window": f"in-window ({window_start}..{window_end})", "vote_count_gte": 0,
         "release_date_gte": window_start, "release_date_lte": window_end},
        {"window": f"in-window ({window_start}..{window_end})", "vote_count_gte": 50,
         "release_date_gte": window_start, "release_date_lte": window_end},
        {"window": f"in-window ({window_start}..{window_end})", "vote_count_gte": 250,
         "release_date_gte": window_start, "release_date_lte": window_end},
        {"window": f"pre-window (release_date.lte={pre_window_end}, no lower bound)",
         "vote_count_gte": 50, "release_date_gte": None, "release_date_lte": pre_window_end},
    ]

    results = []
    for v in variants:
        url = (f"{TMDB_BASE}/discover/movie?api_key={TMDB_KEY}&watch_region={REGION}"
               f"&with_watch_monetization_types=flatrate|free|ads|rent|buy"
               f"&vote_average.gte=5.9&vote_count.gte={v['vote_count_gte']}")
        if v["release_date_gte"]:
            url += f"&release_date.gte={v['release_date_gte']}"
        url += f"&release_date.lte={v['release_date_lte']}&sort_by=popularity.desc&page=1"
        disc = get_json(url)
        results.append({**v, "vote_average_gte": 5.9,
                         "total_results": disc.get("total_results"),
                         "total_pages": disc.get("total_pages")})
    return results


def write_memo(current: dict, widened: dict, widened_bounded: dict,
                quality_gated: list[dict]) -> None:
    today = datetime.date.today().isoformat()
    lines = [
        "# Catalogue sizing — TMDB discover total_results (CAS-354, CAS-522)",
        "",
        f"Measured {today} by `scripts/catalogue_sizing.py`, run in CI (`.github/workflows/daily.yml`) "
        "where the TMDB key exists.",
        "",
        f"## Current scope (pipeline-identical: with_release_type=2|3, region={REGION}, "
        f"{current['start']}..{current['end']}, sort_by=popularity.desc)",
        "",
        f"- total_results: {current['total_results']}",
        f"- total_pages: {current['total_pages']}",
        "",
        f"## Widened scope, unbounded (everything watchable in AU across all of film history: "
        f"watch_region={REGION}, with_watch_monetization_types=flatrate|free|ads|rent|buy, "
        "no release_type restriction, no date bound)",
        "",
        f"- total_results: {widened['total_results']}",
        f"- total_pages: {widened['total_pages']}",
        "",
        f"## Widened scope, 3yr-bounded (same AU-watchable query as above, but bounded to the "
        f"same {current['start']}..{current['end']} window as current-scope — extra "
        "non-cinema-release titles within the 3 years we already cover)",
        "",
        f"- total_results: {widened_bounded['total_results']}",
        f"- total_pages: {widened_bounded['total_pages']}",
        "",
        "## Quality-gated pool (AU-watchable, watch_region=AU, "
        "with_watch_monetization_types=flatrate|free|ads|rent|buy, sort_by=popularity.desc — "
        "CAS-548)",
        "",
        "| # | Window | vote_average.gte | vote_count.gte | total_results | total_pages |",
        "| --- | --- | --- | --- | --- | --- |",
    ]
    for i, v in enumerate(quality_gated, start=1):
        lines.append(f"| {i} | {v['window']} | {v['vote_average_gte']} | {v['vote_count_gte']} "
                      f"| {v['total_results']} | {v['total_pages']} |")
    lines.append("")
    os.makedirs(os.path.dirname(DOC_FILE), exist_ok=True)
    with open(DOC_FILE, "w", encoding="utf-8") as f:
        f.write("\n".join(lines) + "\n")


def main() -> int:
    if not TMDB_KEY:
        print("[catalogue_sizing] TMDB_API_KEY not set — nothing to do here (this script is CI-only).")
        return 0
    current = current_scope_totals()
    widened = widened_scope_totals()
    widened_bounded = widened_scope_bounded_totals()
    quality_gated = quality_gated_totals()
    print(f"[catalogue_sizing] current-scope  total_results={current['total_results']} "
          f"total_pages={current['total_pages']}")
    print(f"[catalogue_sizing] widened-scope  total_results={widened['total_results']} "
          f"total_pages={widened['total_pages']}")
    print(f"[catalogue_sizing] widened-scope-3yr-bounded  total_results={widened_bounded['total_results']} "
          f"total_pages={widened_bounded['total_pages']}")
    for i, v in enumerate(quality_gated, start=1):
        print(f"[catalogue_sizing] quality-gated-{i}  vote_count.gte={v['vote_count_gte']} "
              f"total_results={v['total_results']} total_pages={v['total_pages']}")
    write_memo(current, widened, widened_bounded, quality_gated)
    return 0


if __name__ == "__main__":
    sys.exit(main())
