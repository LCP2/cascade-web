"""CLI for the monitoring pipeline (spec 26771457 §5).

    # diff only, against the live catalogue:
    python -m monitor --dry-run

    # full diff -> match -> de-dupe, all against fixtures (deterministic, no keys):
    python -m monitor --dry-run \
        --today monitor/fixtures/today.json --yesterday monitor/fixtures/yesterday.json \
        --date 2026-07-16 --cascades monitor/fixtures/cascades.json \
        --notifications monitor/fixtures/notifications.json

Default catalogue: today = movies.json, yesterday = git show HEAD~1:movies.json.
Default Cascade source: Supabase via the service_role key (SUPABASE_URL /
SUPABASE_SERVICE_ROLE_KEY) — read-only here; the ledger write only happens off --dry-run.

Stages:
  1. diff today vs yesterday  -> transitions            (CAS-84)
  2. match transitions to active Cascades, de-dupe against `notifications`, group per user (CAS-85)
  3. [--dry-run] print each user's hit list, write NOTHING. Off --dry-run, write the ledger rows.
     (Sending the email is CAS-86; wiring the schedule + secrets is CAS-87.)
"""
from __future__ import annotations

import argparse
import datetime as _dt
import json
import sys

from . import compute_transitions, DEFAULT_WEEKEND_N, MOMENTS, match, notification_rows
from .catalogue import load_catalogue_file, load_today, load_yesterday_from_git
from .store import InMemoryStore, store_from_env


def _parse_args(argv):
    p = argparse.ArgumentParser(prog="python -m monitor", description="Cascade daily monitoring pipeline.")
    p.add_argument("--dry-run", action="store_true",
                   help="Print the per-user hit list; make no writes and no email.")
    p.add_argument("--today", metavar="PATH", help="Today's catalogue JSON (default: movies.json).")
    p.add_argument("--yesterday", metavar="PATH",
                   help="Yesterday's catalogue JSON (default: git show HEAD~1:movies.json).")
    p.add_argument("--date", metavar="YYYY-MM-DD", help="Override the run date (default: today).")
    p.add_argument("--weekend-n", type=int, default=DEFAULT_WEEKEND_N,
                   help=f"Days after opening that past_opening_weekend fires (default: {DEFAULT_WEEKEND_N}).")
    p.add_argument("--cascades", metavar="PATH",
                   help="Active-cascades JSON to match against (default: Supabase via service_role).")
    p.add_argument("--notifications", metavar="PATH",
                   help="Existing notifications JSON for de-dupe (default: Supabase).")
    return p.parse_args(argv)


def _load_json(path):
    with open(path, encoding="utf-8") as fh:
        return json.load(fh)


def main(argv=None) -> int:
    args = _parse_args(sys.argv[1:] if argv is None else argv)

    today_movies = load_catalogue_file(args.today) if args.today else load_today()
    prev_movies = load_catalogue_file(args.yesterday) if args.yesterday else load_yesterday_from_git()
    run_date = _dt.date.fromisoformat(args.date) if args.date else _dt.date.today()

    transitions = compute_transitions(prev_movies, today_movies, run_date, weekend_n=args.weekend_n)

    print(f"[monitor] run date {run_date.isoformat()} · "
          f"today {len(today_movies)} films · yesterday {len(prev_movies)} films · N={args.weekend_n}")
    counts = {mo: sum(1 for t in transitions if t.moment == mo) for mo in MOMENTS}
    print("[monitor] transitions: " + ", ".join(f"{mo}={counts[mo]}" for mo in MOMENTS))
    for t in transitions:
        print("    • " + t.summary())

    # --- pick the Cascade / notifications source ---
    if args.cascades is not None:
        store = InMemoryStore(cascades=_load_json(args.cascades),
                              notifications=_load_json(args.notifications) if args.notifications else [])
        source = "fixtures"
    else:
        store = store_from_env()
        source = "supabase(service_role)"
        if store is None:
            print("[monitor] no SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY and no --cascades — "
                  "skipping match (diff only). Set the secrets or pass --cascades.")
            print("[monitor] --dry-run: no DB writes, no emails.")
            return 0

    cascades = store.fetch_active_cascades()
    already = store.fetch_notification_keys()
    by_user = match(cascades, transitions, already=already, catalogue=today_movies)
    rows = notification_rows(by_user)

    print(f"[monitor] matching against {len(cascades)} active cascade(s) from {source}; "
          f"{len(already)} already-sent ledger entries.")
    if not by_user:
        print("[monitor] no new alerts for anyone (all matches already sent, or nothing matched).")
    else:
        for user_id, hits in by_user.items():
            print(f"[monitor] user {user_id}: {len(hits)} new alert(s)")
            for h in hits:
                print(f"    • [{h.cascade_name}] {h.transition.summary()}")

    if args.dry_run:
        print(f"[monitor] --dry-run: would write {len(rows)} notification row(s); "
              "writing NOTHING, sending NOTHING (email is CAS-86).")
    else:
        written = store.insert_notifications(rows)
        print(f"[monitor] wrote {written} notification row(s) to the ledger. "
              "(Email delivery is CAS-86.)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
