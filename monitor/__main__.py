"""CLI for the monitoring pipeline (spec 26771457 §5-§6).

    # diff only, against the live catalogue:
    python -m monitor --dry-run

    # full diff -> match -> de-dupe -> render digest, against fixtures (deterministic, no keys):
    python -m monitor --dry-run \
        --today monitor/fixtures/today.json --yesterday monitor/fixtures/yesterday.json \
        --date 2026-07-16 --cascades monitor/fixtures/cascades.json \
        --notifications monitor/fixtures/notifications.json --emails monitor/fixtures/emails.json

Default catalogue: today = movies.json, yesterday = git show HEAD~1:movies.json.
Default Cascade source: Supabase via the service_role key.

Stages:
  1. diff today vs yesterday  -> transitions                                   (CAS-84)
  2. match to active Cascades, de-dupe against `notifications`, group per user (CAS-85)
  3. render ONE consolidated digest per user and email it via Resend           (CAS-86)
     --dry-run: print the digest HTML, send nothing, write nothing.
     off --dry-run: send the email, then write that user's notifications rows (send-before-ledger,
     so a failed send is retried next run rather than silently marked done).
"""
from __future__ import annotations

import argparse
import datetime as _dt
import json
import sys

from . import (compute_transitions, DEFAULT_WEEKEND_N, MOMENTS, match, notification_rows,
               render_digest, send_via_resend)
from .catalogue import load_catalogue_file, load_today, load_yesterday_from_git
from .store import InMemoryStore, store_from_env


def _parse_args(argv):
    p = argparse.ArgumentParser(prog="python -m monitor", description="Cascade daily monitoring pipeline.")
    p.add_argument("--dry-run", action="store_true",
                   help="Print the digest HTML; send no email and write nothing.")
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
    p.add_argument("--emails", metavar="PATH",
                   help="user_id -> email JSON map (dry-run/fixtures; default: Supabase auth).")
    p.add_argument("--print-html", action="store_true",
                   help="With --dry-run, print the full digest HTML (default: subject + text preview).")
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
    print(f"[monitor] run date {run_date.isoformat()} · today {len(today_movies)} films · "
          f"yesterday {len(prev_movies)} films · N={args.weekend_n}")
    counts = {mo: sum(1 for t in transitions if t.moment == mo) for mo in MOMENTS}
    print("[monitor] transitions: " + ", ".join(f"{mo}={counts[mo]}" for mo in MOMENTS))
    for t in transitions:
        print("    • " + t.summary())

    # --- Cascade / notifications / email source ---
    if args.cascades is not None:
        store = InMemoryStore(cascades=_load_json(args.cascades),
                              notifications=_load_json(args.notifications) if args.notifications else [],
                              emails=_load_json(args.emails) if args.emails else {})
        source = "fixtures"
    else:
        store = store_from_env()
        source = "supabase(service_role)"
        if store is None:
            print("[monitor] no SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY and no --cascades — "
                  "skipping match/email (diff only).")
            return 0

    cascades = store.fetch_active_cascades()
    already = store.fetch_notification_keys()
    by_user = match(cascades, transitions, already=already, catalogue=today_movies)

    print(f"[monitor] matching against {len(cascades)} active cascade(s) from {source}; "
          f"{len(already)} already-sent ledger entries.")
    if not by_user:
        print("[monitor] no new alerts for anyone — no email will be sent.")
        return 0

    # --- one consolidated digest per user ---
    sent, written_total = 0, 0
    for user_id, hits in by_user.items():
        digest = render_digest(hits)
        email = store.fetch_user_email(user_id)
        print(f"[monitor] user {user_id} ({email or 'email unknown'}): "
              f"{len(hits)} alert(s) — subject: {digest['subject']!r}")
        for h in hits:
            print(f"    • [{h.cascade_name}] {h.transition.summary()}")

        if args.dry_run:
            if args.print_html:
                print("---- digest HTML ----\n" + digest["html"] + "\n---- end HTML ----")
            else:
                print("    digest preview:\n      " + digest["text"].replace("\n", "\n      "))
            continue

        if not email:
            print(f"[monitor] no email for {user_id} — skipping (ledger not written, will retry).")
            continue
        try:
            send_via_resend(email, digest["subject"], digest["html"], digest["text"])
        except Exception as err:  # noqa: BLE001 — never let one bad send abort the run
            print(f"[monitor] send failed for {user_id}: {err} — ledger not written, will retry.")
            continue
        written_total += store.insert_notifications(notification_rows({user_id: hits}))
        sent += 1

    if args.dry_run:
        would = sum(len(h) for h in by_user.values())
        print(f"[monitor] --dry-run: rendered {len(by_user)} digest(s) covering {would} alert(s); "
              "sent NOTHING, wrote NOTHING.")
    else:
        print(f"[monitor] sent {sent} digest(s); wrote {written_total} notification row(s).")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
