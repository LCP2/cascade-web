"""On-demand notification test harness — orchestration only (CAS-486/CAS-1052).

Builds a synthetic "yesterday"/"today" catalogue pair from the maintained fixture file
(tests/fixtures/notify-films.json) with exactly ONE scenario's transition applied, optionally
cleans up any earlier run's ledger rows for the fixture films first (so the same scenario can be
run again immediately), then writes the pair to disk and prints where they landed.

No new engine code: matching, digesting and delivery all stay in the real monitor pipeline
(compute_transitions/match/render_digest/send_via_resend/send_via_apns via `python -m monitor`),
so a test run exercises the exact same code path a real day does. This module's own job is
narrow — synthesise the two catalogue files, and delete the fixture rows a repeat run would
otherwise collide with.

CAS-1052: a fixture film matches an agent's real taste criteria only by luck (CAS-486's own
evidence: a real run against a real account's 6 agents produced zero alerts), so a green harness
run used to prove nothing. Two changes close that gap, both in this module:

  · arm  (the default mode below) also ticks --target-user's per-film Watch-it (film_watch) for
    the scenario's own window — matching.match_film_watches() honours that independently of any
    agent's criteria (CAS-484), so the run is guaranteed a match without touching the user's real
    agents. "announced" has no window-arrival moment (matching.MOMENT_TO_WINDOW never maps to it)
    so it is left exactly as before — matched only through a real agent, same as CAS-506.
  · --verify (a second invocation, AFTER `python -m monitor` has run) tears the temporary tick back
    down, counts what actually landed in the `notifications` ledger for --target-user (CAS-486's
    "the ledger IS the in-app delivery", so this number covers every channel that succeeded),
    reports the run's own email/push attempted-vs-delivered deltas (via the shared runstats.py file
    `python -m monitor` already writes) and the target user's registered push-token count, and
    fails the run (non-zero exit) when nothing was recorded — the exact silent-green failure mode
    this ticket exists to catch.

    python -m monitor.notify_test --scenario hits_cinema --target-user <uuid> \\
        --out-dir /tmp/notify-test
    python -m monitor --today /tmp/notify-test/today.json --yesterday /tmp/notify-test/yesterday.json \\
        --date <same date> --target-user <uuid>
    python -m monitor.notify_test --scenario hits_cinema --target-user <uuid> \\
        --out-dir /tmp/notify-test --verify
"""
from __future__ import annotations

import argparse
import datetime as _dt
import json
import os
import re
import sys

import runstats

from .matching import MOMENT_TO_WINDOW
from .store import FIXTURE_ID_MAX, FIXTURE_ID_MIN, store_from_env

_REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEFAULT_FIXTURES = os.path.join(_REPO_ROOT, "tests", "fixtures", "notify-films.json")

FIXTURE_MARKER = "TEST FIXTURE — not a real title"
SCENARIOS = ("announced", "hits_cinema", "hits_pvod", "hits_rent", "hits_stream")

# CAS-1052: the snapshot file --verify diffs against, taken by the arm phase right before
# `python -m monitor` runs — both live in --out-dir, the same directory the two monitor.notify_test
# invocations and the intervening `python -m monitor` call already share within one workflow run.
RUN_STATS_SNAPSHOT_NAME = "run_stats_before.json"

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
        "poster": None,
        "synopsis": f.get("synopsis", FIXTURE_MARKER),
        "cinema_date": None,   # never a real date — keeps past_opening_weekend/opens_soon silent
        "status": list(status),
        "offers": list(offers),
        "window_dates": {s: run_date for s in status},
        # CAS-825/CAS-1015: admission is asked of the real engine now, which reads these beyond
        # taste criteria alone — language for the account taste baseline, popularity/wm_user_rating/
        # wm_critic_score/wm_popularity_percentile for the Cascade score (CAS-919/920 moved scoring
        # onto Watchmode's own fields; imdb_rating/rt_critic are dead on the engine side and were
        # silently leaving every fixture film unscored). Carried straight from the fixture film so a
        # harness scenario keeps producing a real, scoreable film rather than one the score gate
        # holds back regardless.
        "language": f.get("language"),
        "popularity": f.get("popularity"),
        "wm_user_rating": f.get("wm_user_rating"),
        "wm_critic_score": f.get("wm_critic_score"),
        "wm_popularity_percentile": f.get("wm_popularity_percentile"),
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


