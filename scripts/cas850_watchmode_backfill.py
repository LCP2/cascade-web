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
import json
import os
import sys

import poc_pipeline as pp

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


def run(catalogue_path=None, max_credits=None):
    catalogue_path = catalogue_path or CATALOGUE
    max_credits = MAX_CREDITS if max_credits is None else max_credits

    data, movies = load_catalogue(catalogue_path)

    idmap, outcome = pp._api_call("Watchmode ID map", pp._fetch_watchmode_idmap)
    wm_idmap = pp._invert_watchmode_idmap(idmap) if outcome == "ok" and idmap else {}

    budget = {"remaining": max_credits, "skipped": 0}
    enriched = no_id = 0
    for movie in movies:
        result = pp.enrich_watchmode_fields(movie, wm_idmap, budget)
        if result == "ok":
            enriched += 1
        elif result == "no-id":
            no_id += 1

    save_catalogue(catalogue_path, data)

    counts = {
        "titles enriched": enriched,
        "titles skipped for budget": budget["skipped"],
        "titles with no Watchmode id": no_id,
        "credits spent": max_credits - budget["remaining"],
    }
    for label, value in counts.items():
        print(f"{label}: {value}")
    return counts


if __name__ == "__main__":
    run()
    sys.exit(0)
