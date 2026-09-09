"""Contact-us digest — CAS-836 (M10), redesigned CAS-892.

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
import re
import sys
import urllib.parse
from zoneinfo import ZoneInfo

from .emailer import send_via_resend
from .store import InMemoryStore, store_from_env

CONTACT_TO_ENV = "CASCADE_CONTACT_TO"

_CATEGORY_LABEL = {"bug": "Bug", "suggestion": "Suggestion", "account": "Account", "other": "Other"}
_SUBJECT_SINGLE = {"bug": "bug report", "suggestion": "suggestion", "account": "account question"}
# CAS-892: colour-coded pill per category (bug warm amber, suggestion violet, account blue, other grey).
_CATEGORY_STYLE = {
    "bug": {"bg": "#FDF1E2", "fg": "#B15C00", "border": "#F0C085"},
    "suggestion": {"bg": "#F1EDFF", "fg": "#6B48F2", "border": "#C9BBFA"},
    "account": {"bg": "#E8F0FF", "fg": "#2A5FD9", "border": "#AFC7F5"},
    "other": {"bg": "#F1F2F5", "fg": "#5B6472", "border": "#D7DAE0"},
}

_WINDOWS_VERSIONS = {"10.0": "Windows 10", "6.3": "Windows 8.1", "6.2": "Windows 8", "6.1": "Windows 7"}
_SECTION_RE = re.compile(r"^--\s*(.+?)\s*--$")
_KV_RE = re.compile(r"^([^:]+):\s(.*)$")
# The Identity fields already surfaced via the row's own `build` column (buildCore() on the client
# carries the same version/build/commit) — showing them again in the diagnostics table would just
# repeat the meta line's build-provenance text, not add anything.
_IDENTITY_CONSUMED = {"Version", "Build", "Commit"}


def _contact_identity(row, store):
    """(reply_address, meta_phrase). reply_address is a usable mailto target or None — never a
    guess. meta_phrase is the honest human line for it: 'signed in as <email>' for an account,
    the bare supplied address for a guest, or 'no address given' when there is none."""
    user_id = row.get("user_id")
    if user_id:
        email = store.fetch_user_email(user_id)
        if email:
            return email, f"signed in as {email}"
    email = row.get("email")
    if email:
        return email, email
    return None, "no address given"


def digest_subject(rows) -> str:
    n = len(rows)
    if n == 1:
        label = _SUBJECT_SINGLE.get(rows[0].get("category"), "message")
        return f"Cascade contact — 1 {label}"
    return f"Cascade contact — {n} messages"


def _count_sentence(n: int) -> str:
    return "One message came in through Contact us." if n == 1 else f"{n} messages came in through Contact us."


def _format_sydney(iso_str):
    """The row's `created_at` rendered as e.g. 'Tue 8 Sep, 7:42am' in Australia/Sydney. Prints
    the value verbatim, rather than guessing, if it can't be parsed as a timezone-aware datetime."""
    if not iso_str:
        return iso_str
    try:
        dt = _dt.datetime.fromisoformat(iso_str)
    except ValueError:
        return iso_str
    if dt.tzinfo is None:
        return iso_str
    syd = dt.astimezone(ZoneInfo("Australia/Sydney"))
    hour12 = syd.hour % 12 or 12
    ampm = "am" if syd.hour < 12 else "pm"
    return f"{syd.strftime('%a')} {syd.day} {syd.strftime('%b')}, {hour12}:{syd.minute:02d}{ampm}"


