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
  fetch_user_email(user_id) -> str | None
  fetch_notify_prefs() -> {user_id: {in_app, email_on, email_address, excluded_moments}}  # CAS-185
  fetch_picks() -> [{user_id, movie_id, state}]                                           # CAS-185
  fetch_push_tokens() -> {user_id: [device_token, ...]}                                   # CAS-465
  fetch_unread_counts() -> {user_id: int}                                                 # CAS-465
  fetch_film_watches() -> [{user_id, movie_id, windows}]                                  # CAS-484
  fetch_watch_notification_keys() -> set[(user_id, movie_id, moment)]  # de-dupe, null-cascade rows
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

    def __init__(self, cascades=None, notifications=None, emails=None, prefs=None, picks=None,
                 push_tokens=None, watches=None):
        self._cascades = list(cascades or [])
        self._notifications = list(notifications or [])
        self._emails = dict(emails or {})
        self._prefs = dict(prefs or {})
        self._picks = list(picks or [])
        self._push_tokens = list(push_tokens or [])
        self._watches = list(watches or [])

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

    def fetch_notify_prefs(self) -> dict:
        return dict(self._prefs)

    def fetch_picks(self) -> list:
        return list(self._picks)

    def fetch_push_tokens(self) -> dict:
        out: dict = {}
        for r in self._push_tokens:
            out.setdefault(str(r.get("user_id")), []).append(r.get("device_token"))
        return out

    def fetch_unread_counts(self) -> dict:
        out: dict = {}
        for n in self._notifications:
            if n.get("read_at"):
                continue
            uid = str(n.get("user_id"))
            out[uid] = out.get(uid, 0) + 1
        return out

    def fetch_film_watches(self) -> list:
        return list(self._watches)

    def fetch_watch_notification_keys(self) -> set:
        return {(str(n.get("user_id")), str(n.get("movie_id")), n.get("moment"))
                for n in self._notifications if n.get("cascade_id") is None}


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

    def fetch_notify_prefs(self) -> dict:
        """user_id -> the user's delivery preferences (CAS-185). A user with no row is not an
        error and not a default-off: they simply have not answered, and PREFS_DEFAULT applies."""
        rows = self._get("/notify_prefs?select=user_id,in_app,email_on,email_address,excluded_moments")
        return {str(r.get("user_id")): r for r in rows if r.get("user_id")}

    def fetch_picks(self) -> list:
        """Every hand-answer on a film, for every user (CAS-100). Only the 'off' rows suppress —
        see matching.suppressed_pairs — but both are fetched so the caller does the deciding."""
        return self._get("/film_picks?select=user_id,movie_id,state")

    def fetch_push_tokens(self) -> dict:
        """user_id -> the user's live device tokens (CAS-465), read with service_role (bypasses
        RLS, same convention as fetch_active_cascades)."""
        rows = self._get("/push_tokens?select=user_id,device_token")
        out: dict = {}
        for r in rows:
            out.setdefault(str(r.get("user_id")), []).append(r.get("device_token"))
        return out

    def fetch_unread_counts(self) -> dict:
        """user_id -> count of unread notifications rows — the same number the in-app bell
        badge shows, so a push's badge field can never disagree with it (CAS-465)."""
        rows = self._get("/notifications?read_at=is.null&select=user_id")
        out: dict = {}
        for r in rows:
            uid = str(r.get("user_id"))
            out[uid] = out.get(uid, 0) + 1
        return out

    def fetch_film_watches(self) -> list:
        """Every user's per-film Watch-it ticks (CAS-484): {user_id, movie_id, windows}."""
        return self._get("/film_watch?select=user_id,movie_id,windows")

    def fetch_watch_notification_keys(self) -> set:
        """(user_id, movie_id, moment) already delivered via the per-film-watch path — the rows in
        `notifications` with no owning cascade. Kept apart from fetch_notification_keys() because
        a null cascade_id does not, by itself, de-dupe across users the way a real one does (see
        matching.match_film_watches)."""
        rows = self._get("/notifications?cascade_id=is.null&select=user_id,movie_id,moment")
        return {(str(r.get("user_id")), str(r.get("movie_id")), r.get("moment")) for r in rows}

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
