#!/usr/bin/env python3
"""
CAS-525 — on-demand historical backlog import, gated by rating threshold and release-date range.

A separate, Lee-triggered import for pulling back-catalogue titles into the persistent catalogue —
NOT part of the daily refresh (poc_pipeline.py), which keeps importing new/current releases with no
rating gate exactly as before. Run whenever Lee asks for a backlog import, with an explicit date
range and at least one rating threshold:

    python scripts/backlog_import.py --start 2015-01-01 --end 2018-12-31 --min-imdb 6.5
    python scripts/backlog_import.py --start 2005-01-01 --end 2005-12-31 --min-rt 70 --min-meta 60

CAS-938: the rating gate below (--min-imdb/--min-rt/--min-meta) scored candidates via OMDb, which
is now retired from the pipeline (its terms forbade commercial use). Nothing populates
imdb_rating/rt_critic/metacritic on a freshly-discovered candidate any more, so `run_backlog_import`
refuses to run rather than silently importing nothing while claiming to have looked. Needs a
redesign onto a Watchmode-backed rating source (a Lee decision, not guessed here) before this script
can import again — the pure helper functions below are kept and still tested since a redesign will
still need date-range resolution and an OR-across-thresholds gate.

Requires TMDB_API_KEY in env — a GitHub Actions secret only (not on the dev PC, per CAS-335), the
same CI-only-secret pattern as scripts/catalogue_sizing.py. Unlike that script it is not wired into
any scheduled workflow: it is meant to be run by hand wherever the key is available.

A matching title is merged into state/last_snapshot.json (the base catalogue the next daily run
starts from), tagged with `backlog_date_source`/`backlog_import_date`/`backlog_imported` — it then
flows through the ordinary daily pipeline (availability, status, movies.json) untouched.
"""
from __future__ import annotations
import argparse, datetime, os, sys, time

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import poc_pipeline as pp  # noqa: E402


def parse_args(argv=None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__.strip().splitlines()[0])
    parser.add_argument("--start", required=True, help="range start, inclusive, YYYY-MM-DD")
    parser.add_argument("--end", required=True, help="range end, inclusive, YYYY-MM-DD")
    parser.add_argument("--min-imdb", type=float, default=None, dest="min_imdb",
                         help="minimum IMDb rating (0-10)")
    parser.add_argument("--min-rt", type=int, default=None, dest="min_rt",
                         help="minimum Rotten Tomatoes critic score (0-100)")
    parser.add_argument("--min-meta", type=int, default=None, dest="min_meta",
                         help="minimum Metacritic score (0-100)")
    parser.add_argument("--limit", type=int, default=2000,
                         help="max candidate titles to fetch/score this run (default 2000)")
    args = parser.parse_args(argv)

    if args.min_imdb is None and args.min_rt is None and args.min_meta is None:
        parser.error("at least one of --min-imdb, --min-rt, --min-meta is required")
    for flag, value in (("--start", args.start), ("--end", args.end)):
        try:
            datetime.date.fromisoformat(value)
        except ValueError:
            parser.error(f"{flag} must be YYYY-MM-DD, got {value!r}")
    if args.start > args.end:
        parser.error("--start must not be after --end")
    return args


def thresholds_from_args(args: argparse.Namespace) -> dict:
    """Only the threshold(s) Lee actually set for this run — the rest simply aren't checked."""
    t = {}
    if args.min_imdb is not None:
        t["imdb_rating"] = args.min_imdb
    if args.min_rt is not None:
        t["rt_critic"] = args.min_rt
    if args.min_meta is not None:
        t["metacritic"] = args.min_meta
    return t


