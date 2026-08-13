"""On-demand notification test harness — orchestration only (CAS-486).

Builds a synthetic "yesterday"/"today" catalogue pair from the maintained fixture file
(tests/fixtures/notify-films.json) with exactly ONE scenario's transition applied, optionally
cleans up any earlier run's ledger rows for the fixture films first (so the same scenario can be
run again immediately), then writes the pair to disk and prints where they landed.

No new engine code: matching, digesting and delivery all stay in the real monitor pipeline
(compute_transitions/match/render_digest/send_via_resend/send_via_apns via `python -m monitor`),
so a test run exercises the exact same code path a real day does. This module's own job is
narrow — synthesise the two catalogue files, and delete the fixture rows a repeat run would
otherwise collide with.

    python -m monitor.notify_test --scenario hits_cinema --target-user <uuid> \\
        --out-dir /tmp/notify-test
    python -m monitor --today /tmp/notify-test/today.json --yesterday /tmp/notify-test/yesterday.json \\
        --date <same date> --target-user <uuid>
"""
from __future__ import annotations

import argparse
import datetime as _dt
import json
import os
import re
import sys

from .store import FIXTURE_ID_MAX, FIXTURE_ID_MIN, store_from_env

_REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEFAULT_FIXTURES = os.path.join(_REPO_ROOT, "tests", "fixtures", "notify-films.json")

FIXTURE_MARKER = "TEST FIXTURE — not a real title"
SCENARIOS = ("announced", "hits_cinema", "hits_pvod", "hits_rent", "hits_stream")

_UUID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", re.IGNORECASE)


def validate_target_user(value) -> str:
    """Fail closed (CAS-486 AC): no default that resolves to "everyone" — an unset or
    unrecognised value must run nothing rather than deliver broadly."""
    if not value or not _UUID_RE.match(str(value).strip()):
        raise SystemExit(f"[notify_test] --target-user {value!r} is not a plausible Supabase "
                          "user id (expected a uuid) — refusing to run against 'everyone'.")
    return str(value).strip()


def load_fixture_films(path: str = DEFAULT_FIXTURES) -> list:
    with open(path, encoding="utf-8") as fh:
        data = json.load(fh)
    films = data.get("films", [])
    for f in films:
        tid = f.get("tmdb_id")
        try:
            n = int(tid)
        except (TypeError, ValueError):
            n = None
        if n is None or not (FIXTURE_ID_MIN <= n <= FIXTURE_ID_MAX):
            raise ValueError(f"fixture film {f.get('title')!r} has tmdb_id {tid!r} outside the "
                              f"reserved fixture range {FIXTURE_ID_MIN}-{FIXTURE_ID_MAX} — refusing "
                              "to load this fixture file.")
        if f.get("director") != FIXTURE_MARKER:
            raise ValueError(f"fixture film {f.get('title')!r} is missing the fixture marker "
                              f"director={FIXTURE_MARKER!r} — refusing to load this fixture file.")
    return films


def _movie_record(f: dict, status: list, offers: list, run_date: str) -> dict:
    return {
        "tmdb_id": f["tmdb_id"],
        "title": f["title"],
        "director": f["director"],
        "genres": f.get("genres", []),
        "age_rating": f.get("age_rating", "M"),
        "imdb_rating": f.get("imdb_rating"),
        "poster": None,
        "synopsis": f.get("synopsis", FIXTURE_MARKER),
        "cinema_date": None,   # never a real date — keeps past_opening_weekend/opens_soon silent
        "status": list(status),
        "offers": list(offers),
        "window_dates": {s: run_date for s in status},
    }


