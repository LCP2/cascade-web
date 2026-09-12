"""Reply-arrived email — CAS-967: tells the sender the same day, not tomorrow's digest alone.

CAS-887's next-morning digest still leads with any reply, but Lee learned about a real reply only
by opening the app — a reply is worth knowing about the same day it arrives. The anonymous
recipient's own browser cannot trigger this: `invite_replies` has no anon-writable "please notify"
queue, so this module finds unnotified replies itself, with the service_role key, the same
send-before-ledger discipline every other monitor module in this file uses — the email goes out
first, and `notified_at` is stamped only once that send has actually succeeded, so a failed send is
retried next run rather than silently marked done.

One email per SENDER per run, however many replies it covers — never one email per reply.
`notified_at` is independent of `seen_at` (the app's own read marker, CAS-886) and `digested_at`
(the next-morning digest's own marker, CAS-887): none of the three may set another.

Runs as a third step in the same hourly workflow as Recommend Cascade and Invite emails
(.github/workflows/recommend.yml), right after monitor.invitemail.

    python -m monitor.invitereply                                # live (needs SUPABASE_*, RESEND_API_KEY)
    python -m monitor.invitereply --dry-run                       # render only; sends nothing, stamps nothing
    python -m monitor.invitereply --dry-run --replies monitor/fixtures/invite_replies_unnotified.json

Nothing unnotified: exits 0 silently, sends no email. A reply with no resolvable sender (its
invite has gone missing) is skipped, not a crash.
"""
from __future__ import annotations

import argparse
import datetime as _dt
import html as _html
import json
import sys

# _invite_age_text is imported so a reply's age reads exactly the same way here as it does in
# tomorrow's digest (monitor.emailer._replies_block_html/_text).
from .emailer import _invite_age_text, send_via_resend
from .store import InMemoryStore, store_from_env


def _group_by_sender(rows):
    """[(sender_id, [row, ...]), ...] in first-seen order. A row with no sender_id (its invite has
    been deleted, or a test fixture simulating that) is dropped here rather than crashing."""
    groups: dict = {}
    order = []
    for r in rows:
        sender_id = r.get("sender_id")
        if not sender_id:
            continue
        if sender_id not in groups:
            groups[sender_id] = []
            order.append(sender_id)
        groups[sender_id].append(r)
    return [(sid, groups[sid]) for sid in order]


def email_subject(rows) -> str:
    """Names the outcome plainly for one reply; counts, not details, for several."""
    if len(rows) == 1:
        r = rows[0]
        verb = "yes" if r.get("answer") == "yes" else "no"
        return f"{r.get('to_name') or 'Someone'} said {verb} to {r.get('film_title') or 'your invite'}"
    return f"{len(rows)} replies to your invites"


def render_email(rows) -> dict:
    """Return {'subject', 'html', 'text'} for one sender's unnotified rows — every reply not yet
    notified, however many. Both yes and no are reported; a no is information, not a failure to
    hide. Caller is responsible for not calling this with an empty list."""
    esc = _html.escape
    subject = email_subject(rows)

    text_lines, row_html = [], []
    for r in rows:
        verb = "yes" if r.get("answer") == "yes" else "no"
        to_name = r.get("to_name") or "Someone"
        film_title = r.get("film_title") or "your invite"
        when = _invite_age_text(r.get("created_at"))
        line = f"{to_name} said {verb} to {film_title}"
        text_lines.append(f"{line} ({when})" if when else line)

        verb_color = "#1A9C5C" if verb == "yes" else "#6b7280"
        row_html.append(
            '<div style="padding:12px 0;border-bottom:1px solid #e6e8ee;">'
            f'<div style="font-size:15px;color:#141A2A;"><b>{esc(to_name)}</b> said '
            f'<b style="color:{verb_color};">{esc(verb)}</b> to <b>{esc(film_title)}</b></div>'
            + (f'<div style="font-size:13px;color:#8b95a5;margin-top:2px;">{esc(when)}</div>' if when else '')
            + '</div>'
        )

    text = "\n".join(text_lines)
    html_doc = (
        '<!doctype html><html><head><meta charset="utf-8">'
        '<meta name="viewport" content="width=device-width,initial-scale=1"></head>'
        '<body style="margin:0;background:#f4f5f8;'
        'font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;">'
        '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" '
        'style="background:#f4f5f8;padding:24px 0;">'
        '<tr><td align="center">'
        '<table role="presentation" width="480" cellpadding="0" cellspacing="0" '
        'style="max-width:480px;background:#ffffff;border-radius:14px;padding:24px;">'
        '<tr><td>'
        '<div style="font-size:18px;font-weight:700;letter-spacing:1px;color:#7C5CFF;'
        'text-transform:uppercase;">Cascade</div>'
        f'<div style="font-size:15px;color:#141A2A;margin-top:14px;font-weight:600;">'
        f'{esc(subject)}</div>'
        '<div style="margin-top:10px;">' + "".join(row_html) + "</div>"
        '</td></tr></table></td></tr></table></body></html>'
    )
    return {"subject": subject, "html": html_doc, "text": text}


def _parse_args(argv):
    p = argparse.ArgumentParser(prog="python -m monitor.invitereply",
                                 description="Render + send the reply-arrived email, one per sender per run.")
    p.add_argument("--dry-run", action="store_true",
                   help="Render every sender's email; send no email and stamp no rows.")
    p.add_argument("--replies", metavar="PATH",
                   help="Unnotified invite_replies JSON, already flattened with the sender/film "
                        "context fetch_unnotified_invite_replies() would join in (default: Supabase "
                        "via service_role).")
    return p.parse_args(argv)


def main(argv=None) -> int:
    args = _parse_args(sys.argv[1:] if argv is None else argv)

    if args.replies is not None:
        with open(args.replies, encoding="utf-8") as fh:
            rows = json.load(fh)
        store = InMemoryStore(invite_replies=rows)
        rows = store.fetch_unnotified_invite_replies()
    else:
        store = store_from_env()
        if store is None:
            print("[monitor.invitereply] no SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY and no "
                  "--replies — nothing to do.")
            return 0
        rows = store.fetch_unnotified_invite_replies()

    if not rows:
        return 0

    groups = _group_by_sender(rows)
    covered = sum(len(g) for _, g in groups)
    skipped = len(rows) - covered
    if skipped:
        print(f"[monitor.invitereply] {skipped} repl(y/ies) with no resolvable sender — skipping.")
    print(f"[monitor.invitereply] {len(groups)} sender(s), {covered} repl(y/ies).")

    sent = 0
    for sender_id, sender_rows in groups:
        email = render_email(sender_rows)
        if args.dry_run:
            print(f"[monitor.invitereply] would send to sender {sender_id!r}: {email['subject']!r}")
            print(email["text"])
            continue
        to_addr = store.fetch_user_email(sender_id)
        if not to_addr:
            print(f"[monitor.invitereply] sender {sender_id!r} has no resolvable email — skipping.")
            continue
        try:
            send_via_resend(to_addr, email["subject"], email["html"], email["text"])
        except Exception as err:  # noqa: BLE001 — a failed send must not stamp notified_at
            print(f"[monitor.invitereply] send to {to_addr!r} failed: {err} — not marking "
                  "notified, will retry next run.")
            continue
        notified_at = _dt.datetime.now(_dt.timezone.utc).isoformat()
        store.mark_invite_replies_notified([r["id"] for r in sender_rows], notified_at)
        sent += 1

    if args.dry_run:
        return 0
    print(f"[monitor.invitereply] notified {sent} of {len(groups)} sender(s).")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