def _readable_ua(ua):
    """A short 'Browser N on OS (WebKit V)' rendering of a raw User-Agent string — best-effort,
    for a panel meant to be read at a glance, not a full UA parser."""
    if not ua:
        return None
    browser = None
    m = re.search(r"Edg/([\d.]+)", ua)
    if m:
        browser = f"Edge {m.group(1).split('.')[0]}"
    if not browser:
        m = re.search(r"OPR/([\d.]+)", ua)
        if m:
            browser = f"Opera {m.group(1).split('.')[0]}"
    if not browser and "Edg/" not in ua:
        m = re.search(r"Chrome/([\d.]+)", ua)
        if m:
            browser = f"Chrome {m.group(1).split('.')[0]}"
    if not browser:
        m = re.search(r"Firefox/([\d.]+)", ua)
        if m:
            browser = f"Firefox {m.group(1).split('.')[0]}"
    if not browser and "Safari/" in ua and "Chrome/" not in ua:
        m = re.search(r"Version/([\d.]+)", ua)
        browser = f"Safari {m.group(1).split('.')[0]}" if m else "Safari"
    browser = browser or "Unknown browser"

    os_name = None
    m = re.search(r"(?:iPhone OS|CPU OS) (\d+)[_\d]*", ua)
    if m:
        os_name = f"iOS {m.group(1)}"
    if not os_name:
        m = re.search(r"Android (\d+(?:\.\d+)?)", ua)
        if m:
            os_name = f"Android {m.group(1)}"
    if not os_name:
        m = re.search(r"Windows NT ([\d.]+)", ua)
        if m:
            os_name = _WINDOWS_VERSIONS.get(m.group(1), f"Windows (NT {m.group(1)})")
    if not os_name and "Mac OS X" in ua:
        os_name = "macOS"
    os_name = os_name or "an unknown OS"

    webkit = re.search(r"AppleWebKit/([\d.]+)", ua)
    tail = f" (WebKit {webkit.group(1)})" if webkit else ""
    return f"{browser} on {os_name}{tail}"


def _join_and(items) -> str:
    items = list(items)
    if not items:
        return ""
    if len(items) == 1:
        return items[0]
    if len(items) == 2:
        return f"{items[0]} and {items[1]}"
    return ", ".join(items[:-1]) + f" and {items[-1]}"


def _sync_summary(lines):
    """One line: the tables that are not OK, named, or 'all OK' when none failed — plus, since a
    table can be neither failed nor OK, which ones haven't been attempted yet. Returns
    (summary, leftover_raw_lines) — leftover is anything not shaped like 'target: status'."""
    if not lines or lines == ["(not signed in)"]:
        return "Not signed in", []
    failed, pending, leftover = [], [], []
    for line in lines:
        m = _KV_RE.match(line)
        if not m:
            leftover.append(line)
            continue
        target, status = m.group(1), m.group(2)
        if status.startswith("FAILED"):
            error = status.split(" — ", 1)[1] if " — " in status else None
            failed.append((target, error))
        elif status.startswith("not yet attempted"):
            pending.append(target)
        elif status.startswith("OK"):
            pass
        else:
            leftover.append(line)
    parts = ["; ".join(f"{t} FAILED" + (f" — {e}" if e else "") for t, e in failed) if failed else "All OK"]
    if pending:
        parts.append(_join_and(pending) + " not yet attempted")
    return " · ".join(parts), leftover


def _attachment_filename(path: str) -> str:
    """The uploaded file's own name, stripping the `<timestamp>-` prefix the upload path adds
    (app_template.html's sendContact) so the link reads as a filename, not a device path."""
    name = path.rsplit("/", 1)[-1]
    m = re.match(r"^\d+-(.+)$", name)
    return m.group(1) if m else name


