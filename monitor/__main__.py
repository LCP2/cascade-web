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
  1. diff today vs yesterday  -> transitions                                       (CAS-84)
  2. match per-film Watch-it ticks, de-dupe against `notifications`, group per user
     (CAS-85; agent-level Cascade matching no longer feeds delivery — CAS-502)
  3. render ONE consolidated digest per user and email it via Resend               (CAS-86)
     --dry-run: print the digest HTML, send nothing, write nothing.
     off --dry-run: send the email, then write that user's notifications rows (send-before-ledger,
     so a failed send is retried next run rather than silently marked done).
"""
from __future__ import annotations

import argparse
import datetime as _dt
import json
import sys

from . import (compute_transitions, DEFAULT_WEEKEND_N, MOMENTS, notification_rows,
               render_digest, send_via_resend, excluded_moments,
               prefs_for, excludes_from_prefs, delivery_plan, send_via_apns, push_copy,
               match_film_watches)
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
    p.add_argument("--picks", metavar="PATH",
                   help="Personal Pick overrides JSON: [{user_id, movie_id, state}] where state "
                        "'off' suppresses that film for that user (CAS-100). Overrides the "
                        "`film_picks` table, which is the default source since CAS-185.")
    p.add_argument("--prefs", metavar="PATH",
                   help="Delivery preferences JSON: {user_id: {in_app, email_on, email_address, "
                        "excluded_moments}} (CAS-185). Overrides the `notify_prefs` table.")
    p.add_argument("--watches", metavar="PATH",
                   help="Per-film Watch-it ticks JSON: [{user_id, movie_id, windows}] (CAS-484). "
                        "Overrides the `film_watch` table, which is the default source.")
    p.add_argument("--excluded", metavar="PATH",
                   help="Global alert-type excludes JSON: {user_id: [moment, ...]} (or a list of "
                        "{user_id, excluded_moments}). A muted TYPE never fires for that user, "
                        "whatever their Cascades say (CAS-103 AC4). Since CAS-185 this also comes "
                        "from notify_prefs.excluded_moments; this flag adds to that.")
    p.add_argument("--print-html", action="store_true",
                   help="With --dry-run, print the full digest HTML (default: subject + text preview).")
    p.add_argument("--target-user", metavar="USER_ID",
                   help="CAS-486 test-harness safety valve: restrict matching to exactly this "
                        "user_id — every other user's cascades and per-film watches are dropped "
                        "before matching, so a scoped test run can never spray real users. Unused "
                        "by the daily job.")
    return p.parse_args(argv)


def _load_json(path):
    with open(path, encoding="utf-8") as fh:
        return json.load(fh)


def _store_call(store, name, default):
    """Call an optional store method. A store that predates CAS-185 (or a hand-rolled one in a
    test) simply does not have these, and a monitor run must not die over a preference table —
    the honest fallback is "nobody has expressed a preference", which is what the defaults say."""
    fn = getattr(store, name, None)
    if not callable(fn):
        return default
    try:
        return fn()
    except Exception as err:   # noqa: BLE001 - a missing table must not abort the whole run
        print(f"[monitor] could not read {name}: {err} - carrying on with defaults.")
        return default


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
                              emails=_load_json(args.emails) if args.emails else {},
                              prefs=_load_json(args.prefs) if args.prefs else {},
                              picks=_load_json(args.picks) if args.picks else [],
                              watches=_load_json(args.watches) if args.watches else [])
        source = "fixtures"
    else:
        store = store_from_env()
        source = "supabase(service_role)"
        if store is None:
            print("[monitor] no SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY and no --cascades — "
                  "skipping match/email (diff only).")
            return 0

    # CAS-185: both of these are stored per account now, so the default source is the store rather
    # than a flag. The flags still win where given — that is what makes a fixture run reproducible.
    prefs = _load_json(args.prefs) if args.prefs else _store_call(store, "fetch_notify_prefs", {})
    # CAS-465: who to push to, and the badge count each push should carry (the same number the
    # in-app bell badge shows), read once up front like prefs above.
    push_tokens = _store_call(store, "fetch_push_tokens", {})
    unread_counts = _store_call(store, "fetch_unread_counts", {})
    # An alert TYPE the user muted everywhere outranks their Cascades (CAS-103 AC4). Two sources, one
    # meaning: the stored preference, plus anything the flag adds.
    muted = excludes_from_prefs(prefs)
    if args.excluded:
        for u, ms in excluded_moments(_load_json(args.excluded)).items():
            muted.setdefault(u, set()).update(ms)

    # CAS-502: a per-film "Watch it" tick (CAS-484) is now the ONLY delivery source — an agent's own
    # alert_moments/criteria bell no longer generates a notification, whatever its Cascade says.
    # match() and the `alert_moments` column are left untouched (nothing destroyed, easy to reverse);
    # this simply stops calling match() here, in the delivery path.
    watches = _load_json(args.watches) if args.watches else _store_call(store, "fetch_film_watches", [])
    if args.target_user:
        watches = [w for w in watches if str(w.get("user_id")) == args.target_user]
    watch_already = _store_call(store, "fetch_watch_notification_keys", set())
    by_user = match_film_watches(watches, transitions, already=watch_already, excluded=muted)

    # CAS-486: belt-and-braces — watches are already filtered above, so by_user should only ever hold
    # the target user's key, but a test harness that emails/pushes real people on a bug elsewhere is
    # the one failure mode worth double-guarding against.
    if args.target_user:
        by_user = {u: hits for u, hits in by_user.items() if str(u) == args.target_user}

    print(f"[monitor] matching {len(watches)} per-film Watch-it row(s) from {source}; "
          f"{sum(len(v) for v in muted.values())} global alert-type exclude(s) across "
          f"{len(muted)} user(s); {sum(len(v) for v in by_user.values())} new alert(s).")
    if not by_user:
        print("[monitor] no new alerts for anyone — no email will be sent.")
        return 0

    # --- one consolidated digest per user ---
    # CAS-185: there are TWO deliveries now, and they have different failure modes.
    #   email  — goes out only if the user asked for it AND we have an address. A failed send
    #            leaves the ledger unwritten so the next run retries it.
    #   in-app — IS the ledger row. There is nothing to fail, so it is written whenever the user
    #            has in-app on, whether or not an email went with it.
    # A user with both switched off gets nothing and no row: turning notifications on later must
    # not be met with silence about the very thing that just happened.
    sent, written_total, inapp, pushed_total = 0, 0, 0, 0
    for user_id, hits in by_user.items():
        digest = render_digest(hits)
        pref = prefs_for(prefs, user_id)
        email = pref["email_address"] or store.fetch_user_email(user_id)
        print(f"[monitor] user {user_id} ({email or 'email unknown'}): "
              f"{len(hits)} alert(s) — in-app {'on' if pref['in_app'] else 'off'}, "
              f"email {'on' if pref['email_on'] else 'off'} — subject: {digest['subject']!r}")
        for h in hits:
            print(f"    • [{h.cascade_name}] {h.transition.summary()}")

        if args.dry_run:
            if args.print_html:
                print("---- digest HTML ----\n" + digest["html"] + "\n---- end HTML ----")
            else:
                print("    digest preview:\n      " + digest["text"].replace("\n", "\n      "))
            continue

        plan = delivery_plan(pref, email)
        if plan == "none":
            print(f"[monitor] {user_id} has both channels off — nothing sent, nothing written.")
            continue
        if plan == "wait":
            print(f"[monitor] {user_id} wants email but has no address — skipping (will retry).")
            continue

        # CAS-244: the account decided WHICH channels exist (that is `plan`); each agent decides which of
        # them it will use. So the user's hits split here rather than at the top: one agent set to in-app
        # only must not put its films in the email digest, and an agent with both switched off is delivered
        # by neither — which means no ledger row either, because the ledger IS the record that we told them.
        mailable = [h for h in hits if h.wants("email")] if plan == "email" else []
        appable = [h for h in hits if h.wants("in_app")] if pref["in_app"] else []
        # CAS-465: push is not a fourth independent switch — it rides the same "in-app" gate as
        # `appable` above, and only fires where the user actually has a live device registered.
        tokens = push_tokens.get(str(user_id)) or []
        pushable = [h for h in hits if h.wants("push")] if (pref["in_app"] and tokens) else []
        if not mailable and not appable:
            print(f"[monitor] {user_id}: every matching agent has its channels off — nothing sent or written.")
            continue

        # CAS-493: channels are independent — a failed send on one must not stop the others, so a
        # failure here is a logged outcome for THIS channel only, never a `continue` that skips the
        # in-app/push delivery and the ledger write still owed to this user.
        email_ok = False
        if mailable:
            digest = render_digest(mailable)      # the email says only what the email is delivering
            try:
                send_via_resend(email, digest["subject"], digest["html"], digest["text"])
                email_ok = True
                sent += 1
                print(f"[monitor] {user_id}: email channel — sent ({len(mailable)} alert(s)).")
            except Exception as err:  # noqa: BLE001 — never let one bad send abort the run
                print(f"[monitor] {user_id}: email channel — failed: {err} — ledger not written for "
                      "it, will retry; in-app/push are unaffected.")
        if appable:
            print(f"[monitor] {user_id}: in-app channel — delivered ({len(appable)} alert(s)).")
            if not email_ok:
                inapp += 1
        # One row per hit that WAS delivered, by either channel, and never one for a hit whose only
        # offered channel(s) all failed — that's what keeps a failed channel retried next run.
        delivered = {}
        if email_ok:
            delivered.update({id(h): h for h in mailable})
        delivered.update({id(h): h for h in appable})
        # CAS-465: sent before the ledger insert below (same send-before-ledger ordering as email),
        # to every registered device, one push per hit. Badge = what the bell badge will read once
        # this run's in-app rows land — the existing unread count plus what this run is delivering.
        if pushable:
            badge = unread_counts.get(str(user_id), 0) + len(delivered)
            pushed = 0
            for h in pushable:
                copy = push_copy(h)
                payload = {"movie_id": h.transition.movie_id, "moment": h.transition.moment,
                           "cascade_id": h.cascade_id}
                for tok in tokens:
                    if send_via_apns(tok, copy["title"], copy["body"], badge=badge, payload=payload):
                        pushed += 1
            if pushed:
                print(f"[monitor] {user_id}: sent {pushed} push notification(s) across "
                      f"{len(tokens)} device(s).")
                pushed_total += pushed
        # CAS-416: the ledger write is best-effort. Delivery already happened above (the email sent,
        # or in-app was chosen), so a DB/ledger hiccup here must be a logged warning, never a crash
        # that aborts the rest of the run — the alternative is silently dropping every later user.
        try:
            written_total += store.insert_notifications(notification_rows({user_id: list(delivered.values())}))
        except Exception as err:  # noqa: BLE001 — a ledger-write failure must not abort the run
            print(f"[monitor] could not write ledger for {user_id}: {err} — delivery stands, will "
                  "retry the ledger row next run.")

    if args.dry_run:
        would = sum(len(h) for h in by_user.values())
        print(f"[monitor] --dry-run: rendered {len(by_user)} digest(s) covering {would} alert(s); "
              "sent NOTHING, wrote NOTHING.")
    else:
        print(f"[monitor] sent {sent} email digest(s), {inapp} in-app-only, {pushed_total} push "
              f"notification(s); wrote {written_total} notification row(s).")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