def resolve_effective_date(record: dict, raw_release_date: str | None) -> tuple[str | None, str]:
    """The AU-relevant date to filter/import a non-cinema-aware title by, and which basis produced
    it. Cinema titles (AU release_dates type=3, `cinema_release`) use `cinema_date`. Everything else
    uses the AU digital date (type=4) when present, else TMDB's global primary `release_date` —
    flagged as a fallback so it's visible which dates are AU-confirmed vs. inferred."""
    if record.get("cinema_release") and record.get("cinema_date"):
        return record["cinema_date"], "cinema"
    au_digital = next((rd["date"] for rd in record.get("release_dates", []) if rd.get("type") == 4), None)
    if au_digital:
        return au_digital, "au_digital"
    global_date = (raw_release_date or "")[:10] or None
    return global_date, "fallback_global"


def in_range(date_str: str | None, start: str, end: str) -> bool:
    return bool(date_str) and start <= date_str <= end


def has_any_score(record: dict) -> bool:
    return any(record.get(f) is not None for f in ("imdb_rating", "rt_critic", "metacritic"))


def passes_rating_gate(record: dict, thresholds: dict) -> bool:
    """OR across whichever thresholds are set: a title qualifies if it clears ANY one of them
    on a score it actually has. A set threshold whose score is missing on this title simply
    doesn't contribute — it neither passes nor fails the title by itself."""
    return any(record.get(field) is not None and record[field] >= threshold
               for field, threshold in thresholds.items())


def discover_candidates(start: str, end: str, limit: int, seen: set) -> list[dict]:
    """TMDB discover/movie by global primary_release_date, popularity-first, up to `limit` NEW
    (not already-catalogued) titles. Returns full TMDB detail payloads (release_dates, videos,
    credits appended) — the shape poc_pipeline._tmdb_record expects. No release_type restriction:
    unlike the daily theatrical pass, a backlog import is meant to reach deep-catalogue titles that
    never had an AU cinema release at all."""
    details, page = [], 1
    max_pages = min(500, max(1, -(-limit // 20)))
    while len(details) < limit and page <= max_pages:
        disc = pp.get_json(
            f"{pp.TMDB_BASE}/discover/movie?api_key={pp.TMDB_KEY}&region={pp.REGION}"
            f"&primary_release_date.gte={start}&primary_release_date.lte={end}"
            f"&sort_by=popularity.desc&page={page}"
        )
        results = disc.get("results", [])
        if not results:
            break
        for m in results:
            if m["id"] in seen:
                continue
            seen.add(m["id"])
            detail = pp.get_json(
                f"{pp.TMDB_BASE}/movie/{m['id']}?api_key={pp.TMDB_KEY}&append_to_response=release_dates,videos,credits"
            )
            details.append(detail)
            if pp.TMDB_PACING:
                time.sleep(pp.TMDB_PACING)
            if len(details) >= limit:
                break
        page += 1
    return details


def run_backlog_import(args: argparse.Namespace) -> dict:
    if not pp.TMDB_KEY:
        print("[backlog_import] TMDB_API_KEY not set — nothing to do here "
              "(CI-secret only, no local-key dependency).")
        return {"candidates": 0, "imported": 0, "skipped_no_score": 0, "skipped_rating_gate": 0,
                "skipped_out_of_range": 0, "fallback_date_count": 0}

    # CAS-938: the rating gate below scored candidates via OMDb (imdb_rating/rt_critic/metacritic),
    # now retired from the pipeline. Nothing populates those fields on a freshly-discovered
    # candidate any more, so refuse to run rather than silently importing nothing while claiming
    # to have looked — this needs a redesign onto a Watchmode-backed rating source first.
    print("[backlog_import] OMDb was retired (CAS-938) — this script's IMDb/RT/Metacritic rating "
          "gate has no data source any more and needs a redesign onto Watchmode fields before it "
          "can run again. Skipping.")
    return {"candidates": 0, "imported": 0, "skipped_no_score": 0, "skipped_rating_gate": 0,
            "skipped_out_of_range": 0, "fallback_date_count": 0}


def main(argv=None) -> int:
    args = parse_args(argv)
    run_backlog_import(args)
    return 0


if __name__ == "__main__":
    sys.exit(main())
