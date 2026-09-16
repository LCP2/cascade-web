"""Nightly health assertions (CAS-974, CAS-985).

Every silent failure Cascade has actually had passed CI: a green `daily.yml` run is not
evidence the night's work actually happened. This module asserts fourteen concrete things about
the run that just finished and writes the answer to ``state/health.json`` as
``{checked_at, checks: [{name, ok, value, threshold, detail}], ok}`` — exiting non-zero on any
real failure so `alert.yml` (CAS-973) fires.

    python -m monitor.health                 # live: reads movies.json, git history, env vars,
                                              # state/run_stats.json, and probes Supabase directly
    python -m monitor.health --dry-run       # offline demo against a synthetic all-green fixture
    python -m monitor.health --scope daily   # CAS-993: every check except email_send/push_send
    python -m monitor.health --scope alerts  # CAS-993: only email_send/push_send

Tolerance: a check whose inputs are unavailable this run because the run itself didn't produce
them yet (no run_stats.json section this scope, too few usage rows to mean anything, no previous
refresh to diff against) reports ``ok: null`` ("unknown") and does NOT fail the run — except
``catalogue_size``/``catalogue_integrity``, whose input (``movies.json``) is never optional, so
those two always resolve to a real pass/fail. CAS-995: a check that instead cannot run because a
*credential it needs is simply not set* (SUPABASE_ANON_KEY, CASCADE_CANARY_EMAIL/PASSWORD) is a
different case — a configuration gap someone needs to fix, not a quiet night — so it reports
``ok: false`` ("fail") with detail ``"not configured: <NAME>"`` naming exactly which secret(s)
are missing, and DOES fail the run.

CAS-993: the monitor moved out of daily.yml into its own alerts.yml, so this module now has two
scoped callers instead of one. ``--scope daily`` (daily.yml, straight after the catalogue refresh)
and ``--scope alerts`` (alerts.yml, straight after its own monitor step) each assert a different
subset of ``CHECK_NAMES`` and merge their result into the same day's ``state/health.json`` (see
``merge_report``) rather than overwriting each other. Plain ``--dry-run``/no ``--scope`` keeps the
original all-fourteen-checks-in-one-file behaviour.

CAS-985's three client-side checks (client_error_rate, empty_account_rate, activity_floor) read
the last 24h of usage_events. This job is deliberately handed only SUPABASE_ANON_KEY (see
daily.yml), never SUPABASE_SERVICE_ROLE_KEY — the same reasoning probe_usage_events_insert
below already documents: a service_role read would sail straight past the RLS this account
actually sits behind. usage_events has no anon select grant at all (CAS-942: only an
`authenticated` caller listed in analytics_admins may read it), so these three probe by signing
in with the SAME CASCADE_CANARY_EMAIL/PASSWORD probe_auth_signin uses and reading with that
session's own JWT. Until CAS-942's select policy is live AND that canary account is added to
analytics_admins, RLS silently returns zero rows rather than an error — indistinguishable from a
genuinely quiet window, so it is reported the same way: unknown, under the shared <50-app_open
floor below, naming CAS-942 as one of the two possible reasons.
"""
from __future__ import annotations

import argparse
import datetime as _dt
import json
import os
import sys
import urllib.error
import urllib.request
from collections import Counter

import poc_pipeline as pp
import runstats

from .catalogue import load_catalogue_file, load_today, load_yesterday_from_git, movies_of

_REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
HEALTH_FILE = os.path.join(_REPO_ROOT, "state", "health.json")

SUPABASE_URL_ENV = "SUPABASE_URL"
SUPABASE_ANON_KEY_ENV = "SUPABASE_ANON_KEY"
CANARY_EMAIL_ENV = "CASCADE_CANARY_EMAIL"
CANARY_PASSWORD_ENV = "CASCADE_CANARY_PASSWORD"
APNS_ENV_VARS = ("APNS_KEY_ID", "APNS_TEAM_ID", "APNS_AUTH_KEY", "APNS_BUNDLE_ID")

CATALOGUE_MIN = 5500
CATALOGUE_DROP_PCT = 0.05
SCORE_COVERAGE_MIN_PCT = 0.90
# CAS-988: the floor is 15% of the REAL quota (state/api_budget.json, CAS-987's cycle shape),
# never a hard-coded plan size — the account has moved plans before (see CAS-987) and will again.
WATCHMODE_FLOOR_PCT = 0.15
WATCHMODE_PACE_LOOKBACK_DAYS = 7
WATCHMODE_PACE_MIN_DAYS = 3
# CAS-985: shared precondition for all three usage_events checks below — fewer app_open rows than this
# in the trailing 24h reads as unknown rather than a false alarm (a quiet pre-launch day, or CAS-942's
# live grant not applied yet — the two are indistinguishable from this probe's own vantage point).
USAGE_WINDOW_MIN_APP_OPEN = 50
CLIENT_ERROR_RATE_MAX_PCT = 0.05
CLIENT_ERROR_RATE_MAX_ABS = 20
EMPTY_ACCOUNT_RATE_MAX_PCT = 0.10


