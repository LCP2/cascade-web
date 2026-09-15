"""CAS-973: reusable failure alert — one email via Resend when a scheduled/CI workflow fails.

Invoked from .github/workflows/alert.yml's single step, which runs inside the SAME run as the
workflow that called it (a `workflow_call` job shares the caller's run id) — so the failing job,
its failing step, and that step's log tail are all read straight off this run via the Actions
API. The caller only has to pass its own human-readable name (WORKFLOW_NAME).

Reads everything from the environment (no argv) so the calling step stays a one-liner `run:`.
Tolerant of an absent CASCADE_ALERT_TO or RESEND_API_KEY the same way the rest of Cascade's CI
treats an unconfigured secret (see daily.yml/recommend.yml's --dry-run split): logs and exits 0,
so this is safe to wire into every workflow before CASCADE_ALERT_TO exists as a secret.
"""
from __future__ import annotations

import json
import os
import sys
import urllib.error
import urllib.request

GITHUB_API = "https://api.github.com"
RESEND_ENDPOINT = "https://api.resend.com/emails"
DEFAULT_FROM = "Cascade <onboarding@resend.dev>"
USER_AGENT = "cascade-alert/1.0 (+https://cascademovies.com)"
LOG_TAIL_LINES = 40


def _api_get(url: str, token: str, parse_json: bool = True):
    req = urllib.request.Request(
        url,
        headers={
            "Authorization": f"Bearer {token}",
            "Accept": "application/vnd.github+json",
            "User-Agent": USER_AGENT,
        },
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        body = resp.read()
    return json.loads(body) if parse_json else body.decode("utf-8", "replace")


def find_failure(repo: str, run_id: str, token: str):
    """(failed_job_name, failed_step_name, log_tail) for this run — best-effort. Any piece the
    API doesn't make available comes back as "" rather than raising, so a GitHub API hiccup here
    still lets the alert email go out with whatever it did find."""
    failed_job = failed_step = log_tail = ""
    try:
        data = _api_get(f"{GITHUB_API}/repos/{repo}/actions/runs/{run_id}/jobs?per_page=100", token)
        failed = next((j for j in data.get("jobs", []) if j.get("conclusion") == "failure"), None)
        if failed:
            failed_job = failed.get("name", "")
            step = next((s for s in (failed.get("steps") or []) if s.get("conclusion") == "failure"), None)
            if step:
                failed_step = step.get("name", "")
            job_id = failed.get("id")
            if job_id:
                try:
                    raw = _api_get(f"{GITHUB_API}/repos/{repo}/actions/jobs/{job_id}/logs", token, parse_json=False)
                    log_tail = "\n".join(raw.splitlines()[-LOG_TAIL_LINES:])
                except (urllib.error.URLError, urllib.error.HTTPError):
                    pass
    except (urllib.error.URLError, urllib.error.HTTPError):
        pass
    return failed_job, failed_step, log_tail


def build_message(workflow_name: str, run_url: str, failed_job: str, failed_step: str, log_tail: str):
    subject = f"[Cascade ALERT] {workflow_name} failed"
    lines = [
        f"Workflow: {workflow_name}",
        f"Run: {run_url}",
        f"Failing job: {failed_job or '(unknown)'}",
        f"Failing step: {failed_step or '(unknown)'}",
    ]
    if log_tail:
        lines += ["", f"Last {LOG_TAIL_LINES} lines of the failing step's log:", "", log_tail]
    return subject, "\n".join(lines)


def send_via_resend(to_addr: str, subject: str, text: str, api_key: str, from_addr: str) -> None:
    payload = json.dumps({"from": from_addr, "to": [to_addr], "subject": subject, "text": text}).encode("utf-8")
    req = urllib.request.Request(
        RESEND_ENDPOINT, data=payload, method="POST",
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
            "User-Agent": USER_AGENT,
            "Accept": "application/json",
        },
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        resp.read()


def main() -> int:
    to_addr = os.environ.get("CASCADE_ALERT_TO")
    if not to_addr:
        print("CASCADE_ALERT_TO not set — nothing to alert, exiting 0.")
        return 0

    api_key = os.environ.get("RESEND_API_KEY")
    if not api_key:
        print("RESEND_API_KEY not set — cannot send, exiting 0.")
        return 0

    workflow_name = os.environ.get("WORKFLOW_NAME", "(unknown workflow)")
    repo = os.environ.get("GITHUB_REPOSITORY", "")
    run_id = os.environ.get("GITHUB_RUN_ID", "")
    server_url = os.environ.get("GITHUB_SERVER_URL", "https://github.com")
    run_url = f"{server_url}/{repo}/actions/runs/{run_id}" if repo and run_id else "(unknown run)"
    token = os.environ.get("GITHUB_TOKEN", "")

    failed_job = failed_step = log_tail = ""
    if repo and run_id and token:
        failed_job, failed_step, log_tail = find_failure(repo, run_id, token)

    subject, text = build_message(workflow_name, run_url, failed_job, failed_step, log_tail)
    from_addr = os.environ.get("CASCADE_EMAIL_FROM") or DEFAULT_FROM

    try:
        send_via_resend(to_addr, subject, text, api_key, from_addr)
    except urllib.error.HTTPError as err:
        detail = err.read().decode("utf-8", "replace") if err.fp else ""
        print(f"::error::Resend send failed: HTTP {err.code}, body={detail[:500]!r}")
        return 1

    print(f"Alert email sent to {to_addr}.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
