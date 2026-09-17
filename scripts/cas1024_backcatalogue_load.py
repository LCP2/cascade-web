#!/usr/bin/env python3
"""CAS-1024: one-shot manual back-catalogue load — watchmode-backfill.yml's target=backcatalogue
mode. Probes CAS-989's enumerated 2015-2022 back catalogue (state/wm_backcatalogue_candidates.json,
folded into state/candidates.json by CAS-991's merge_backcatalogue_candidates) against the SAME
scoreability probe and publication test the nightly CAS-986 path uses — poc_pipeline.py's
run_backcatalogue_probe (enrich_watchmode_fields per title) and scoreable_ids/select_publishable
(the 60 floor via scripts/scoreable_shim.mjs). Never a second scoring implementation.

Lee's decision (2026-09-17): load the whole back catalogue now, in one manual run, rather than
pace it nightly — this path is deliberately NOT limited by WM_RUN_MAX_CREDITS or the CAS-987/
CAS-994 cycle-paced run allowance every other credit-costing path goes through. `max_credits`
(WM_BACKCAT_MAX_CREDITS) is the dispatch's own explicit spend decision. Nightly upkeep is
unchanged and untouched by this script.

WATCHMODE_API_KEY is a GitHub secret only (CAS-579/767) — this only ever runs inside
watchmode-backfill.yml, never on a developer machine, same constraint as
scripts/cas850_watchmode_backfill.py.

Idempotent/resumable: every candidate probed here (pass or fail) is marked in candidates.json's
own outcome/last_probed/probe_count, so a second dispatch only probes what's left.
"""
import argparse
import datetime
import json
import os
import sys

_REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _REPO_ROOT not in sys.path:
    sys.path.insert(0, _REPO_ROOT)

import poc_pipeline as pp  # noqa: E402


def _load_backcat_tmdb_ids(path=None) -> set:
    """The universe of tmdb_ids this mode is allowed to probe — CAS-989's own enumerate output,
    read directly (not inferred from candidates.json, which also carries every other discovery
    source's candidates)."""
    path = path or pp.WM_BACKCATALOGUE_CANDIDATES_FILE
    if not os.path.exists(path):
        return set()
    rows = json.load(open(path, encoding="utf-8"))
    return {row["tmdb_id"] for row in rows if row.get("tmdb_id") is not None}


def _fetch_remaining_credits():
    """Watchmode's live /status figure (quota - quotaUsed) — a 0-credit call. None on any failed
    fetch, so a transient status hiccup does not by itself stop the run (probing itself already
    fails/stops safely through _api_call's own budget/back-off wrapper)."""
    status, outcome = pp._api_call("Watchmode status", pp._fetch_watchmode_status)
    if outcome != "ok" or not status:
        return None
    return status.get("quota", 0) - status.get("quotaUsed", 0)


def _load_movies(path):
    with open(path, encoding="utf-8") as fh:
        data = json.load(fh)
    return data, data.get("movies", [])


def _save_movies(path, data):
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(data, fh, ensure_ascii=False, indent=2)
        fh.write("\n")


def run(max_credits: int, today: datetime.date | None = None) -> dict:
    today = today or datetime.date.today()
    today_iso = today.isoformat()

    candidates = pp.load_candidates()
    pp.merge_backcatalogue_candidates(candidates, today_iso)
    backcat_ids = _load_backcat_tmdb_ids()

    idmap, idmap_outcome = pp._api_call("Watchmode ID map", pp._fetch_watchmode_idmap)
    if idmap_outcome != "ok" or not idmap:
        print("[backcatalogue] no usable Watchmode ID map this run — nothing probed.")
        probe_result = {"ok": 0, "cached": 0, "no-id": 0, "skip": 0, "stop": 0, "probed": 0,
                        "no_score": 0, "spent": 0, "stopped_on_floor": False}
    else:
        wm_idmap = pp._invert_watchmode_idmap(idmap)
        probe_result = pp.run_backcatalogue_probe(
            candidates, today, max_credits, wm_idmap, backcat_ids, _fetch_remaining_credits,
            pp.WM_BACKCAT_UPKEEP_FLOOR)

    pp.save_candidates(candidates)

    data, movies = _load_movies(pp.OUTPUT_FILE)
    previously_published_ids = {m["tmdb_id"] for m in movies}
    try:
        engine_ids = pp.scoreable_ids(list(candidates.values()), floor=pp.WM_PUBLISH_FLOOR)
        engine_ok = True
    except Exception as err:  # noqa: BLE001 — a broken engine call must never wipe the catalogue
        print(f"[backcatalogue] scoreability engine call failed ({err}) — publishing the "
              "previously-published set unchanged this run.")
        engine_ids = set(previously_published_ids)
        engine_ok = False

    held_ids = pp.load_user_held_ids()
    published_records, pub_stats = pp.select_publishable(
        candidates, engine_ids, previously_published_ids, held_ids, pp.CATALOGUE_TARGET)
    data["movies"] = published_records
    _save_movies(pp.OUTPUT_FILE, data)

    remaining = _fetch_remaining_credits()
    remaining_label = remaining if remaining is not None else "unknown"
    print(f"[backcatalogue] probed {probe_result['probed']}, published {pub_stats['promoted']}, "
          f"no_score {probe_result['no_score']}, credits spent {probe_result['spent']}, "
          f"remaining {remaining_label}")

    return {**probe_result, "engine_ok": engine_ok, **pub_stats, "remaining_credits": remaining}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--max-credits", dest="max_credits", type=int, default=None,
                         help="Credits to spend this run — defaults to WM_BACKCAT_MAX_CREDITS.")
    args = parser.parse_args()

    if not os.environ.get("WATCHMODE_API_KEY"):
        print("WATCHMODE_API_KEY is not set — nothing to do, skipping the back-catalogue load.")
        sys.exit(0)

    max_credits = args.max_credits
    if max_credits is None:
        max_credits = int(os.environ.get("WM_BACKCAT_MAX_CREDITS", "0") or 0)
    if max_credits <= 0:
        print("[backcatalogue] max_credits is 0 — nothing to do.")
        sys.exit(0)

    run(max_credits)