# ---------------------------------------------------------------------------
# one check result
# ---------------------------------------------------------------------------
def _check(name: str, ok, value, threshold, detail: str, status: str | None = None) -> dict:
    """ok is True/False/None (None == 'unknown'). status defaults from ok but can be overridden
    to 'skipped' — a check whose precondition (e.g. APNS_* configured) was never met, distinct
    from 'unknown' (a check that WOULD apply but this run carries no data for it)."""
    if status is None:
        status = "ok" if ok is True else "fail" if ok is False else "unknown"
    return {"name": name, "ok": ok, "value": value, "threshold": threshold, "detail": detail,
            "status": status}


# ---------------------------------------------------------------------------
# catalogue_size / catalogue_integrity — movies.json is never optional, so these never go unknown
# ---------------------------------------------------------------------------
def check_catalogue_size(today_movies: list, prev_movies: list) -> dict:
    n, prev_n = len(today_movies), len(prev_movies)
    if n < CATALOGUE_MIN:
        return _check("catalogue_size", False, n, CATALOGUE_MIN,
                      f"{n} record(s) — below the {CATALOGUE_MIN}-record floor.")
    if prev_n and n < prev_n * (1 - CATALOGUE_DROP_PCT):
        return _check("catalogue_size", False, n, prev_n,
                      f"{n} record(s) — down from {prev_n} last refresh, more than "
                      f"{CATALOGUE_DROP_PCT:.0%}.")
    return _check("catalogue_size", True, n, CATALOGUE_MIN, f"{n} record(s).")


def check_catalogue_integrity(today_movies: list) -> dict:
    seen_ids, dup, bad = set(), 0, 0
    for m in today_movies:
        tmdb_id, title = m.get("tmdb_id"), m.get("title")
        # "release_date or window": poc_pipeline's own record shape never carries a literal
        # release_date field — cinema_date is the date TMDB record; status is the current
        # window(s) — so a record is sound if it carries either.
        has_release_or_window = bool(m.get("cinema_date") or m.get("status"))
        if tmdb_id is None or not title or not has_release_or_window:
            bad += 1
            continue
        if tmdb_id in seen_ids:
            dup += 1
        else:
            seen_ids.add(tmdb_id)
    if bad or dup:
        return _check("catalogue_integrity", False, {"bad": bad, "duplicates": dup}, 0,
                      f"{bad} record(s) missing tmdb_id/title/release info, {dup} duplicate "
                      f"tmdb_id(s).")
    return _check("catalogue_integrity", True, len(today_movies), 0,
                  "every record parses, carries tmdb_id + title + release info, no duplicates.")


# ---------------------------------------------------------------------------
# tmdb_fetch / watchmode_fetch / oscarbase_fetch — from state/run_stats.json
# ---------------------------------------------------------------------------
def _check_fetch(name: str, stats: dict | None) -> dict:
    if not stats:
        return _check(name, None, None, None, "no run_stats.json entry this run — unavailable.")
    calls, errors = stats.get("calls", 0), stats.get("errors", 0)
    if calls <= 0:
        return _check(name, False, calls, 0, "0 calls made this run.")
    if errors:
        return _check(name, False, errors, 0, f"{errors} error(s) across {calls} call(s).")
    return _check(name, True, calls, 0, f"{calls} call(s), 0 errors.")


def check_tmdb_fetch(stats: dict | None) -> dict:
    return _check_fetch("tmdb_fetch", stats)


def check_oscarbase_fetch(stats: dict | None) -> dict:
    return _check_fetch("oscarbase_fetch", stats)


