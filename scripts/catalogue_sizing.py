#!/usr/bin/env python3
"""
CAS-354 — live-size the catalogue via TMDB discover `total_results`.
CAS-522 added the third, 3yr-bounded widened-scope query.

Runs three discover/movie queries and reports total_results + total_pages for each:
  1. current scope — pipeline-identical params (see poc_pipeline._discover_au_theatrical),
     directly comparable to today's catalogue size.
  2. widened scope, unbounded — everything watchable in AU (watch_region + monetization
     types, no release_type restriction, no date bound), the whole AU-watchable universe
     across all of film history.
  3. widened scope, 3yr-bounded — same AU-watchable query as #2, but bounded to the same
     LOOKBACK_DAYS window as current-scope, so it's directly comparable to #1: how many
     extra non-cinema-release titles exist within the 3 years we already cover.

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


def write_memo(current: dict, widened: dict, widened_bounded: dict) -> None:
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
    ]
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
    print(f"[catalogue_sizing] current-scope  total_results={current['total_results']} "
          f"total_pages={current['total_pages']}")
    print(f"[catalogue_sizing] widened-scope  total_results={widened['total_results']} "
          f"total_pages={widened['total_pages']}")
    print(f"[catalogue_sizing] widened-scope-3yr-bounded  total_results={widened_bounded['total_results']} "
          f"total_pages={widened_bounded['total_pages']}")
    write_memo(current, widened, widened_bounded)
    return 0


if __name__ == "__main__":
    sys.exit(main())