def cleanup(films: list, store=None) -> int | None:
    """DELETE any existing `notifications` ledger rows for the fixture films (real Supabase only —
    scoped strictly to the reserved fixture range inside the store method itself). Returns the row
    count removed, or None if no Supabase credentials are set (fails soft: a missing secret here
    must not block the catalogue files from being written). `store` lets the arm phase share the
    one store_from_env() call it also needs for arm_watch(); omit it to resolve one here."""
    store = store if store is not None else store_from_env()
    if store is None:
        print("[notify_test] SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY not set — skipping cleanup.")
        return None
    ids = [f["tmdb_id"] for f in films]
    removed = store.delete_notifications_for_movie_ids(ids)
    print(f"[notify_test] cleanup: removed {removed} existing notification row(s) for "
          f"{len(ids)} fixture film id(s) {ids}.")
    return removed


def _fixture_film_for_scenario(films: list, scenario: str) -> dict:
    for f in films:
        if f.get("scenario") == scenario:
            return f
    raise ValueError(f"no fixture film has scenario={scenario!r}")


def arm_watch(store, target_user: str, films: list, scenario: str) -> None:
    """CAS-1052: guarantee a match for --target-user's scenario without touching their real
    agents — tick the scenario's own window on its fixture film via a temporary film_watch row,
    which matching.match_film_watches() honours independently of any cascade's own criteria
    (CAS-484). "announced" has no window-arrival moment (MOMENT_TO_WINDOW never maps to it), so it
    is left to fire — or not — through a real cascade's own criteria exactly as before this ticket;
    calling this for that scenario is a deliberate no-op."""
    window = MOMENT_TO_WINDOW.get(scenario)
    if window is None:
        return
    film = _fixture_film_for_scenario(films, scenario)
    store.upsert_film_watch(target_user, film["tmdb_id"], window)
    print(f"[notify_test] armed a temporary Watch-it tick: user={target_user} "
          f"movie={film['tmdb_id']} window={window!r} (scenario={scenario}) — guarantees a match "
          "independent of this user's real agents.")


def _snapshot_run_stats(out_dir: str) -> None:
    """CAS-1052: today's runstats.py totals, taken right before `python -m monitor` runs, so
    --verify can isolate THIS run's own email/push attempted/delivered deltas from whatever a same-
    day daily.yml run already committed into state/run_stats.json."""
    os.makedirs(out_dir, exist_ok=True)
    with open(os.path.join(out_dir, RUN_STATS_SNAPSHOT_NAME), "w", encoding="utf-8") as fh:
        json.dump(runstats.load(), fh)


def _section_delta(before: dict, after: dict, section: str) -> dict:
    """{attempted, delivered, errors} `after` minus `before` for one runstats.py section. Treats
    `before` as empty if the two don't share a `date` — runstats.py resets its whole file the
    moment the date rolls over, so a stale snapshot from the day before would otherwise read as a
    huge (and wrong) negative delta rather than "nothing to subtract"."""
    if not isinstance(before, dict) or before.get("date") != (after or {}).get("date"):
        before = {}
    b = before.get(section) or {}
    a = (after or {}).get(section) or {}
    return {k: a.get(k, 0) - b.get(k, 0) for k in ("attempted", "delivered", "errors")}