def check_watchmode_fetch(stats: dict | None, quota: int, run_max_credits: int | None = None) -> dict:
    """CAS-988: the floor is 15% of `quota` — the real state/api_budget.json cycle quota (CAS-987),
    passed in by the caller rather than assumed here, so a plan change moves the floor with it.

    CAS-994: `run_max_credits` (WM_RUN_MAX_CREDITS, default `pp.WM_RUN_MAX_CREDITS`) is the same
    per-run ceiling poc_pipeline.py gates every Watchmode call on. 0 means the run is DELIBERATELY
    spending nothing on Watchmode this run — 0 calls is then the expected, correct outcome, not
    the failure `_check_fetch` would otherwise report it as."""
    if run_max_credits is None:
        run_max_credits = pp.WM_RUN_MAX_CREDITS
    if run_max_credits <= 0:
        return _check("watchmode_fetch", None, 0, None,
                      "Watchmode spend paused (WM_RUN_MAX_CREDITS=0) — 0 calls is expected.",
                      status="skipped")
    base = _check_fetch("watchmode_fetch", stats)
    if base["ok"] is not True:
        return base
    floor = round(quota * WATCHMODE_FLOOR_PCT)
    remaining = (stats or {}).get("remaining_monthly_credits")
    if remaining is None:
        return _check("watchmode_fetch", None, base["value"], floor,
                      "calls/errors OK but remaining_monthly_credits unavailable.")
    if remaining < floor:
        return _check("watchmode_fetch", False, remaining, floor,
                      f"only {remaining} Watchmode credit(s) left this month "
                      f"(floor {floor}, 15% of the {quota}-credit quota).")
    return _check("watchmode_fetch", True, base["value"], floor,
                  f"{base['value']} call(s), 0 errors, {remaining} credit(s) remaining this month "
                  f"(floor {floor}).")


# ---------------------------------------------------------------------------
# watchmode_pace — extrapolate the cycle's recent daily burn to the reset date
# ---------------------------------------------------------------------------
def _wm_recent_daily_avg(days_map: dict) -> float:
    recent = sorted(days_map.items())[-WATCHMODE_PACE_LOOKBACK_DAYS:]
    return sum(v for _, v in recent) / len(recent)


def check_watchmode_pace(cycle: dict | None, today: _dt.date) -> dict:
    """CAS-988: a floor only tells you after the quota's half gone. This projects the last (up to)
    seven days of state/api_budget.json's `days` map forward to the cycle's reset date, and fires
    red when that projection would exceed the quota — in time to act, not after the fact. Too few
    days of cycle data (a fresh cycle) reports unknown rather than false-alarming."""
    if not cycle:
        return _check("watchmode_pace", None, None, None,
                      "no state/api_budget.json — unavailable.")
    days_map = cycle.get("days") or {}
    if len(days_map) < WATCHMODE_PACE_MIN_DAYS:
        return _check("watchmode_pace", None, len(days_map), WATCHMODE_PACE_MIN_DAYS,
                      f"only {len(days_map)} day(s) of cycle data — too early to pace.")
    avg = _wm_recent_daily_avg(days_map)
    quota = cycle["quota"]
    spent = cycle.get("spent", sum(days_map.values()))
    cycle_end = _dt.date.fromisoformat(cycle["cycle_end"])
    days_remaining = max(0, (cycle_end - today).days)
    projected_total = spent + avg * days_remaining
    ok = projected_total <= quota
    detail = (f"{avg:.0f} credit(s)/day average, projecting {round(projected_total)} of "
              f"{quota} by the {cycle['cycle_end']} reset.")
    if not ok and avg > 0:
        exhausts = today + _dt.timedelta(days=int((quota - spent) / avg))
        detail += f" Quota exhausts around {exhausts.isoformat()}."
    return _check("watchmode_pace", ok, round(projected_total), quota, detail)


# ---------------------------------------------------------------------------
# score_coverage
# ---------------------------------------------------------------------------
def _score_count(movies: list) -> int:
    return sum(1 for m in movies
               if m.get("wm_user_rating") is not None or m.get("wm_critic_score") is not None)


def check_score_coverage(today_movies: list, prev_movies: list) -> dict:
    today_n = _score_count(today_movies)
    prev_n = _score_count(prev_movies)
    if not prev_n:
        return _check("score_coverage", None, today_n, None,
                      "no previous refresh to compare against.")
    threshold = prev_n * SCORE_COVERAGE_MIN_PCT
    ok = today_n >= threshold
    return _check("score_coverage", ok, today_n, round(threshold),
                  f"{today_n} scored film(s) vs {prev_n} last refresh "
                  f"({SCORE_COVERAGE_MIN_PCT:.0%} floor).")


# ---------------------------------------------------------------------------
# email_send / push_send — from state/run_stats.json
# ---------------------------------------------------------------------------
def check_email_send(stats: dict | None) -> dict:
    if not stats or not stats.get("attempted"):
        return _check("email_send", None, 0, 0, "no email attempted this run — unavailable.")
    attempted, delivered, errors = stats["attempted"], stats.get("delivered", 0), stats.get("errors", 0)
    ok = errors == 0
    return _check("email_send", ok, delivered, attempted,
                  f"{delivered}/{attempted} Resend call(s) delivered, {errors} error(s).")


