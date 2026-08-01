#!/usr/bin/env python3
"""ci/close_shipped.py — called by promote.yml after main is pushed.

For every CAS-NN key in the commits that just shipped (RANGE_FROM..HEAD), transition the
ticket to Done and add the per-release label v<RELEASE_VERSION>. Cascade tracks releases by
that label, not by Jira Versions, so this is the whole "close the board" step.

Stdlib only (urllib) — matches the repo convention; no pip install in CI.
Fails soft per ticket (logs and continues) so one odd ticket can't fail a shipped release,
but exits non-zero if nothing could be processed at all.
"""
import base64, json, os, re, subprocess, sys, urllib.request, urllib.error

BASE  = os.environ["JIRA_BASE_URL"].rstrip("/")
EMAIL = os.environ["JIRA_EMAIL"]
TOKEN = os.environ["JIRA_API_TOKEN"]
RANGE_FROM = os.environ["RANGE_FROM"]
VERSION    = os.environ["RELEASE_VERSION"]
LABEL = f"v{VERSION}"

AUTH = base64.b64encode(f"{EMAIL}:{TOKEN}".encode()).decode()
HDRS = {"Authorization": f"Basic {AUTH}", "Content-Type": "application/json"}


def api(method, path, body=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(f"{BASE}{path}", data=data, headers=HDRS, method=method)
    try:
        with urllib.request.urlopen(req) as r:
            raw = r.read()
            return r.status, (json.loads(raw) if raw else None)
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode(errors="replace")


def shipped_keys():
    out = subprocess.check_output(
        ["git", "log", "--format=%s%n%b", f"{RANGE_FROM}..HEAD"], text=True)
    return sorted(set(re.findall(r"\bCAS-\d+\b", out)),
                  key=lambda k: int(k.split("-")[1]))


def close(key):
    # add the release label
    st, _ = api("PUT", f"/rest/api/3/issue/{key}",
                {"update": {"labels": [{"add": LABEL}]}})
    if st not in (204, 200):
        print(f"  {key}: label add -> HTTP {st}")
    # transition to Done by target-status name (never a hardcoded id)
    st, body = api("GET", f"/rest/api/3/issue/{key}/transitions")
    if st != 200:
        print(f"  {key}: cannot read transitions -> HTTP {st}"); return False
    tid = next((t["id"] for t in body["transitions"]
                if t["to"]["name"].lower() == "done"), None)
    if not tid:
        print(f"  {key}: no transition to Done from its current status; left as-is"); return False
    st, _ = api("POST", f"/rest/api/3/issue/{key}/transitions",
                {"transition": {"id": tid}})
    print(f"  {key}: Done + {LABEL}" if st == 204 else f"  {key}: transition -> HTTP {st}")
    return st == 204


def main():
    keys = shipped_keys()
    if not keys:
        print("No CAS-NN keys in the shipped range; nothing to close."); return
    print(f"Closing {len(keys)} ticket(s) for {LABEL}: {', '.join(keys)}")
    ok = sum(close(k) for k in keys)
    print(f"Done: {ok}/{len(keys)} transitioned.")
    if ok == 0:
        sys.exit(1)


if __name__ == "__main__":
    main()
