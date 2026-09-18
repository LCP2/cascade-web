"""Standalone daily metrics report email (CAS-1021).

The behavioural analytics report — onboarding step funnel/dropout, sessions, acquisition,
activation, retention, feature usage — is for Lee only, and lives outside the user app as its own
job. It reads the six ``analytics_*`` views CAS-942 added over ``usage_events``, renders one plain
HTML email (one simple table per view, onboarding funnel first), and sends it via Resend to
``CASCADE_ALERT_TO``.

    python -m monitor.metrics_report            # live: reads the views with SUPABASE_URL /
                                                  # SUPABASE_SERVICE_ROLE_KEY, sends via Resend
    python -m monitor.metrics_report --dry-run   # prints the HTML, sends nothing

Auto-dry-run: any of SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / RESEND_API_KEY / CASCADE_ALERT_TO
missing runs as if --dry-run had been passed (mirrors monitor/health.py's own graceful-degrade
convention). A view that is missing or unreadable renders "unavailable" for that section and the
run carries on — CAS-1021 explicitly forbids creating it.
"""
from __future__ import annotations

import argparse
import datetime as _dt
import html as _html
import os
import sys

from .emailer import send_via_resend
from .store import SERVICE_KEY_ENV, SUPABASE_URL_ENV, store_from_env

RESEND_API_KEY_ENV = "RESEND_API_KEY"
ALERT_TO_ENV = "CASCADE_ALERT_TO"
REQUIRED_ENV = (SUPABASE_URL_ENV, SERVICE_KEY_ENV, RESEND_API_KEY_ENV, ALERT_TO_ENV)

# Onboarding funnel first (the ticket's own ordering), then the rest of CAS-942's views.
VIEWS = [
    ("analytics_onboarding_funnel", "Onboarding funnel"),
    ("analytics_sessions", "Sessions"),
    ("analytics_acquisition", "Acquisition"),
    ("analytics_activation", "Activation"),
    ("analytics_retention", "Retention"),
    ("analytics_feature_usage", "Feature usage"),
]


def _cell(value) -> str:
    """Never NaN/Infinity/inf (AC3) and never a blank cell for an absent value — None (a SQL
    null, e.g. analytics_onboarding_funnel's drop_pct with a zero-count denominator) renders as
    the honest "–", exactly like emailer.py's own missing-fact convention elsewhere."""
    if value is None:
        return "–"
    if isinstance(value, bool):
        return "yes" if value else "no"
    if isinstance(value, float):
        return f"{value:.1f}"
    return str(value)


def render_view_table(label: str, rows) -> str:
    """One heading + table for a single view. `rows` is None for "the view is missing or
    unreadable" (AC forbids creating it — this just says so and moves on), [] for a real but
    empty view, or the list of row dicts otherwise. Columns are taken from the first row's own
    keys, in the order PostgREST returned them, so this never hardcodes a view's shape."""
    esc = _html.escape
    heading = (f'<div style="font-size:14px;font-weight:800;color:#141A2A;margin:18px 0 6px;">'
              f'{esc(label)}</div>')
    if rows is None:
        return heading + '<div style="font-size:13px;color:#8b95a5;">unavailable</div>'
    if not rows:
        return heading + '<div style="font-size:13px;color:#8b95a5;">no data</div>'
    columns = list(rows[0].keys())
    head = "".join(
        f'<th style="text-align:left;padding:4px 10px;font-size:11px;color:#8b95a5;'
        f'border-bottom:1px solid #e6e8ee;">{esc(str(c))}</th>' for c in columns)
    body = "".join(
        "<tr>" + "".join(
            f'<td style="padding:4px 10px;font-size:13px;color:#141A2A;'
            f'border-bottom:1px solid #f0f1f4;">{esc(_cell(r.get(c)))}</td>' for c in columns)
        + "</tr>"
        for r in rows
    )
    return (heading +
            '<table style="border-collapse:collapse;width:100%;">'
            f'<thead><tr>{head}</tr></thead><tbody>{body}</tbody></table>')


def render_report(view_rows: dict, report_date: _dt.date) -> dict:
    """view_rows: {view_name: rows-list, or None for unavailable}. Returns {'subject', 'html'}."""
    esc = _html.escape
    subject = f"Cascade metrics — {report_date.isoformat()}"
    sections = "".join(render_view_table(label, view_rows.get(name)) for name, label in VIEWS)
    html_doc = (
        '<!doctype html><html><head><meta charset="utf-8">'
        '<meta name="viewport" content="width=device-width,initial-scale=1"></head>'
        '<body style="margin:0;background:#f4f5f8;'
        'font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;">'
        '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" '
        'style="background:#f4f5f8;padding:24px 0;"><tr><td align="center">'
        '<table role="presentation" width="640" cellpadding="0" cellspacing="0" '
        'style="max-width:640px;background:#ffffff;border-radius:14px;padding:24px;"><tr><td>'
        '<div style="font-size:18px;font-weight:700;letter-spacing:1px;color:#7C5CFF;'
        f'text-transform:uppercase;">Cascade metrics</div>'
        f'<div style="font-size:12px;color:#8b95a5;margin-top:2px;">{esc(report_date.isoformat())}</div>'
        + sections +
        '</td></tr></table></td></tr></table></body></html>'
    )
    return {"subject": subject, "html": html_doc}


def gather_view_rows(store) -> dict:
    """{view_name: rows, or None on any read failure} for every view in VIEWS. A per-view
    failure (missing view, RLS/permission error, network hiccup) never aborts the others — each
    is fetched independently and reported as "unavailable" on its own (AC: never re-create a
    missing view)."""
    out = {}
    for name, _label in VIEWS:
        try:
            out[name] = store.fetch_view(name)
        except Exception as err:  # noqa: BLE001 — a per-view read failure is a result, never a crash
            print(f"[metrics_report] {name}: unavailable ({type(err).__name__}: {err})")
            out[name] = None
    return out


def _parse_args(argv):
    p = argparse.ArgumentParser(prog="python -m monitor.metrics_report",
                                description="Standalone daily metrics report email (CAS-1021).")
    p.add_argument("--dry-run", action="store_true",
                   help="Print the HTML and send nothing.")
    return p.parse_args(argv)


def main(argv=None) -> int:
    args = _parse_args(sys.argv[1:] if argv is None else argv)
    today = _dt.date.today()

    missing = [name for name in REQUIRED_ENV if not os.environ.get(name)]
    dry_run = args.dry_run or bool(missing)
    if missing:
        print(f"[metrics_report] missing secret(s) {', '.join(missing)} — running --dry-run.")

    store = store_from_env()
    view_rows = gather_view_rows(store) if store is not None else {name: None for name, _ in VIEWS}

    report = render_report(view_rows, today)
    print(report["html"])

    if dry_run:
        return 0

    send_via_resend(os.environ[ALERT_TO_ENV], report["subject"], report["html"], text="")
    print(f"[metrics_report] sent to {os.environ[ALERT_TO_ENV]}.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
