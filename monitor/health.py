"""Nightly health assertions (CAS-974).

Every silent failure Cascade has actually had passed CI: a green `daily.yml` run is not
evidence the night's work actually happened. This module asserts eleven concrete things about
the run that just finished and writes the answer to ``state/health.json`` as
``{checked_at, checks: [{name, ok, value, threshold, detail}], ok}`` — exiting non-zero on any
real failure so `alert.yml` (CAS-973) fires.

    python -m monitor.health                 # live: reads movies.json, git history, env vars,
                                              # state/run_stats.json, and probes Supabase directly
    python -m monitor.health --dry-run       # offline demo against a synthetic all-green fixture

Tolerance: a check whose inputs are unavailable this run (no run_stats.json section, no
Supabase credential, etc.) reports ``ok: null`` ("unknown") and does NOT fail the run —
except ``catalogue_size``/``catalogue_integrity``, whose input (``movies.json``) is never
optional, so those two always resolve to a real pass/fail.
"""
from __future__ import annotations

import argparse
import datetime as _dt
import json
import os
import sys
import urllib.error
import urllib.request

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


def check_watchmode_fetch(stats: dict | None, quota: int) -> dict:
    """CAS-988: the floor is 15% of `quota` — the real state/api_budget.json cycle quota (CAS-987),
    passed in by the caller rather than assumed here, so a plan change moves the floor with it."""
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


def probe_usage_events_insert(supabase_url: str | None, anon_key: str | None) -> dict | None:
    """Insert one canary row into usage_events AS THE ANON ROLE — the check that would have
    caught the live defect (CAS-974's own Problem statement): a service_role write would sail
    straight past the RLS policy an anon client actually hits."""
    if not (supabase_url and anon_key):
        return None
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
    if not (supabase_url and anon_key and email and password):
        return None
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
    return _check("usage_events_insert", bool(probe.get("ok")), 1 if probe.get("ok") else 0, 1,
                  probe.get("detail", ""))


def check_auth_signin(probe: dict | None) -> dict:
    if probe is None:
        return _check("auth_signin", None, None, None,
                      "no SUPABASE_URL/SUPABASE_ANON_KEY/CASCADE_CANARY_EMAIL/"
                      "CASCADE_CANARY_PASSWORD — unavailable.")
    return _check("auth_signin", bool(probe.get("ok")), 1 if probe.get("ok") else 0, 1,
                  probe.get("detail", ""))


# ---------------------------------------------------------------------------
# assemble + report
# ---------------------------------------------------------------------------
CHECK_NAMES = ("catalogue_size", "catalogue_integrity", "tmdb_fetch", "watchmode_fetch",
              "watchmode_pace", "oscarbase_fetch", "score_coverage", "email_send", "push_send",
              "usage_events_insert", "auth_signin")


def run_checks(*, today_movies, prev_movies, stats, usage_probe, auth_probe, apns_configured,
              wm_cycle, today) -> list:
    return [
        check_catalogue_size(today_movies, prev_movies),
        check_catalogue_integrity(today_movies),
        check_tmdb_fetch(stats.get("tmdb")),
        check_watchmode_fetch(stats.get("watchmode"), wm_cycle["quota"]),
        check_watchmode_pace(wm_cycle, today),
        check_oscarbase_fetch(stats.get("oscarbase")),
        check_score_coverage(today_movies, prev_movies),
        check_email_send(stats.get("email")),
        check_push_send(stats.get("push"), apns_configured),
        check_usage_events_insert(usage_probe),
        check_auth_signin(auth_probe),
    ]


def build_report(checks: list, checked_at: str) -> dict:
    ok = all(c["ok"] is not False for c in checks)
    return {"checked_at": checked_at, "checks": checks, "ok": ok}


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
    return today_movies, prev_movies, stats, usage_probe, auth_probe, True, wm_cycle, today


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------
def _parse_args(argv):
    p = argparse.ArgumentParser(prog="python -m monitor.health",
                                description="Nightly health assertions (CAS-974).")
    p.add_argument("--dry-run", action="store_true",
                   help="Run offline against a synthetic all-green fixture; exits 0.")
    p.add_argument("--out", metavar="PATH", help="Where to write the report (default: state/health.json).")
    return p.parse_args(argv)


def main(argv=None) -> int:
    args = _parse_args(sys.argv[1:] if argv is None else argv)
    checked_at = _dt.datetime.now(_dt.timezone.utc).isoformat()

    if args.dry_run:
        (today_movies, prev_movies, stats, usage_probe, auth_probe, apns_configured,
         wm_cycle, today) = _dry_run_inputs()
    else:
        today = _dt.date.today()
        today_movies = movies_of(load_today())
        prev_movies = movies_of(load_yesterday_from_git())
        stats = runstats.load()
        supabase_url = os.environ.get(SUPABASE_URL_ENV)
        anon_key = os.environ.get(SUPABASE_ANON_KEY_ENV)
        usage_probe = probe_usage_events_insert(supabase_url, anon_key)
        auth_probe = probe_auth_signin(supabase_url, anon_key,
                                       os.environ.get(CANARY_EMAIL_ENV), os.environ.get(CANARY_PASSWORD_ENV))
        apns_configured = all(os.environ.get(v) for v in APNS_ENV_VARS)
        wm_cycle = pp._load_wm_cycle_budget(today)

    checks = run_checks(today_movies=today_movies, prev_movies=prev_movies, stats=stats,
                        usage_probe=usage_probe, auth_probe=auth_probe, apns_configured=apns_configured,
                        wm_cycle=wm_cycle, today=today)
    report = build_report(checks, checked_at)

    for c in checks:
        marker = {"ok": "OK", "fail": "FAIL", "unknown": "unknown", "skipped": "skipped"}[c["status"]]
        print(f"[health] {c['name']}: {marker} — {c['detail']}")

    out_path = args.out or HEALTH_FILE
    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    json.dump(report, open(out_path, "w", encoding="utf-8"), indent=2)

    if not report["ok"]:
        failed = [c["name"] for c in checks if c["ok"] is False]
        print(f"[health] FAILED: {', '.join(failed)}")
        return 1
    print("[health] all checks passed (unknown/skipped tolerated).")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
