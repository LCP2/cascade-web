"""CLI for the monitoring diff (spec 26771457 §5).

    python -m monitor --dry-run
    python -m monitor --dry-run --today monitor/fixtures/today.json \
                      --yesterday monitor/fixtures/yesterday.json --date 2026-07-16

By default: today = movies.json, yesterday = git show HEAD~1:movies.json, date = today.
Prints the transitions it found. This story does NO writes and NO network of any kind —
matching to users' Cascades, de-dupe, and email land in CAS-85 / CAS-86. ``--dry-run`` is
therefore currently the only behaviour; the flag exists so the daily Action can pass it
before those stories wire real writes behind it.
"""
from __future__ import annotations

import argparse
import datetime as _dt
import sys

from . import compute_transitions, DEFAULT_WEEKEND_N, MOMENTS
from .catalogue import load_catalogue_file, load_today, load_yesterday_from_git


def _parse_args(argv):
    p = argparse.ArgumentParser(prog="python -m monitor", description="Cascade daily monitoring diff.")
    p.add_argument("--dry-run", action="store_true",
                   help="Print transitions; make no writes and no network calls (currently the only mode).")
    p.add_argument("--today", metavar="PATH", help="Today's catalogue JSON (default: movies.json).")
    p.add_argument("--yesterday", metavar="PATH",
                   help="Yesterday's catalogue JSON (default: git show HEAD~1:movies.json).")
    p.add_argument("--date", metavar="YYYY-MM-DD", help="Override the run date (default: today).")
    p.add_argument("--weekend-n", type=int, default=DEFAULT_WEEKEND_N,
                   help=f"Days after opening that past_opening_weekend fires (default: {DEFAULT_WEEKEND_N}).")
    return p.parse_args(argv)


def main(argv=None) -> int:
    args = _parse_args(sys.argv[1:] if argv is None else argv)

    today_movies = load_catalogue_file(args.today) if args.today else load_today()
    prev_movies = load_catalogue_file(args.yesterday) if args.yesterday else load_yesterday_from_git()

    if args.date:
        run_date = _dt.date.fromisoformat(args.date)
    else:
        run_date = _dt.date.today()

    transitions = compute_transitions(prev_movies, today_movies, run_date, weekend_n=args.weekend_n)

    print(f"[monitor] run date {run_date.isoformat()} · "
          f"today {len(today_movies)} films · yesterday {len(prev_movies)} films · "
          f"weekend N={args.weekend_n}")
    if not transitions:
        print("[monitor] no transitions today.")
    else:
        counts = {mo: sum(1 for t in transitions if t.moment == mo) for mo in MOMENTS}
        print("[monitor] transitions: " + ", ".join(f"{mo}={counts[mo]}" for mo in MOMENTS))
        for t in transitions:
            print("  • " + t.summary())

    # Honest about what this stage does NOT do yet.
    print("[monitor] --dry-run: no DB writes, no emails, no network "
          "(matching + email arrive in CAS-85 / CAS-86).")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