def check_push_send(stats: dict | None, apns_configured: bool) -> dict:
    if not apns_configured:
        return _check("push_send", None, None, None,
                      "skipped — APNS_* secrets not configured.", status="skipped")
    if not stats or not stats.get("attempted"):
        return _check("push_send", None, 0, 0,
                      "APNs configured but no push attempted this run — unavailable.")
    attempted, delivered, errors = stats["attempted"], stats.get("delivered", 0), stats.get("errors", 0)
    ok = errors == 0
    return _check("push_send", ok, delivered, attempted,
                  f"{delivered}/{attempted} push(es) delivered, {errors} error(s).")


# ---------------------------------------------------------------------------
# usage_events_insert / auth_signin — live Supabase probes (anon role)
# ---------------------------------------------------------------------------
def _post_json(url: str, headers: dict, payload: dict, timeout: int = 15):
    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(url, data=data, method="POST", headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.status, resp.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as err:
        body = (err.read() or b"").decode("utf-8", "replace") if err.fp else ""
        return err.code, body


def _missing_names(*pairs) -> list:
    """CAS-995: the exact env var names among `pairs` (name, value) whose value is falsy — used
    to build the "not configured: <NAME>" detail a credential-gated check reports instead of the
    old, never-failing "unknown" when its inputs simply aren't there."""
    return [name for name, value in pairs if not value]


def probe_usage_events_insert(supabase_url: str | None, anon_key: str | None) -> dict | None:
    """Insert one canary row into usage_events AS THE ANON ROLE — the check that would have
    caught the live defect (CAS-974's own Problem statement): a service_role write would sail
    straight past the RLS policy an anon client actually hits."""
    missing = _missing_names((SUPABASE_URL_ENV, supabase_url), (SUPABASE_ANON_KEY_ENV, anon_key))
    if missing:
        return {"not_configured": missing}
    headers = {"apikey": anon_key, "Authorization": f"Bearer {anon_key}",
               "Content-Type": "application/json", "Prefer": "return=minimal"}
    payload = {"client_key": "cascade-health-canary", "type": "health_canary",
               "data": {"source": "monitor.health"}}
    try:
        status, body = _post_json(f"{supabase_url.rstrip('/')}/rest/v1/usage_events", headers, payload)
    except Exception as err:  # noqa: BLE001 — a probe failure is a result, never a crash
        return {"ok": False, "detail": f"{type(err).__name__}: {err}"}
    ok = 200 <= status < 300
    return {"ok": ok, "detail": f"HTTP {status}" + (f" — {body[:200]}" if not ok and body else "")}


def probe_auth_signin(supabase_url: str | None, anon_key: str | None,
                      email: str | None, password: str | None) -> dict | None:
    missing = _missing_names(
        (SUPABASE_URL_ENV, supabase_url), (SUPABASE_ANON_KEY_ENV, anon_key),
        (CANARY_EMAIL_ENV, email), (CANARY_PASSWORD_ENV, password))
    if missing:
        return {"not_configured": missing}
    headers = {"apikey": anon_key, "Content-Type": "application/json"}
    payload = {"email": email, "password": password}
    try:
        status, body = _post_json(
            f"{supabase_url.rstrip('/')}/auth/v1/token?grant_type=password", headers, payload)
    except Exception as err:  # noqa: BLE001 — a probe failure is a result, never a crash
        return {"ok": False, "detail": f"{type(err).__name__}: {err}"}
    if not (200 <= status < 300):
        return {"ok": False, "detail": f"HTTP {status}" + (f" — {body[:200]}" if body else "")}
    try:
        got_session = bool(json.loads(body).get("access_token"))
    except Exception:
        got_session = False
    return {"ok": got_session,
            "detail": "session returned." if got_session else "200 response carried no access_token."}


def check_usage_events_insert(probe: dict | None) -> dict:
    if probe is None:
        return _check("usage_events_insert", None, None, None,
                      "no SUPABASE_URL/SUPABASE_ANON_KEY — unavailable.")
    if probe.get("not_configured"):
        return _check("usage_events_insert", False, None, None,
                      f"not configured: {', '.join(probe['not_configured'])}")
    return _check("usage_events_insert", bool(probe.get("ok")), 1 if probe.get("ok") else 0, 1,
                  probe.get("detail", ""))


def check_auth_signin(probe: dict | None) -> dict:
    if probe is None:
        return _check("auth_signin", None, None, None,
                      "no SUPABASE_URL/SUPABASE_ANON_KEY/CASCADE_CANARY_EMAIL/"
                      "CASCADE_CANARY_PASSWORD — unavailable.")
    if probe.get("not_configured"):
        return _check("auth_signin", False, None, None,
                      f"not configured: {', '.join(probe['not_configured'])}")
    return _check("auth_signin", bool(probe.get("ok")), 1 if probe.get("ok") else 0, 1,
                  probe.get("detail", ""))


# ---------------------------------------------------------------------------
# client_error_rate / empty_account_rate / activity_floor — CAS-985, see the module docstring for
# why these read as the canary account rather than anon or service_role.
# ---------------------------------------------------------------------------
def _get_json(url: str, headers: dict, timeout: int = 15):
    req = urllib.request.Request(url, method="GET", headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.status, resp.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as err:
        body = (err.read() or b"").decode("utf-8", "replace") if err.fp else ""
        return err.code, body


def probe_usage_window(supabase_url: str | None, anon_key: str | None, email: str | None,
                       password: str | None, now: _dt.datetime) -> dict | None:
    """Signs in with the canary account and reads the trailing 24h (`rows24`) and the 24h before
    that (`rows_prev`, for activity_floor's day-over-day comparison) of usage_events with that
    session's own JWT. None when the credentials aren't configured; otherwise a dict carrying
    either "error" (the sign-in or the read itself failed outright) or the two row lists — RLS
    quietly returning zero rows (no select grant applied yet) is NOT an error here, it's read the
    same as a genuinely quiet window, by design (see the module docstring)."""
    missing = _missing_names(
        (SUPABASE_URL_ENV, supabase_url), (SUPABASE_ANON_KEY_ENV, anon_key),
        (CANARY_EMAIL_ENV, email), (CANARY_PASSWORD_ENV, password))
    if missing:
        return {"not_configured": missing}
    try:
        status, body = _post_json(
            f"{supabase_url.rstrip('/')}/auth/v1/token?grant_type=password",
            {"apikey": anon_key, "Content-Type": "application/json"},
            {"email": email, "password": password})
        if not (200 <= status < 300):
            return {"error": f"canary sign-in failed (HTTP {status})."}
        token = json.loads(body).get("access_token")
        if not token:
            return {"error": "canary sign-in returned no access_token."}
        headers = {"apikey": anon_key, "Authorization": f"Bearer {token}"}
        since24 = (now - _dt.timedelta(hours=24)).isoformat()
        since48 = (now - _dt.timedelta(hours=48)).isoformat()
        base = f"{supabase_url.rstrip('/')}/rest/v1/usage_events"
        r24_status, r24_body = _get_json(
            f"{base}?select=type,client_key,data&created_at=gte.{since24}&limit=10000", headers)
        rprev_status, rprev_body = _get_json(
            f"{base}?select=type,client_key&created_at=gte.{since48}&created_at=lt.{since24}&limit=10000",
            headers)
        if not (200 <= r24_status < 300 and 200 <= rprev_status < 300):
            return {"error": f"usage_events read failed (HTTP {r24_status}/{rprev_status})."}
        return {"rows24": json.loads(r24_body), "rows_prev": json.loads(rprev_body)}
    except Exception as err:  # noqa: BLE001 — a probe failure is a result, never a crash
        return {"error": f"{type(err).__name__}: {err}"}


def _app_open_count(rows: list) -> int:
    return sum(1 for r in rows if r.get("type") == "app_open")


def _usage_window_gate(name: str, window: dict | None):
    """The precondition every one of the three checks below shares: no credentials, the probe itself
    failed outright, or too few app_open rows to mean anything. Returns a `_check` dict to return
    immediately, or None when the caller should go on and compute the real answer."""
    if window is None:
        return _check(name, None, None, None,
                      "no SUPABASE_URL/SUPABASE_ANON_KEY/CASCADE_CANARY_EMAIL/"
                      "CASCADE_CANARY_PASSWORD — unavailable.")
    if window.get("not_configured"):
        return _check(name, False, None, None,
                      f"not configured: {', '.join(window['not_configured'])}")
    if window.get("error"):
        return _check(name, None, None, None, window["error"])
    app_open = _app_open_count(window["rows24"])
    if app_open < USAGE_WINDOW_MIN_APP_OPEN:
        return _check(name, None, app_open, USAGE_WINDOW_MIN_APP_OPEN,
                      f"only {app_open} app_open row(s) in the last 24h (floor {USAGE_WINDOW_MIN_APP_OPEN}) "
                      f"— a quiet window, or CAS-942's live select grant for this account isn't applied yet.")
    return None


def check_client_error_rate(window: dict | None) -> dict:
    gate = _usage_window_gate("client_error_rate", window)
    if gate is not None:
        return gate
    rows = window["rows24"]
    app_open = _app_open_count(rows)
    errs = [r for r in rows if r.get("type") in ("client_error", "client_rejection")]
    n = len(errs)
    pct = n / app_open
    ok = not (pct > CLIENT_ERROR_RATE_MAX_PCT or n > CLIENT_ERROR_RATE_MAX_ABS)
    top = Counter((r.get("data") or {}).get("message") or "(no message)" for r in errs).most_common(3)
    detail = f"{n} client_error/client_rejection row(s) of {app_open} app_open ({pct:.1%})."
    if top:
        detail += " Top: " + "; ".join(f"{m} x{c}" for m, c in top)
    return _check("client_error_rate", ok, n, CLIENT_ERROR_RATE_MAX_ABS, detail)


def check_empty_account_rate(window: dict | None) -> dict:
    gate = _usage_window_gate("empty_account_rate", window)
    if gate is not None:
        return gate
    rows = window["rows24"]
    empty = sum(1 for r in rows if r.get("type") == "signin_empty_account")
    returning = sum(1 for r in rows if r.get("type") == "signin_returning")
    total = empty + returning
    if not total:
        return _check("empty_account_rate", None, 0, None,
                      "no signin_returning/signin_empty_account rows in the last 24h.")
    pct = empty / total
    ok = pct <= EMPTY_ACCOUNT_RATE_MAX_PCT
    return _check("empty_account_rate", ok, empty, total,
                  f"{empty} of {total} sign-in(s) landed on an empty account ({pct:.1%}).")


def check_activity_floor(window: dict | None) -> dict:
    gate = _usage_window_gate("activity_floor", window)
    if gate is not None:
        return gate
    today_keys = {r.get("client_key") for r in window["rows24"] if r.get("type") == "app_open"}
    prev_keys = {r.get("client_key") for r in window["rows_prev"] if r.get("type") == "app_open"}
    ok = not (len(today_keys) == 0 and len(prev_keys) > 0)
    return _check("activity_floor", ok, len(today_keys), len(prev_keys),
                  f"{len(today_keys)} distinct device(s) opened the app in the last 24h "
                  f"(previous 24h: {len(prev_keys)}).")


# ---------------------------------------------------------------------------
# assemble + report
# ---------------------------------------------------------------------------
CHECK_NAMES = ("catalogue_size", "catalogue_integrity", "tmdb_fetch", "watchmode_fetch",
              "watchmode_pace", "oscarbase_fetch", "score_coverage", "email_send", "push_send",
              "usage_events_insert", "auth_signin",
              "client_error_rate", "empty_account_rate", "activity_floor")

# CAS-993: the monitor only runs in alerts.yml now, so email_send/push_send — the two checks that
# read THIS run's delivery stats — can only be asserted there. Every other check still runs in
# daily.yml, straight after the catalogue refresh, as before.
ALERT_CHECK_NAMES = ("email_send", "push_send")
DAILY_CHECK_NAMES = tuple(n for n in CHECK_NAMES if n not in ALERT_CHECK_NAMES)


def run_checks(*, today_movies=None, prev_movies=None, stats=None, usage_probe=None, auth_probe=None,
              apns_configured=None, wm_cycle=None, today=None, usage_window=None, names=None) -> list:
    """Compute only the checks named in `names` (default: every check in CHECK_NAMES, unchanged
    legacy behaviour). Each check is a lazy thunk, so a scoped caller (daily.yml's
    DAILY_CHECK_NAMES or alerts.yml's ALERT_CHECK_NAMES) never pays for — or needs to supply
    inputs for — a check outside its own scope. This matters beyond cost: usage_probe's underlying
    probe_usage_events_insert() does a real Supabase INSERT, which must not fire twice a day."""
    names = set(CHECK_NAMES if names is None else names)
    thunks = {
        "catalogue_size": lambda: check_catalogue_size(today_movies, prev_movies),
        "catalogue_integrity": lambda: check_catalogue_integrity(today_movies),
        "tmdb_fetch": lambda: check_tmdb_fetch(stats.get("tmdb")),
        "watchmode_fetch": lambda: check_watchmode_fetch(stats.get("watchmode"), wm_cycle["quota"]),
        "watchmode_pace": lambda: check_watchmode_pace(wm_cycle, today),
        "oscarbase_fetch": lambda: check_oscarbase_fetch(stats.get("oscarbase")),
        "score_coverage": lambda: check_score_coverage(today_movies, prev_movies),
        "email_send": lambda: check_email_send(stats.get("email")),
        "push_send": lambda: check_push_send(stats.get("push"), apns_configured),
        "usage_events_insert": lambda: check_usage_events_insert(usage_probe),
        "auth_signin": lambda: check_auth_signin(auth_probe),
        "client_error_rate": lambda: check_client_error_rate(usage_window),
        "empty_account_rate": lambda: check_empty_account_rate(usage_window),
        "activity_floor": lambda: check_activity_floor(usage_window),
    }
    return [thunks[n]() for n in CHECK_NAMES if n in names]


def build_report(checks: list, checked_at: str) -> dict:
    ok = all(c["ok"] is not False for c in checks)
    return {"checked_at": checked_at, "checks": checks, "ok": ok}


def merge_report(existing: dict | None, checks: list, checked_at: str) -> dict:
    """CAS-993: daily.yml and alerts.yml each assert a different subset of CHECK_NAMES now, in
    separate jobs — this lets the second job's write add its checks to the first job's same-day
    report instead of overwriting it down to just its own subset. `existing` is dropped (a fresh
    report starts) when there isn't one yet or it's from an earlier calendar day."""
    prior_checks = []
    if existing and existing.get("checked_at", "")[:10] == checked_at[:10]:
        prior_checks = existing.get("checks", [])
    fresh_names = {c["name"] for c in checks}
    merged = [c for c in prior_checks if c["name"] not in fresh_names] + checks
    ok = all(c["ok"] is not False for c in merged)
    return {"checked_at": checked_at, "checks": merged, "ok": ok}


# ---------------------------------------------------------------------------
# --dry-run: a synthetic, deterministic, fully-green fixture — built in code rather than
# committing a real ~5,500-record movies.json fixture, so AC1 stays offline and fast without
# bloating the repo.
# ---------------------------------------------------------------------------
def _synthetic_catalogue(n: int, scored_pct: float = 1.0) -> list:
    scored_n = round(n * scored_pct)
    out = []
    for i in range(n):
        out.append({
            "tmdb_id": 900000 + i,
            "title": f"Health Fixture Film {i}",
            "cinema_date": "2026-01-01",
            "status": ["in_cinema"],
            "wm_user_rating": 7.5 if i < scored_n else None,
            "wm_critic_score": None,
        })
    return out


def _dry_run_inputs():
    today = _dt.date(2026, 9, 15)
    today_movies = _synthetic_catalogue(5600, scored_pct=1.0)
    prev_movies = _synthetic_catalogue(5580, scored_pct=1.0)
    stats = {
        "tmdb": {"calls": 5600, "errors": 0},
        "watchmode": {"calls": 40, "errors": 0, "remaining_monthly_credits": 30000},
        "oscarbase": {"calls": 20, "errors": 0},
        "email": {"attempted": 3, "delivered": 3, "errors": 0},
        "push": {"attempted": 2, "delivered": 2, "errors": 0},
    }
    usage_probe = {"ok": True, "detail": "fixture — offline demo."}
    auth_probe = {"ok": True, "detail": "fixture — offline demo."}
    # a well-paced cycle: 250 credit(s)/day over 3 days of a 40000-credit quota, nowhere near
    # exhausting before the reset — keeps the --dry-run fixture all-green.
    wm_cycle = {"cycle_start": "2026-09-12", "cycle_end": "2026-10-12", "quota": 40000, "spent": 750,
               "updated_at": today.isoformat(),
               "days": {"2026-09-12": 250, "2026-09-13": 250, "2026-09-14": 250}}
    # CAS-985: 200 app_open rows across 50 devices (well above the 50-row floor), 3 error rows (1.5%,
    # under both the 5%/20-row ceilings), 5 empty-account sign-ins of 155 (3.2%, under the 10% ceiling),
    # and the same 50 devices active the previous day too — an all-green window.
    rows24 = [{"type": "app_open", "client_key": f"fixture-device-{i % 50}", "data": None} for i in range(200)]
    rows24 += [{"type": "client_error", "client_key": "fixture-device-0",
               "data": {"message": "fixture error"}} for _ in range(3)]
    rows24 += [{"type": "signin_returning", "client_key": f"fixture-device-{i}", "data": None} for i in range(150)]
    rows24 += [{"type": "signin_empty_account", "client_key": f"fixture-device-{150+i}", "data": None}
              for i in range(5)]
    rows_prev = [{"type": "app_open", "client_key": f"fixture-device-{i % 50}", "data": None} for i in range(180)]
    usage_window = {"rows24": rows24, "rows_prev": rows_prev}
    return today_movies, prev_movies, stats, usage_probe, auth_probe, True, wm_cycle, today, usage_window


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------
def _parse_args(argv):
    p = argparse.ArgumentParser(prog="python -m monitor.health",
                                description="Nightly health assertions (CAS-974).")
    p.add_argument("--dry-run", action="store_true",
                   help="Run offline against a synthetic all-green fixture; exits 0.")
    p.add_argument("--out", metavar="PATH", help="Where to write the report (default: state/health.json).")
    p.add_argument("--scope", choices=("all", "daily", "alerts"), default="all",
                   help="CAS-993: 'daily' asserts every check except email_send/push_send (the "
                        "monitor no longer runs in daily.yml, so this run has nothing to say about "
                        "delivery); 'alerts' asserts only those two, straight after alerts.yml's own "
                        "monitor step. Both merge into an existing same-day report rather than "
                        "overwriting it. Default 'all' is the unchanged legacy behaviour.")
    return p.parse_args(argv)


def main(argv=None) -> int:
    args = _parse_args(sys.argv[1:] if argv is None else argv)
    now_dt = _dt.datetime.now(_dt.timezone.utc)
    checked_at = now_dt.isoformat()

    names = {"daily": DAILY_CHECK_NAMES, "alerts": ALERT_CHECK_NAMES}.get(args.scope)

    if args.dry_run:
        (today_movies, prev_movies, stats, usage_probe, auth_probe, apns_configured,
         wm_cycle, today, usage_window) = _dry_run_inputs()
    elif args.scope == "alerts":
        # The only inputs email_send/push_send read are state/run_stats.json's email/push
        # sections (just written by this same job's monitor step) and the APNS_* env vars — skip
        # the rest of the live gather entirely, including probe_usage_events_insert's real INSERT,
        # which this scope must not repeat a second time in the same day.
        today = _dt.date.today()
        today_movies, prev_movies = [], []
        stats = runstats.load()
        usage_probe = auth_probe = usage_window = None
        apns_configured = all(os.environ.get(v) for v in APNS_ENV_VARS)
        wm_cycle = {}
    else:
        today = _dt.date.today()
        today_movies = movies_of(load_today())
        prev_movies = movies_of(load_yesterday_from_git())
        stats = runstats.load()
        supabase_url = os.environ.get(SUPABASE_URL_ENV)
        anon_key = os.environ.get(SUPABASE_ANON_KEY_ENV)
        canary_email, canary_password = os.environ.get(CANARY_EMAIL_ENV), os.environ.get(CANARY_PASSWORD_ENV)
        usage_probe = probe_usage_events_insert(supabase_url, anon_key)
        auth_probe = probe_auth_signin(supabase_url, anon_key, canary_email, canary_password)
        usage_window = probe_usage_window(supabase_url, anon_key, canary_email, canary_password, now_dt)
        apns_configured = all(os.environ.get(v) for v in APNS_ENV_VARS)
        wm_cycle = pp._load_wm_cycle_budget(today)

    checks = run_checks(today_movies=today_movies, prev_movies=prev_movies, stats=stats,
                        usage_probe=usage_probe, auth_probe=auth_probe, apns_configured=apns_configured,
                        wm_cycle=wm_cycle, today=today, usage_window=usage_window, names=names)

    for c in checks:
        marker = {"ok": "OK", "fail": "FAIL", "unknown": "unknown", "skipped": "skipped"}[c["status"]]
        print(f"[health] {c['name']}: {marker} — {c['detail']}")

    out_path = args.out or HEALTH_FILE
    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    if args.scope in ("daily", "alerts"):
        existing = None
        if os.path.exists(out_path):
            try:
                existing = json.load(open(out_path, encoding="utf-8"))
            except Exception:
                existing = None
        report = merge_report(existing, checks, checked_at)
    else:
        report = build_report(checks, checked_at)
    json.dump(report, open(out_path, "w", encoding="utf-8"), indent=2)

    # Exit status is about THIS run's own checks, never a merged-in failure the other scope
    # already reported (and already alerted on) earlier today — merging two scopes into one
    # file must not make alerts.yml fail because daily.yml's catalogue check was red, or vice
    # versa.
    ok_this_run = all(c["ok"] is not False for c in checks)
    if not ok_this_run:
        failed = [c["name"] for c in checks if c["ok"] is False]
        print(f"[health] FAILED: {', '.join(failed)}")
        return 1
    print("[health] all checks passed (unknown/skipped tolerated).")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
