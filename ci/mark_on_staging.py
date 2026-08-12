#!/usr/bin/env python3
"""ci/mark_on_staging.py — called by qa.yml once all 5 QA jobs pass on staging.

For every CAS-NN key in the commits that just pushed (RANGE_FROM..RANGE_TO), transition the
ticket to On Staging. No label here — ci/close_shipped.py (promote.yml, on main) owns the
v<VERSION> label once the release actually ships to main.

Stdlib only (urllib) — matches the repo convention; no pip install in CI.
Fails soft per ticket (logs and continues) so one odd ticket can't fail a green QA push,
but exits non-zero if nothing could be processed at all.
"""
import os, sys
from jira_common import shipped_keys, transition_by_name

RANGE_FROM = os.environ["RANGE_FROM"]
RANGE_TO = os.environ.get("RANGE_TO", "HEAD")


def main():
    keys = shipped_keys(RANGE_FROM, RANGE_TO)
    if not keys:
        print("No CAS-NN keys in the pushed range; nothing to mark On Staging.")
        return
    print(f"Marking {len(keys)} ticket(s) On Staging: {', '.join(keys)}")
    ok = sum(transition_by_name(k, "On Staging") for k in keys)
    print(f"Done: {ok}/{len(keys)} transitioned.")
    if ok == 0:
        sys.exit(1)


if __name__ == "__main__":
    main()
