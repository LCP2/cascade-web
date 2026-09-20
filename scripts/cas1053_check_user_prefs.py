#!/usr/bin/env python3
"""CAS-1053 Required#1: one-off, read-only check of whether a live account's user_prefs row
still holds its services — evidence for whether CAS-1045 (or anything else) actually emptied it,
as opposed to the false "you haven't picked any services" empty state simply being a client-side
render-before-load bug (which is what app_template.html's fix in this same ticket addresses,
independently of what this script finds).

SUPABASE_SERVICE_ROLE_KEY is a GitHub secret only (see monitor/store.py's SERVICE_KEY_ENV) — this
cannot run inside a Claude Code worker session, only in a workflow with that secret, or in Lee's
own shell with it exported locally. Never hardcode it, never write to the row it reads.

Usage: SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... python scripts/cas1053_check_user_prefs.py <email>
Prints only the services arrays / services_only flag / updated_at for that one account — never any
key, never any other user's row.
"""
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request

_REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _REPO_ROOT not in sys.path:
    sys.path.insert(0, _REPO_ROOT)

from monitor.store import SERVICE_KEY_ENV, SUPABASE_URL_ENV  # noqa: E402


def _find_user_id_by_email(base_url: str, service_key: str, email: str, timeout: int = 30):
    """Auth admin API lookup (service_role only) — the reverse of store.py's fetch_user_email."""
    base = base_url.rstrip("/")
    url = f"{base}/auth/v1/admin/users?email={urllib.parse.quote(email)}"
    headers = {"apikey": service_key, "Authorization": f"Bearer {service_key}"}
    req = urllib.request.Request(url, headers=headers, method="GET")
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        data = json.loads(resp.read().decode("utf-8"))
    users = data.get("users") if isinstance(data, dict) else data
    for u in users or []:
        if (u.get("email") or "").lower() == email.lower():
            return u.get("id")
    return None


def _fetch_user_prefs_row(base_url: str, service_key: str, user_id: str, timeout: int = 30):
    base = base_url.rstrip("/") + "/rest/v1"
    path = (
        f"/user_prefs?user_id=eq.{urllib.parse.quote(user_id)}"
        "&select=sub_services,store_services,services_only,updated_at"
    )
    headers = {"apikey": service_key, "Authorization": f"Bearer {service_key}"}
    req = urllib.request.Request(base + path, headers=headers, method="GET")
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        rows = json.loads(resp.read().decode("utf-8"))
    return rows[0] if rows else None


def main():
    if len(sys.argv) != 2:
        print("usage: python scripts/cas1053_check_user_prefs.py <email>", file=sys.stderr)
        return 2
    email = sys.argv[1]
    url = os.environ.get(SUPABASE_URL_ENV)
    key = os.environ.get(SERVICE_KEY_ENV)
    if not url or not key:
        print(f"[cas1053] {SUPABASE_URL_ENV}/{SERVICE_KEY_ENV} not set — cannot run.", file=sys.stderr)
        return 1

    try:
        user_id = _find_user_id_by_email(url, key, email)
    except (urllib.error.URLError, json.JSONDecodeError) as exc:
        print(f"[cas1053] admin user lookup failed: {exc}", file=sys.stderr)
        return 1
    if not user_id:
        print(f"[cas1053] no auth user found for {email}")
        return 0

    try:
        row = _fetch_user_prefs_row(url, key, user_id)
    except (urllib.error.URLError, json.JSONDecodeError) as exc:
        print(f"[cas1053] user_prefs read failed: {exc}", file=sys.stderr)
        return 1
    if not row:
        print(f"[cas1053] {email}: no user_prefs row at all (never opened those screens).")
        return 0

    print(f"[cas1053] {email}: sub_services={row.get('sub_services')} "
          f"store_services={row.get('store_services')} "
          f"services_only={row.get('services_only')} "
          f"updated_at={row.get('updated_at')}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