def report_and_verify(store, target_user: str, films: list, before_stats: dict, after_stats: dict) -> tuple:
    """CAS-1052: the harness's proof step. Deletes this run's fixture-range ledger rows (their
    count IS "in-app rows written" — CAS-486's ledger doubles as the in-app delivery for every
    channel that succeeded, see matching.Hit.notification_row) and the temporary Watch-it tick
    arm_watch() set, reports the run's email/push attempted/delivered deltas and the target user's
    registered push-token count, and returns (returncode, message) — a tuple rather than exiting
    directly, so this is unit-testable without a process boundary.

    A `removed` count of zero is the ONLY failure signal: it means no channel wrote a ledger row for
    `target_user` this run — exactly the silent-green failure this ticket exists to catch. The
    run_stats deltas and push-token count are reported for visibility (so "no device registered" or
    "email never even attempted" is legible), not as a second gate.
    """
    ids = [f["tmdb_id"] for f in films]
    removed = store.delete_notifications_for_movie_ids(ids)
    watch_removed = store.delete_film_watch_for_movie_ids(ids)
    push_tokens = len(store.fetch_push_tokens().get(str(target_user)) or ())
    email_delta = _section_delta(before_stats, after_stats, "email")
    push_delta = _section_delta(before_stats, after_stats, "push")

    message = (
        f"[notify_test] verify target_user={target_user}: in-app rows written {removed}; "
        f"email attempted {email_delta['attempted']}/delivered {email_delta['delivered']}; "
        f"push attempted {push_delta['attempted']}/delivered {push_delta['delivered']}; "
        f"{push_tokens} registered push token(s) for this user; cleaned up {watch_removed} "
        "temporary Watch-it row(s)."
    )
    if removed == 0:
        return 1, message + (" FAILED: 0 alert(s) were recorded for this user — the harness "
                              "cannot prove delivery.")
    return 0, message


def _parse_args(argv):
    p = argparse.ArgumentParser(prog="python -m monitor.notify_test",
                                 description="CAS-486/CAS-1052 notification test harness — builds "
                                             "the fixture yesterday/today pair, arms a guaranteed "
                                             "match, and (with --verify, after `python -m monitor` "
                                             "has run) proves delivery and tears the tick back down.")
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
    p.add_argument("--verify", action="store_true",
                   help="Run AFTER `python -m monitor`: report per-channel delivery counts for "
                        "--target-user and the fixture films, fail (non-zero exit) if nothing was "
                        "delivered, then delete the temporary film_watch row and ledger rows this "
                        "harness run created.")
    return p.parse_args(argv)


def _run_verify(args, target_user: str, films: list) -> int:
    store = store_from_env()
    if store is None:
        raise SystemExit("[notify_test] --verify needs real SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY "
                          "— the harness cannot prove anything without the real pipeline.")
    before_path = os.path.join(args.out_dir, RUN_STATS_SNAPSHOT_NAME)
    before_stats = _load_json(before_path) if os.path.exists(before_path) else {}
    after_stats = runstats.load()
    rc, message = report_and_verify(store, target_user, films, before_stats, after_stats)
    print(message)
    return rc


def _load_json(path: str):
    with open(path, encoding="utf-8") as fh:
        return json.load(fh)


def _run_arm(args, target_user: str, films: list) -> int:
    run_date = args.date or _dt.date.today().isoformat()
    yesterday, today = build_catalogues(films, args.scenario, run_date)

    os.makedirs(args.out_dir, exist_ok=True)
    y_path = os.path.join(args.out_dir, "yesterday.json")
    t_path = os.path.join(args.out_dir, "today.json")
    _write_catalogue(y_path, yesterday, run_date)
    _write_catalogue(t_path, today, run_date)
    print(f"[notify_test] scenario={args.scenario} target_user={target_user} date={run_date} — "
          f"wrote {len(yesterday)} yesterday film(s) -> {y_path}, {len(today)} today film(s) -> {t_path}.")

    store = store_from_env()
    if args.cleanup:
        cleanup(films, store)
    else:
        print("[notify_test] --no-cleanup: leaving any existing ledger rows for the fixture films in place.")

    if store is None:
        print("[notify_test] SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY not set — skipping the "
              "guaranteed-match Watch-it tick; the next `python -m monitor` step will only match "
              "this user's REAL agents, exactly as before CAS-1052.")
    else:
        arm_watch(store, target_user, films, args.scenario)

    _snapshot_run_stats(args.out_dir)

    print(f"[notify_test] next: python -m monitor --today {t_path} --yesterday {y_path} "
          f"--date {run_date} --target-user {target_user}")
    return 0


def main(argv=None) -> int:
    args = _parse_args(sys.argv[1:] if argv is None else argv)
    target_user = validate_target_user(args.target_user)
    films = load_fixture_films(args.fixtures)

    if args.verify:
        return _run_verify(args, target_user, films)
    return _run_arm(args, target_user, films)


if __name__ == "__main__":
    raise SystemExit(main())
