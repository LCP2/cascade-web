#!/usr/bin/env python3
"""CAS-984: dispatch a manual OscarBase awards backfill against the catalogue on disk.

OscarBase is free and needs no key (CAS-937) — unlike CAS-850's Watchmode backfill, this never
gates on a missing credential. The nightly pass (poc_pipeline.py's `run()`) only spends
OSCARBASE_BACKFILL_BUDGET titles a night against the whole catalogue; at the old default of 300
a first pass over ~6,000 titles took weeks. This script restricts itself to titles OscarBase has
never been asked about at all — a title still inside `_oscarbase_needs_fetch`'s recent-ceremony-
year recheck window is the nightly pass's job, not this backfill's — and reports how much of that
never-fetched backlog is left.

Reuses CAS-937's `enrich_oscarbase`/`_api_call` from poc_pipeline.py.

CAS-906's lesson, restated for OscarBase: the nightly run rebuilds the WHOLE catalogue from
state/last_snapshot.json, never from movies.json. A freshly-cached title is excluded from the
nightly candidate list on its very next run (`_oscarbase_needs_fetch` sees it in the cache and,
for anything but a still-live awards race, skips it), so the award/award_text/oscar_detail fields
this script writes must also land in the snapshot, or the next nightly build silently drops them.
"""
import datetime
import json
import os
import sys
import time

# Puts this file's own directory (scripts/) at the front of sys.path, not the repo root —
# poc_pipeline.py at the root is otherwise invisible. Resolve from __file__, not the working
# directory, so this also runs correctly when invoked from elsewhere (CAS-859).
_REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _REPO_ROOT not in sys.path:
    sys.path.insert(0, _REPO_ROOT)

import poc_pipeline as pp  # noqa: E402

CATALOGUE = os.environ.get("CASCADE_CATALOGUE", "movies.json")
SNAPSHOT = os.environ.get("CASCADE_SNAPSHOT", pp.SNAPSHOT_FILE)
MAX_BUDGET = int(os.environ.get("OSCARBASE_BACKFILL_MAX", "1500"))

# The exact set of fields `_apply_oscarbase_award_fields` ever writes onto a record. Mirrored
# onto the snapshot record for the same tmdb_id — never any other key.
OSCARBASE_FIELD_NAMES = ("award", "award_text", "oscar_detail")


def load_catalogue(path):
    with open(path, encoding="utf-8") as fh:
        data = json.load(fh)
    movies = data.get("movies", data) if isinstance(data, dict) else data
    return data, movies


def save_catalogue(path, data):
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(data, fh, ensure_ascii=False, indent=2)
        fh.write("\n")


def load_snapshot(path):
    """None when the file does not exist — distinct from `[]`, so the caller can tell "nothing to
    merge into" apart from "an empty snapshot"."""
    if not os.path.exists(path):
        return None
    with open(path, encoding="utf-8") as fh:
        return json.load(fh)


def save_snapshot(path, records):
    with open(path, "w") as fh:
        json.dump(records, fh, indent=2)


def load_cache(path):
    if not os.path.exists(path):
        return {}
    with open(path, encoding="utf-8") as fh:
        return json.load(fh)


def save_cache(path, cache):
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    with open(path, "w") as fh:
        json.dump(cache, fh, indent=2)


def merge_oscarbase_fields_into_snapshot(snapshot_records, enriched_movies):
    """Mirror this run's own writes (`OSCARBASE_FIELD_NAMES`) onto the matching snapshot record
    by `tmdb_id` — a MERGE onto the existing record. A title present in movies.json but absent
    from the snapshot is the daily run's business, not this script's: it is counted as skipped,
    never appended. Mutates `snapshot_records`' own dicts in place so the list's identity and
    order are untouched. Returns (updated, skipped)."""
    by_tmdb_id = {r.get("tmdb_id"): r for r in snapshot_records}
    updated = 0
    skipped = 0
    for movie in enriched_movies:
        record = by_tmdb_id.get(movie.get("tmdb_id"))
        if record is None:
            skipped += 1
            continue
        for field in OSCARBASE_FIELD_NAMES:
            if field in movie:
                record[field] = movie[field]
        updated += 1
    return updated, skipped


def run(catalogue_path=None, snapshot_path=None, cache_path=None, budget=None, today=None):
    catalogue_path = catalogue_path or CATALOGUE
    snapshot_path = snapshot_path or SNAPSHOT
    cache_path = cache_path or pp.OSCARBASE_CACHE_FILE
    budget = MAX_BUDGET if budget is None else budget
    today = today or datetime.date.today()

    data, movies = load_catalogue(catalogue_path)
    cache = load_cache(cache_path)

    # Never-fetched titles only — a cached title inside the recent-ceremony recheck window
    # (`_oscarbase_needs_fetch`'s other case) is the nightly pass's job, not this backfill's.
    candidates = [m for m in movies if str(m.get("tmdb_id")) not in cache]

    outcomes = {"ok": 0, "skip": 0, "stop": 0}
    newly_enriched = []
    open_ = True
    remaining_budget = budget
    for m in candidates:
        if not open_ or remaining_budget <= 0:
            break
        _, outcome = pp._api_call("OscarBase", pp.enrich_oscarbase, m, cache)
        remaining_budget -= 1
        if outcome == "ok":
            outcomes["ok"] += 1
            newly_enriched.append(m)
        else:
            outcomes["stop" if outcome == "stop" else "skip"] += 1
            if outcome == "stop":
                open_ = False
        if pp.OSCARBASE_PACING:
            time.sleep(pp.OSCARBASE_PACING)

    # Cache first — if the snapshot/catalogue write below raises, this run's fetches must still
    # be on disk so a retry never re-spends the calls it already made.
    save_cache(cache_path, cache)

    snapshot_records = load_snapshot(snapshot_path)
    if snapshot_records is None:
        snapshot_updated, snapshot_skipped = 0, len(newly_enriched)
    else:
        snapshot_updated, snapshot_skipped = merge_oscarbase_fields_into_snapshot(
            snapshot_records, newly_enriched)
        save_snapshot(snapshot_path, snapshot_records)

    save_catalogue(catalogue_path, data)

    fetched = outcomes["ok"]
    with_awards = sum(1 for entry in cache.values() if entry.get("nominations"))
    remaining = sum(1 for m in movies if str(m.get("tmdb_id")) not in cache)

    print(f"fetched={fetched} with_awards={with_awards} remaining={remaining}")
    counts = {
        "fetched": fetched,
        "with_awards": with_awards,
        "remaining": remaining,
        "candidates considered": len(candidates),
        "skipped": outcomes["skip"],
        "stopped": outcomes["stop"],
        "snapshot records updated": snapshot_updated,
        "snapshot records skipped (not in snapshot)": snapshot_skipped,
    }
    return counts


if __name__ == "__main__":
    run()
