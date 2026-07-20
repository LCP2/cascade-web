"""Render + send the digest email (CAS-86 / spec 26771457 §6).

One consolidated email per user per run. Each item names the film, its transition in the
agent's voice, which Cascade caught it, and links back to the site.

Honesty guardrail (spec §5/§6): every line is built from real data only. Prices are the real
offer price; service names are the real services; the "past opening weekend" line states the
plain fact (the opening weekend has passed) with no invented "leaving soon" countdown. We never
show a saving, a timer, or an urgency we can't back up.

``send_via_resend`` posts to the Resend API with the ``RESEND_API_KEY`` secret read from the
environment (never hardcoded). ``--dry-run`` in the CLI renders the HTML and sends nothing.
"""
from __future__ import annotations

import html as _html
import json
import os
import urllib.request

RESEND_API_KEY_ENV = "RESEND_API_KEY"
RESEND_ENDPOINT = "https://api.resend.com/emails"

# Overridable via env so nothing site-specific is baked in.
DEFAULT_SITE_URL = "https://lcp2.github.io/cascade-web/"
# Resend's shared test sender works without domain verification (delivers to your own account
# email). Lee swaps this for a verified sender once his domain is set up.
DEFAULT_FROM = "Cascade <onboarding@resend.dev>"

SITE_URL_ENV = "CASCADE_SITE_URL"
FROM_ENV = "CASCADE_EMAIL_FROM"


def _money(value):
    try:
        return f"${float(value):.2f}"
    except (TypeError, ValueError):
        return None


def moment_phrase(transition) -> str:
    """The agent-voice line for one transition — built only from real data on the transition."""
    m = transition.moment
    services = [s for s in (transition.services or []) if s]
    if m == "hits_stream":
        return "Now on " + " / ".join(services) if services else "Now streaming — included on your subscription"
    if m == "hits_rent":
        price = _money(transition.price)
        where = (" on " + " / ".join(services)) if services else ""
        return (f"Dropped to rent — {price}{where}" if price
                else f"Now available to rent{where}")
    if m == "hits_pvod":
        price = _money(transition.price)
        where = (" on " + " / ".join(services)) if services else ""
        return (f"Out early on premium — {price}{where}" if price
                else f"Out early on premium{where}")
    if m == "hits_cinema":
        return "In cinemas now"
    if m == "past_opening_weekend":
        return "Past its opening weekend"
    return m


# A short, honest sub-line per moment (no invented urgency).
_MOMENT_NOTE = {
    "hits_stream": "You can watch it now at no extra cost.",
    "hits_pvod": "It's available at home early, at the premium price.",
    "hits_rent": "It's reached the standard rental window.",
    "hits_cinema": "Its cinema run has begun.",
    "past_opening_weekend": "The opening weekend has passed — often a quieter time to see it.",
}


def digest_subject(hits) -> str:
    n = len(hits)
    return f"Cascade found {n} update{'' if n == 1 else 's'} for you"


def render_digest(hits, site_url: str = None) -> dict:
    """Return {'subject', 'html', 'text'} for one user's consolidated digest.

    hits: list of monitor.matching.Hit (all for the same user)."""
    site_url = site_url or os.environ.get(SITE_URL_ENV) or DEFAULT_SITE_URL
    subject = digest_subject(hits)

    # ---- plain-text part ----
    text_lines = ["Cascade has been watching. Here's what changed:", ""]
    for h in hits:
        t = h.transition
        text_lines.append(f"• {t.title} — {moment_phrase(t)}")
        text_lines.append(f"    Found by your \"{h.cascade_name}\" Cascade")
    text_lines += ["", f"Open Cascade: {site_url}",
                   "You're getting this because Cascade is watching films for you."]
    text = "\n".join(text_lines)

    # ---- HTML part (inline styles; email-client safe) ----
    esc = _html.escape
    items = []
    for h in hits:
        t = h.transition
        note = _MOMENT_NOTE.get(t.moment, "")
        items.append(
            '<tr><td style="padding:14px 0;border-bottom:1px solid #e6e8ee;">'
            f'<div style="font-size:16px;font-weight:600;color:#141A2A;">{esc(t.title)}</div>'
            f'<div style="font-size:14px;color:#4C7DFF;font-weight:600;margin-top:2px;">{esc(moment_phrase(t))}</div>'
            + (f'<div style="font-size:13px;color:#6b7280;margin-top:2px;">{esc(note)}</div>' if note else "")
            + f'<div style="font-size:12px;color:#8b95a5;margin-top:4px;">Found by your '
              f'&ldquo;{esc(h.cascade_name)}&rdquo; Cascade</div>'
            '</td></tr>'
        )
    html_doc = (
        '<!doctype html><html><head><meta charset="utf-8">'
        '<meta name="viewport" content="width=device-width,initial-scale=1"></head>'
        '<body style="margin:0;background:#f4f5f8;'
        'font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;">'
        '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f5f8;padding:24px 0;">'
        '<tr><td align="center">'
        '<table role="presentation" width="480" cellpadding="0" cellspacing="0" '
        'style="max-width:480px;background:#ffffff;border-radius:14px;padding:24px;">'
        '<tr><td>'
        '<div style="font-size:18px;font-weight:700;letter-spacing:1px;color:#7C5CFF;'
        'text-transform:uppercase;">Cascade</div>'
        '<div style="font-size:15px;color:#141A2A;margin-top:10px;font-weight:600;">'
        "Your agent's been watching. Here's what changed.</div>"
        '</td></tr>'
        '<tr><td><table role="presentation" width="100%" cellpadding="0" cellspacing="0">'
        + "".join(items) +
        '</table></td></tr>'
        '<tr><td style="padding-top:20px;">'
        f'<a href="{esc(site_url)}" style="display:inline-block;background:#6b48f2;color:#ffffff;'
        'text-decoration:none;font-weight:700;font-size:14px;padding:12px 22px;border-radius:11px;">'
        'Open Cascade</a>'
        '</td></tr>'
        '<tr><td style="padding-top:18px;font-size:12px;color:#8b95a5;">'
        'You&rsquo;re getting this because Cascade is watching films for you. '
        'Every update here is a real change to a film one of your Cascades was watching.'
        '</td></tr>'
        '</table></td></tr></table></body></html>'
    )
    return {"subject": subject, "html": html_doc, "text": text}


def send_via_resend(to_addr, subject, html, text, api_key=None, from_addr=None, timeout=30) -> dict:
    """POST one email to Resend. Reads RESEND_API_KEY / CASCADE_EMAIL_FROM from env when not
    passed. Raises if there's no API key (callers gate this behind --dry-run)."""
    api_key = api_key or os.environ.get(RESEND_API_KEY_ENV)
    if not api_key:
        raise RuntimeError(f"{RESEND_API_KEY_ENV} is not set — cannot send email.")
    from_addr = from_addr or os.environ.get(FROM_ENV) or DEFAULT_FROM
    payload = json.dumps({
        "from": from_addr, "to": [to_addr], "subject": subject, "html": html, "text": text,
    }).encode("utf-8")
    req = urllib.request.Request(
        RESEND_ENDPOINT, data=payload, method="POST",
        headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        body = resp.read().decode("utf-8")
    try:
        return json.loads(body)
    except json.JSONDecodeError:
        return {"raw": body}
