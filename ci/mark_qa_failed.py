#!/usr/bin/env python3
"""ci/mark_qa_failed.py — called by qa.yml's on-failure job when any QA job goes red on staging.

CAS-482: the symmetric failure path to mark_on_staging.py's success path. Today a red run left
its ticket sitting in QA Running indefinitely with nothing distinguishing "still running" from
"red and abandoned" (CAS-475/476/477/478/479/480 all did this on 2026-08-12/13). For every
CAS-NN key in the commits that triggered this run: post a Jira comment naming the failed job(s),
the first failing line captured from that job's log (see qa.yml's per-job "Capture failure
detail" steps), and a link to the run; then move the ticket back to Ready for Dev and re-add
needs-cc-web, stripping on-staging so the label state stays the exact inverse of the success
path's needs-cc-web -> on-staging swap.

Comments post via the v2 comment endpoint (plain/wiki-markup body) rather than v3, which requires
Atlassian Document Format for the body — v2 is still fully supported on Jira Cloud and avoids
building an ADF document for a one-line status report.

Stdlib only (urllib) — matches the repo convention; no pip install in CI.
Fails soft per ticket (logs and continues) so one odd ticket can't fail the whole run, but exits
non-zero if nothing could be processed at all.
"""
import os, sys
from jira_common import api, shipped_keys, transition_by_name

RANGE_FROM = os.environ["RANGE_FROM"]
RANGE_TO = os.environ.get("RANGE_TO", "HEAD")
RUN_URL = os.environ["RUN_URL"]
FAILED_JOBS = os.environ.get("FAILED_JOBS") or "(unknown)"
FAILURE_DETAIL = os.environ.get("FAILURE_DETAIL") or "(no failure detail captured)"


def report(key):
    body = (
        "*QA failed* on staging for this ticket's push.\n\n"
        f"* Failed job(s): {FAILED_JOBS}\n"
        "* First failing line: {{" + FAILURE_DETAIL + "}}\n"
        f"* Run: {RUN_URL}\n\n"
        "Requeued to Ready for Dev with needs-cc-web. Per CC_AUTONOMY.md's diagnose-before-retry "
        "step: before touching code, confirm this ticket's own diff actually caused the failure "
        "(and check whether an existing ticket already tracks the real cause) rather than re-pushing blind."
    )
    st, _ = api("POST", f"/rest/api/2/issue/{key}/comment", {"body": body})
    if st not in (200, 201):
        print(f"  {key}: comment -> HTTP {st}")

    st, _ = api("PUT", f"/rest/api/3/issue/{key}",
                {"update": {"labels": [{"add": "needs-cc-web"}, {"remove": "on-staging"}]}})
    if st not in (200, 204):
        print(f"  {key}: label update -> HTTP {st}")

    return transition_by_name(key, "Ready for Dev")


def main():
    keys = shipped_keys(RANGE_FROM, RANGE_TO)
    if not keys:
        print("No CAS-NN keys in the pushed range; nothing to mark failed.")
        return
    print(f"Reporting failure + requeuing {len(keys)} ticket(s): {', '.join(keys)}")
    ok = sum(report(k) for k in keys)
    print(f"Done: {ok}/{len(keys)} transitioned.")
    if ok == 0:
        sys.exit(1)


if __name__ == "__main__":
    main()
