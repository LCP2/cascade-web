#!/usr/bin/env python3
"""CAS-850: dispatch CAS-830's Watchmode fields backfill against the catalogue on disk.

`WATCHMODE_API_KEY` only exists as a GitHub secret (see CAS-579/767), so this only ever runs
inside .github/workflows/watchmode-backfill.yml, never on a developer machine.

Reuses CAS-830's `_fetch_watchmode_idmap`, `_invert_watchmode_idmap` and
`enrich_watchmode_fields` from poc_pipeline.py. It loops over `enrich_watchmode_fields` directly
rather than the higher-level `backfill_watchmode_fields` wrapper: the wrapper's return value is
just the enriched count, but the four counts this script must report (enriched, budget-skipped,
no-id, credits spent) need the per-outcome detail only visible at that lower level.
"""
import argparse
import json
import os
import sys

# CAS-859: invoked as `python scripts/cas850_watchmode_backfill.py`, which puts this file's own
# directory (scripts/) at the front of sys.path, not the repo root — poc_pipeline.py at the root
# is otherwise invisible. Resolve from __file__, not the working directory, so this also runs
# correctly when invoked from elsewhere.
_REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _REPO_ROOT not in sys.path:
    sys.path.insert(0, _REPO_ROOT)

import poc_pipeline as pp  # noqa: E402

CATALOGUE = os.environ.get("CASCADE_CATALOGUE", "movies.json")
MAX_CREDITS = int(os.environ.get("WM_FIELDS_MAX_CREDITS", str(pp.WM_FIELDS_MAX_CREDITS)))


def load_catalogue(path):
    with open(path, encoding="utf-8") as fh:
        data = json.load(fh)
    movies = data.get("movies", data) if isinstance(data, dict) else data
    return data, movies


def save_catalogue(path, data):
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(data, fh, ensure_ascii=False, indent=2)
        fh.write("\n")


CACHED_REASON = "every candidate is still inside WATCHMODE_CACHE_TTL_DAYS"


def load_ids_from(path):
    """CAS-889: one tmdb_id per line; blank lines and lines starting `#` are ignored."""
    ids = []
    with open(path, encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            ids.append(int(line))
    return ids


def run(catalogue_path=None, max_credits=None, ids_from=None):
    catalogue_path = catalogue_path or CATALOGUE
    max_credits = MAX_CREDITS if max_credits is None else max_credits

    data, movies = load_catalogue(catalogue_path)

    ids_not_found = []
    if ids_from:
        wanted_ids = load_ids_from(ids_from)
        by_tmdb_id = {m.get("tmdb_id"): m for m in movies}
        targets = []
        for tmdb_id in wanted_ids:
            movie = by_tmdb_id.get(tmdb_id)
            if movie is None:
                ids_not_found.append(tmdb_id)
            else:
                targets.append(movie)
    else:
        targets = movies

    candidates = len(targets)

    idmap, idmap_outcome = pp._api_call("Watchmode ID map", pp._fetch_watchmode_idmap)
    wm_idmap = pp._invert_watchmode_idmap(idmap) if idmap_outcome == "ok" and idmap else {}

    budget = {"remaining": max_credits, "skipped": 0}
    outcomes = {"ok": 0, "cached": 0, "no-id": 0, "skip": 0, "stop": 0}
    for movie in targets:
        result = pp.enrich_watchmode_fields(movie, wm_idmap, budget)
        outcomes[result] = outcomes.get(result, 0) + 1

    save_catalogue(catalogue_path, data)

    enriched = outcomes["ok"]
    credits_spent = max_credits - budget["remaining"]

    # CAS-862 AC3: a green run that resolves 0 titles is only ever legitimate when every
    # candidate is still fresh (CACHED_REASON, the sole exemption the ticket names) — any other
    # zero is a defect (bad ID-map response, exhausted key, etc) and must be visible, not
    # silently swallowed the way the pre-fix run was. Reason text below is diagnostic detail
    # only; a mix of cached + no-id titles is NOT the named exemption and still exits non-zero,
    # it just gets an accurate message instead of the misleading catch-all.
    reason = None
    if enriched == 0:
        if idmap_outcome != "ok" or not idmap:
            reason = "the Watchmode ID map fetch returned no usable rows"
        elif outcomes["stop"]:
            reason = "a Watchmode API call hit its stop condition (limit/auth) before resolving any title"
        elif candidates and outcomes["cached"] == candidates:
            reason = CACHED_REASON
        elif outcomes["cached"] or outcomes["no-id"]:
            reason = (f"nothing new to resolve — {outcomes['cached']} title(s) already cached, "
                      f"{outcomes['no-id']} with no Watchmode id")
        else:
            reason = "no candidate resolved a Watchmode id from the ID map"

    counts = {
        "candidate records considered": candidates,
        "titles enriched": enriched,
        "records written": enriched,
        "titles skipped for budget": budget["skipped"],
        "titles with no Watchmode id": outcomes["no-id"],
        "titles already cached": outcomes["cached"],
        "credits spent": credits_spent,
    }
    if ids_from:
        counts["ids requested"] = len(wanted_ids)
        counts["ids not found in catalogue"] = len(ids_not_found)
    for label, value in counts.items():
        print(f"{label}: {value}")
    if ids_not_found:
        print("ids not found in catalogue: " + ", ".join(str(i) for i in ids_not_found))
    print(f"early exit reason: {reason or 'n/a — titles were resolved'}")
    counts["early exit reason"] = reason
    return counts


def _exit_code_for(counts: dict) -> int:
    """CAS-862 AC3: a green run that writes nothing is the defect being fixed — the one
    exception is every candidate already being fresh, which is a legitimate no-op, not a
    failure."""
    if counts["titles enriched"] == 0 and counts["early exit reason"] != CACHED_REASON:
        return 1
    return 0


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--ids-from", dest="ids_from", default=None,
                         help="CAS-889: restrict the run to the tmdb_ids listed in this file "
                              "(one per line, `#` comments and blank lines ignored) instead of "
                              "walking the whole catalogue")
    args = parser.parse_args()

    # CAS-859: a missing key is not a per-title failure `_api_call` can degrade around — every
    # call this run would fail the same way. Check up front so a bad dispatch (trial key expired,
    # secret not configured) exits with a clear message instead of a traceback or a wasted run
    # against the real catalogue.
    if not os.environ.get("WATCHMODE_API_KEY"):
        print("WATCHMODE_API_KEY is not set — nothing to do, skipping the Watchmode fields backfill.")
        sys.exit(0)
    sys.exit(_exit_code_for(run(ids_from=args.ids_from)))
