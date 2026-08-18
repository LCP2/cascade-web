#!/usr/bin/env python3
"""ci/close_shipped.py — called by promote.yml after main is pushed.

For every CAS-NN key in the commits that just shipped (RANGE_FROM..HEAD), transition the
ticket to Done and strip the legacy `on-staging` pipeline label. The per-release
v<RELEASE_VERSION> label is added ONLY to a ticket that carries no release label yet —
see CAS-577. A release label states which release a ticket was SHAPED into; it is an input,
not a record of what happened to be live at promote time, and closing a ticket must never
change it. Cascade tracks releases by that label, not by Jira Versions, so this is the whole
"close the board" step.

Stdlib only (urllib) — matches the repo convention; no pip install in CI.
Fails soft per ticket (logs and continues) so one odd ticket can't fail a shipped release,
but exits non-zero if nothing could be processed at all.
"""
import os, re, sys
from jira_common import api, shipped_keys, transition_by_name

RANGE_FROM = os.environ["RANGE_FROM"]
VERSION    = os.environ["RELEASE_VERSION"]
LABEL = f"v{VERSION}"

STALE_VERSION_LABEL = re.compile(r"^v\d+\.\d+\.\d+$")


def strip_pipeline_labels(key):
    st, body = api("GET", f"/rest/api/3/issue/{key}?fields=labels")
    if st != 200:
        print(f"  {key}: cannot read labels -> HTTP {st}")
        return
    # CAS-577: `on-staging` only. Version labels are the shaper's statement of which release
    # this ticket belongs to — never ours to revise on close.
    stale = [l for l in body["fields"]["labels"] if l == "on-staging"]
    if not stale:
        return
    st, _ = api("PUT", f"/rest/api/3/issue/{key}",
                {"update": {"labels": [{"remove": l} for l in stale]}})
    print(f"  {key}: stripped {', '.join(stale)}" if st in (200, 204)
          else f"  {key}: label strip -> HTTP {st}")


def close(key):
    # CAS-577: only label a ticket that arrived without one. A shaped release label wins.
    st, body = api("GET", f"/rest/api/3/issue/{key}?fields=labels")
    if st == 200:
        existing = [l for l in body["fields"]["labels"] if STALE_VERSION_LABEL.match(l)]
        if existing:
            print(f"  {key}: keeping shaped release label {', '.join(existing)}")
        else:
            st2, _ = api("PUT", f"/rest/api/3/issue/{key}",
                         {"update": {"labels": [{"add": LABEL}]}})
            if st2 not in (204, 200):
                print(f"  {key}: label add -> HTTP {st2}")
    else:
        print(f"  {key}: cannot read labels -> HTTP {st}; leaving labels alone")
    ok = transition_by_name(key, "Done")
    strip_pipeline_labels(key)
    return ok


def main():
    keys = shipped_keys(RANGE_FROM)
    if not keys:
        print("No CAS-NN keys in the shipped range; nothing to close."); return
    print(f"Closing {len(keys)} ticket(s) for {LABEL}: {', '.join(keys)}")
    ok = sum(close(k) for k in keys)
    print(f"Done: {ok}/{len(keys)} transitioned.")
    if ok == 0:
        sys.exit(1)


if __name__ == "__main__":
    main()