def build_catalogues(films: list, scenario: str, run_date: str):
    """-> (yesterday_movies, today_movies). Only `scenario`'s film actually transitions; every
    other fixture film holds its own today-state on both days, so it never fires on its own."""
    if scenario not in {f.get("scenario") for f in films}:
        raise ValueError(f"no fixture film has scenario={scenario!r} (have: "
                          f"{sorted({f.get('scenario') for f in films})})")
    yesterday, today = [], []
    for f in films:
        today.append(_movie_record(f, f["today_status"], f.get("today_offers", []), run_date))
        if f.get("scenario") == scenario:
            if f.get("yesterday_present", True):
                yesterday.append(_movie_record(f, f["yesterday_status"], f.get("yesterday_offers", []),
                                                run_date))
            # else: absent from yesterday entirely — the "announced" case.
        else:
            yesterday.append(_movie_record(f, f["today_status"], f.get("today_offers", []), run_date))
    return yesterday, today


def _write_catalogue(path: str, movies: list, run_date: str):
    with open(path, "w", encoding="utf-8") as fh:
        json.dump({"generated": run_date, "region": "AU", "currency": "AUD", "live": False,
                   "movies": movies}, fh)


def cleanup(films: list) -> int | None:
    """DELETE any existing `notifications` ledger rows for the fixture films (real Supabase only —
    scoped strictly to the reserved fixture range inside the store method itself). Returns the row
    count removed, or None if no Supabase credentials are set (fails soft: a missing secret here
    must not block the catalogue files from being written)."""
    store = store_from_env()
    if store is None:
        print("[notify_test] SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY not set — skipping cleanup.")
        return None
    ids = [f["tmdb_id"] for f in films]
    removed = store.delete_notifications_for_movie_ids(ids)
    print(f"[notify_test] cleanup: removed {removed} existing notification row(s) for "
          f"{len(ids)} fixture film id(s) {ids}.")
    return removed


def _parse_args(argv):
    p = argparse.ArgumentParser(prog="python -m monitor.notify_test",
                                 description="CAS-486 notification test harness — builds the "
                                             "fixture yesterday/today pair and (by default) cleans "
                                             "up prior ledger rows for the fixture films.")
    p.add_argument("--scenario", required=True, choices=SCENARIOS)
    p.add_argument("--target-user", required=True, metavar="USER_ID",
                   help="Supabase user_id (uuid) to deliver to. Required — fails closed on an "
                        "empty/unrecognised value rather than running against 'everyone'.")
    p.add_argument("--out-dir", required=True, help="Directory to write yesterday.json/today.json into.")
    p.add_argument("--fixtures", default=DEFAULT_FIXTURES, metavar="PATH")
    p.add_argument("--date", metavar="YYYY-MM-DD", help="Run date (default: today, UTC).")
    p.add_argument("--cleanup", dest="cleanup", action="store_true", default=True,
                   help="Delete prior ledger rows for the fixture films first (default: on).")
    p.add_argument("--no-cleanup", dest="cleanup", action="store_false",
                   help="Skip cleanup — leaves any earlier run's ledger rows in place.")
    return p.parse_args(argv)


def main(argv=None) -> int:
    args = _parse_args(sys.argv[1:] if argv is None else argv)
    target_user = validate_target_user(args.target_user)
    run_date = args.date or _dt.date.today().isoformat()

    films = load_fixture_films(args.fixtures)
    yesterday, today = build_catalogues(films, args.scenario, run_date)

    os.makedirs(args.out_dir, exist_ok=True)
    y_path = os.path.join(args.out_dir, "yesterday.json")
    t_path = os.path.join(args.out_dir, "today.json")
    _write_catalogue(y_path, yesterday, run_date)
    _write_catalogue(t_path, today, run_date)
    print(f"[notify_test] scenario={args.scenario} target_user={target_user} date={run_date} — "
          f"wrote {len(yesterday)} yesterday film(s) -> {y_path}, {len(today)} today film(s) -> {t_path}.")

    if args.cleanup:
        cleanup(films)
    else:
        print("[notify_test] --no-cleanup: leaving any existing ledger rows for the fixture films in place.")

    print(f"[notify_test] next: python -m monitor --today {t_path} --yesterday {y_path} "
          f"--date {run_date} --target-user {target_user}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
