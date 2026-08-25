#!/usr/bin/env bash
# CAS-605 — bounded fetch/rebase/push retry, extracted so its failure path (a genuine rebase
# conflict, vs. a merely-lost race) is provable without needing a live push race in CI.
# tests/scripts/test_push_with_rebase.sh exercises this against throwaway local repos.
#
# .github/workflows/daily.yml inlines the same algorithm (hardcoded to "staging", duplicated at
# each of its two push sites) rather than calling this script directly, so that each push site's
# retry loop is independently greppable in the workflow file. This script is the reusable,
# parameterized, testable form of that identical algorithm.
#
# Usage: push_with_rebase.sh <branch> [max_attempts]
# Run from inside a git working copy that has local commits ready to push, with "origin"
# configured. On success, HEAD has been rebased onto origin/<branch> and pushed. On a genuine
# conflict, aborts the rebase, names the conflicting path(s) on stderr, and exits non-zero without
# attempting a resolution — the files this workflow pushes are regenerated every run, so a lost
# run is cheap and a bad merge is not.
set -u
BRANCH="${1:?usage: push_with_rebase.sh <branch> [max_attempts]}"
MAX_ATTEMPTS="${2:-3}"

attempt=1
while [ "$attempt" -le "$MAX_ATTEMPTS" ]; do
  echo "push_with_rebase: attempt $attempt/$MAX_ATTEMPTS"
  if ! git fetch origin "$BRANCH"; then
    echo "push_with_rebase: git fetch origin $BRANCH failed" >&2
    exit 1
  fi
  if ! git rebase "origin/$BRANCH"; then
    conflicts=$(git diff --name-only --diff-filter=U | tr '\n' ' ')
    echo "push_with_rebase: rebase onto origin/$BRANCH conflicted on: ${conflicts:-<unknown>}" >&2
    git rebase --abort
    exit 1
  fi
  if git push origin "HEAD:$BRANCH"; then
    echo "push_with_rebase: pushed on attempt $attempt"
    exit 0
  fi
  echo "push_with_rebase: push rejected on attempt $attempt"
  attempt=$((attempt + 1))
done

echo "push_with_rebase: all $MAX_ATTEMPTS attempts failed" >&2
exit 1
