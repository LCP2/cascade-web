#!/usr/bin/env python3
"""ci/jira_common.py — shared Jira REST helpers for the CD pipeline's CI scripts.

Used by ci/close_shipped.py (promote.yml, on main) and ci/mark_on_staging.py
(qa.yml, on staging), so the auth/request plumbing and the transition-by-target-
status-name lookup live in exactly one place.

Stdlib only (urllib) — matches the repo convention; no pip install in CI.
"""
import base64, json, os, re, subprocess, urllib.request, urllib.error

BASE = os.environ["JIRA_BASE_URL"].rstrip("/")
EMAIL = os.environ["JIRA_EMAIL"]
TOKEN = os.environ["JIRA_API_TOKEN"]

AUTH = base64.b64encode(f"{EMAIL}:{TOKEN}".encode()).decode()
HDRS = {"Authorization": f"Basic {AUTH}", "Content-Type": "application/json"}

# A push/merge with no prior commit to diff against (new branch, first-ever push)
# reports this as its "before" SHA — there is no range, just the tip commit.
ZERO_SHA = "0" * 40


def api(method, path, body=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(f"{BASE}{path}", data=data, headers=HDRS, method=method)
    try:
        with urllib.request.urlopen(req) as r:
            raw = r.read()
            return r.status, (json.loads(raw) if raw else None)
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode(errors="replace")


def shipped_keys(range_from, range_to="HEAD"):
    """CAS-NN keys touched by commits in range_from..range_to."""
    if range_from in ("", ZERO_SHA):
        out = subprocess.check_output(["git", "log", "--format=%s", "-1", range_to], text=True)
    else:
        out = subprocess.check_output(
            ["git", "log", "--format=%s", f"{range_from}..{range_to}"], text=True)
    return sorted(set(re.findall(r"\bCAS-\d+\b", out)),
                  key=lambda k: int(k.split("-")[1]))


def transition_by_name(key, status_name):
    """Move `key` to the transition whose target status matches status_name (never a hardcoded id)."""
    st, body = api("GET", f"/rest/api/3/issue/{key}/transitions")
    if st != 200:
        print(f"  {key}: cannot read transitions -> HTTP {st}")
        return False
    tid = next((t["id"] for t in body["transitions"]
                if t["to"]["name"].lower() == status_name.lower()), None)
    if not tid:
        print(f"  {key}: no transition to {status_name} from its current status; left as-is")
        return False
    st, _ = api("POST", f"/rest/api/3/issue/{key}/transitions", {"transition": {"id": tid}})
    ok = st == 204
    print(f"  {key}: {status_name}" if ok else f"  {key}: transition -> HTTP {st}")
    return ok