def _parse_diagnostics(diagnostics: str) -> dict:
    """Parse diagReportText()'s block into the rows the panel shows, plus a trailing 'Other'
    bucket for anything this format doesn't yet know about — diagReport() can grow new fields,
    and nothing here may go missing silently (CAS-892)."""
    identity, geometry = {}, {}
    sync_lines, log_lines, other = [], [], []
    section = None
    for raw_line in (diagnostics or "").splitlines():
        line = raw_line.strip()
        if not line or line == "=== Cascade diagnostics ===":
            continue
        m = _SECTION_RE.match(line)
        if m:
            section = m.group(1)
            continue
        if section == "Identity":
            kv = _KV_RE.match(line)
            (identity.__setitem__(kv.group(1), kv.group(2)) if kv else other.append(line))
        elif section == "Geometry":
            kv = _KV_RE.match(line)
            (geometry.__setitem__(kv.group(1), kv.group(2)) if kv else other.append(line))
        elif section == "Account sync":
            sync_lines.append(line)
        elif section and section.startswith("Log tail"):
            log_lines.append(line)
        else:
            other.append(line)

    for label in _IDENTITY_CONSUMED:
        identity.pop(label, None)
    origin = identity.pop("Origin", None)
    capacitor = identity.pop("Capacitor bridge", None)
    user_agent = identity.pop("User agent", None)
    other.extend(f"{k}: {v}" for k, v in identity.items())

    inner = geometry.pop("innerWidth × innerHeight", None)
    visual = geometry.pop("visualViewport w × h", None)
    dpr = geometry.pop("devicePixelRatio", None)
    safe_area = geometry.pop("safe-area-inset T/R/B/L", None)
    orientation = geometry.pop("orientation", None)
    other.extend(f"{k}: {v}" for k, v in geometry.items())

    viewport = None
    if inner or visual or dpr:
        parts = [p for p in (inner, f"visual {visual}" if visual else None,
                              f"DPR {dpr}" if dpr else None) if p]
        viewport = " · ".join(parts)

    sync_summary, sync_leftover = _sync_summary(sync_lines)
    other.extend(sync_leftover)

    console = "empty" if (not log_lines or log_lines == ["(empty)"]) else "; ".join(log_lines)

    rows = [
        ("Origin", origin), ("Capacitor bridge", capacitor), ("Viewport", viewport),
        ("Safe-area insets", safe_area), ("Orientation", orientation),
        ("Browser", _readable_ua(user_agent) if user_agent else None),
        ("Account sync", sync_summary), ("Console tail", console),
    ]
    return {"rows": [(k, v) for k, v in rows if v], "other": other, "origin": origin, "capacitor": capacitor}


def _build_provenance(row, parsed_diag) -> str:
    base = row.get("build") or "unknown build"
    if not parsed_diag:
        return base
    env = None
    origin = parsed_diag.get("origin")
    if origin:
        env = "production" if "cascademovies.com" in origin else "staging"
    platform = None
    capacitor = parsed_diag.get("capacitor")
    if capacitor:
        m = re.search(r"\(([^)]+)\)", capacitor)
        platform = m.group(1) if m else ("web" if capacitor.startswith("no") else None)
    extra = " · ".join(x for x in (env, platform) if x)
    return f"{base} · {extra}" if extra else base


def _diag_row_html(esc, label, value) -> str:
    return ('<tr>'
            f'<td style="padding:3px 8px 3px 0;font-size:12px;color:#8b95a5;vertical-align:top;'
            f'white-space:nowrap;">{esc(label)}</td>'
            f'<td style="padding:3px 0;font-size:12px;color:#3a4150;">{esc(value)}</td>'
            '</tr>')


def _diag_panel_html(esc, diagnostics) -> str:
    parsed = _parse_diagnostics(diagnostics)
    rows_html = "".join(_diag_row_html(esc, label, value) for label, value in parsed["rows"])
    other_html = ""
    if parsed["other"]:
        items = "".join(f'<div style="font-size:12px;color:#6b7280;padding:3px 0;">{esc(item)}</div>'
                         for item in parsed["other"])
        other_html = (
            '<div style="margin-top:10px;padding-top:10px;border-top:1px solid #e6e8ee;">'
            '<div style="font-size:11px;font-weight:800;letter-spacing:0.5px;color:#8b95a5;'
            f'text-transform:uppercase;">Other</div>{items}</div>'
        )
    return (
        '<div style="margin-top:16px;padding:14px 16px;background:#f8f9fb;border-radius:12px;">'
        '<div style="font-size:11px;font-weight:800;letter-spacing:0.5px;color:#8b95a5;'
        'text-transform:uppercase;">Diagnostics</div>'
        '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" '
        f'style="margin-top:8px;">{rows_html}</table>'
        f'{other_html}'
        '<div style="margin-top:10px;padding-top:10px;border-top:1px solid #e6e8ee;font-size:11px;'
        'color:#9aa3b2;">The raw block is in the plain-text part of this email, unchanged, '
        'for pasting into a ticket.</div>'
        '</div>'
    )


