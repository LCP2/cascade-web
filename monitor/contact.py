"""Contact-us digest — CAS-836 (M10).

Reads every unsent `contact_messages` row and renders ONE digest covering all of them, the
same send-before-ledger discipline `python -m monitor` uses for the notification digest: the
email goes out first, and `sent_at` is stamped only once that send has actually succeeded, so
a failed send is retried next run rather than silently marked done.

    python -m monitor.contact                              # live (needs SUPABASE_*, RESEND_API_KEY, CASCADE_CONTACT_TO)
    python -m monitor.contact --dry-run                     # render only; sends nothing, stamps nothing
    python -m monitor.contact --dry-run --messages monitor/fixtures/contact_messages.json

Nothing unsent: exits 0 silently, sends no email. `CASCADE_CONTACT_TO` absent: logs and sends
nothing rather than guessing an address.
"""
from __future__ import annotations

import argparse
import datetime as _dt
import html as _html
import json
import os
import sys

from .emailer import send_via_resend
from .store import InMemoryStore, store_from_env

CONTACT_TO_ENV = "CASCADE_CONTACT_TO"

_CATEGORY_LABEL = {
    "bug": "Bug",
    "suggestion": "Suggestion",
    "account": "Account",
    "other": "Other",
}


def _who(row, store) -> str:
    """The account email, or the supplied email, or the literal 'not given' — never a guess."""
    user_id = row.get("user_id")
    if user_id:
        email = store.fetch_user_email(user_id)
        if email:
            return email
    return row.get("email") or "not given"


def digest_subject(rows) -> str:
    n = len(rows)
    return f"Cascade contact — {n} message{'' if n == 1 else 's'}"


def render_digest(rows, store) -> dict:
    """Return {'subject', 'html', 'text'} covering every unsent row. Caller is responsible
    for not calling this with an empty list."""
    esc = _html.escape
    subject = digest_subject(rows)

    text_parts, html_items = [], []
    for row in rows:
        category = _CATEGORY_LABEL.get(row.get("category"), row.get("category") or "Other")
        who = _who(row, store)
        when = row.get("created_at") or ""
        build = row.get("build") or "unknown"
        message = row.get("message") or ""
        diagnostics = row.get("diagnostics")
        attachment_url = store.sign_attachment_url(row.get("attachment_path"))

        text_part = f"[{category}] {when} — {who} (build {build})\n{message}"
        if attachment_url:
            text_part += f"\n\nAttachment: {attachment_url}"
        if diagnostics:
            text_part += f"\n\nDiagnostics:\n{diagnostics}"
        text_parts.append(text_part)

        block = (
            '<div style="margin:0 0 20px;padding-bottom:16px;border-bottom:1px solid #e6e8ee;">'
            f'<div style="font-size:12px;font-weight:700;letter-spacing:0.5px;color:#7C5CFF;'
            f'text-transform:uppercase;">{esc(category)}</div>'
            f'<div style="font-size:13px;color:#6b7280;margin-top:2px;">'
            f'{esc(when)} · {esc(who)} · build {esc(build)}</div>'
            f'<div style="font-size:14px;color:#141A2A;margin-top:8px;white-space:pre-wrap;">'
            f'{esc(message)}</div>'
        )
        if attachment_url:
            block += (
                f'<div style="margin-top:8px;"><a href="{esc(attachment_url)}" '
                'style="color:#7C5CFF;">View attachment</a></div>'
            )
        if diagnostics:
            block += (
                '<pre style="margin-top:8px;padding:10px;background:#f4f5f8;border-radius:8px;'
                f'font-size:12px;overflow-x:auto;white-space:pre-wrap;">{esc(diagnostics)}</pre>'
            )
        block += "</div>"
        html_items.append(block)

    text = "\n\n".join(text_parts)
    html_doc = (
        '<!doctype html><html><head><meta charset="utf-8">'
        '<meta name="viewport" content="width=device-width,initial-scale=1"></head>'
        '<body style="margin:0;background:#f4f5f8;'
        'font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;">'
        '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" '
        'style="background:#f4f5f8;padding:24px 0;">'
        '<tr><td align="center">'
        '<table role="presentation" width="560" cellpadding="0" cellspacing="0" '
        'style="max-width:560px;background:#ffffff;border-radius:14px;padding:24px;">'
        '<tr><td>'
        f'<div style="font-size:18px;font-weight:700;color:#141A2A;">{esc(subject)}</div>'
        '<div style="margin-top:16px;">' + "".join(html_items) + "</div>"
        "</td></tr></table></td></tr></table></body></html>"
    )
    return {"subject": subject, "html": html_doc, "text": text}


def _parse_args(argv):
    p = argparse.ArgumentParser(prog="python -m monitor.contact",
                                 description="Render + send the Contact-us digest.")
    p.add_argument("--dry-run", action="store_true",
                   help="Render the digest; send no email and stamp no rows.")
    p.add_argument("--messages", metavar="PATH",
                   help="Unsent contact_messages JSON (default: Supabase via service_role).")
    return p.parse_args(argv)


def main(argv=None) -> int:
    args = _parse_args(sys.argv[1:] if argv is None else argv)

    if args.messages is not None:
        with open(args.messages, encoding="utf-8") as fh:
            rows = json.load(fh)
        store = InMemoryStore(contact_messages=rows)
        rows = store.fetch_unsent_contact_messages()
    else:
        store = store_from_env()
        if store is None:
            print("[monitor.contact] no SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY and no "
                  "--messages — nothing to do.")
            return 0
        rows = store.fetch_unsent_contact_messages()

    if not rows:
        return 0

    digest = render_digest(rows, store)
    print(f"[monitor.contact] {len(rows)} unsent message(s) — subject: {digest['subject']!r}")

    if args.dry_run:
        print(digest["text"])
        return 0

    to_addr = os.environ.get(CONTACT_TO_ENV)
    if not to_addr:
        print(f"[monitor.contact] {CONTACT_TO_ENV} is not set — logging only, sending nothing.")
        return 0

    try:
        send_via_resend(to_addr, digest["subject"], digest["html"], digest["text"])
    except Exception as err:  # noqa: BLE001 — a failed send must not stamp sent_at
        print(f"[monitor.contact] send failed: {err} — not marking sent, will retry next run.")
        return 1

    sent_at = _dt.datetime.now(_dt.timezone.utc).isoformat()
    n = store.mark_contact_messages_sent([r["id"] for r in rows], sent_at)
    print(f"[monitor.contact] sent digest covering {len(rows)} message(s); stamped {n} row(s) sent.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
