"""Data access for the monitor (CAS-85 / spec 26771457 §5, §7).

Two stores behind one small interface:

  · InMemoryStore  — for --dry-run and unit tests; no network, no keys.
  · SupabaseStore  — the real thing, talking to PostgREST with the **service_role** key
                     (which bypasses RLS: the daily job is the only writer of `notifications`
                     and the only reader of every user's `cascades`). Dependency-free — plain
                     urllib, same as poc_pipeline — so the Action needs nothing extra installed.

Interface:
  fetch_active_cascades() -> list[cascade row]
  fetch_notification_keys() -> set[(cascade_id, movie_id, moment)]   # for de-dupe
  insert_notifications(rows) -> int                                  # ledger write; returns count
"""
from __future__ import annotations

import json
import os
import urllib.error
import urllib.parse
import urllib.request

SUPABASE_URL_ENV = "SUPABASE_URL"
SERVICE_KEY_ENV = "SUPABASE_SERVICE_ROLE_KEY"


class InMemoryStore:
    """A store backed by plain Python lists — used for dry-run and tests."""

    def __init__(self, cascades=None, notifications=None, emails=None):
        self._cascades = list(cascades or [])
        self._notifications = list(notifications or [])
        self._emails = dict(emails or {})

    def fetch_active_cascades(self) -> list:
        return [c for c in self._cascades if c.get("active", True)]

    def fetch_notification_keys(self) -> set:
        return {(n.get("cascade_id"), str(n.get("movie_id")), n.get("moment"))
                for n in self._notifications}

    def insert_notifications(self, rows) -> int:
        self._notifications.extend(rows)
        return len(rows)

    def fetch_user_email(self, user_id: str):
        return self._emails.get(user_id)


class SupabaseStore:
    """PostgREST access with the service_role key. Never constructed without a URL + key."""

    def __init__(self, url: str, service_key: str, timeout: int = 30):
        self._base = url.rstrip("/") + "/rest/v1"
        self._key = service_key
        self._timeout = timeout

    def _headers(self, extra=None) -> dict:
        h = {
            "apikey": self._key,
            "Authorization": f"Bearer {self._key}",
            "Content-Type": "application/json",
        }
        if extra:
            h.update(extra)
        return h

    def _get(self, path: str) -> list:
        req = urllib.request.Request(self._base + path, headers=self._headers(), method="GET")
        with urllib.request.urlopen(req, timeout=self._timeout) as resp:
            return json.loads(resp.read().decode("utf-8"))

    def fetch_active_cascades(self) -> list:
        return self._get("/cascades?active=eq.true&select=*")

    def fetch_notification_keys(self) -> set:
        rows = self._get("/notifications?select=cascade_id,movie_id,moment")
        return {(r.get("cascade_id"), str(r.get("movie_id")), r.get("moment")) for r in rows}

    def fetch_user_email(self, user_id: str):
        """Resolve a user_id to their email via the Auth admin API (service_role only).
        Returns None if it can't be found."""
        base = self._base[: -len("/rest/v1")]   # strip the PostgREST suffix
        req = urllib.request.Request(
            f"{base}/auth/v1/admin/users/{urllib.parse.quote(user_id)}",
            headers=self._headers(), method="GET",
        )
        try:
            with urllib.request.urlopen(req, timeout=self._timeout) as resp:
                data = json.loads(resp.read().decode("utf-8"))
        except (urllib.error.URLError, json.JSONDecodeError):
            return None
        return data.get("email") or (data.get("user") or {}).get("email")

    def insert_notifications(self, rows) -> int:
        rows = list(rows)
        if not rows:
            return 0
        data = json.dumps(rows).encode("utf-8")
        req = urllib.request.Request(
            self._base + "/notifications",
            data=data,
            headers=self._headers({"Prefer": "return=minimal"}),
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=self._timeout):
            return len(rows)


def store_from_env(env=None):
    """Return a SupabaseStore if both secrets are present, else None (caller falls back to
    dry-run). The service_role key is read from the environment only — never hardcoded."""
    env = env or os.environ
    url = env.get(SUPABASE_URL_ENV)
    key = env.get(SERVICE_KEY_ENV)
    if url and key:
        return SupabaseStore(url, key)
    return None