def _attachment_panel_html(esc, url, path) -> str:
    filename = esc(_attachment_filename(path))
    return (
        '<div style="margin-top:16px;padding:14px 16px;border:1px solid #e6e8ee;border-radius:12px;">'
        '<div style="font-size:11px;font-weight:800;letter-spacing:0.5px;color:#8b95a5;'
        'text-transform:uppercase;">Attached</div>'
        f'<div style="margin-top:6px;"><a href="{esc(url)}" style="color:#6b48f2;font-weight:600;'
        f'text-decoration:none;">{filename}</a></div>'
        '<div style="margin-top:4px;font-size:12px;color:#8b95a5;">Link expires in 7 days.</div>'
        '</div>'
    )


def _reply_button_html(esc, addr, category) -> str:
    subject = f"Re: Cascade contact — {_CATEGORY_LABEL.get(category, 'message')}"
    href = f"mailto:{addr}?subject={urllib.parse.quote(subject)}"
    return (
        '<div style="margin-top:14px;">'
        f'<a href="{esc(href)}" style="display:inline-block;background:#6b48f2;color:#ffffff;'
        'text-decoration:none;font-weight:700;font-size:14px;padding:12px 22px;border-radius:11px;">'
        f'Reply to {esc(addr)}</a></div>'
    )


def render_digest(rows, store) -> dict:
    """Return {'subject', 'html', 'text'} covering every unsent row. Caller is responsible
    for not calling this with an empty list."""
    esc = _html.escape
    subject = digest_subject(rows)

    text_parts, card_html = [], []
    for row in rows:
        category = row.get("category")
        category_label = _CATEGORY_LABEL.get(category, category or "Other")
        pill = _CATEGORY_STYLE.get(category, _CATEGORY_STYLE["other"])
        addr, who_phrase = _contact_identity(row, store)
        when = row.get("created_at") or ""
        when_display = _format_sydney(when) or when
        message = row.get("message") or ""
        diagnostics = row.get("diagnostics")
        parsed_diag = _parse_diagnostics(diagnostics) if diagnostics else None
        build_line = _build_provenance(row, parsed_diag)
        attachment_url = store.sign_attachment_url(row.get("attachment_path"))

        text_part = f"[{category_label}] {when_display} — {who_phrase} (build {build_line})\n{message}"
        if attachment_url:
            text_part += f"\n\nAttachment: {attachment_url}"
        if diagnostics:
            text_part += f"\n\nDiagnostics:\n{diagnostics}"
        text_parts.append(text_part)

        block = (
            '<div style="margin:0 0 20px;padding:18px;border:1px solid #e6e8ee;border-radius:14px;">'
            f'<span style="display:inline-block;font-size:11px;font-weight:800;letter-spacing:0.5px;'
            f'text-transform:uppercase;padding:3px 11px;border-radius:20px;background:{pill["bg"]};'
            f'color:{pill["fg"]};border:1px solid {pill["border"]};">{esc(category_label)}</span>'
            f'<div style="font-size:16.5px;color:#141A2A;line-height:1.55;margin-top:14px;'
            f'white-space:pre-wrap;">{esc(message)}</div>'
        )
        if addr:
            block += _reply_button_html(esc, addr, category)
        block += (
            f'<div style="margin-top:14px;font-size:12.5px;color:#8b95a5;">'
            f'{esc(when_display)} · {esc(who_phrase)}<br>{esc(build_line)}</div>'
        )
        if attachment_url:
            block += _attachment_panel_html(esc, attachment_url, row.get("attachment_path"))
        if diagnostics:
            block += _diag_panel_html(esc, diagnostics)
        block += "</div>"
        card_html.append(block)

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
        '<div style="font-size:18px;font-weight:700;letter-spacing:1px;color:#7C5CFF;'
        'text-transform:uppercase;">Cascade</div>'
        f'<div style="font-size:15px;color:#141A2A;margin-top:10px;font-weight:600;">'
        f'{esc(_count_sentence(len(rows)))}</div>'
        '<div style="margin-top:20px;">' + "".join(card_html) + "</div>"
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
