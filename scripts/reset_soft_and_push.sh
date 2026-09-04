#!/usr/bin/env bash
# CAS-758 — bounded fetch/reset-soft/rebuild/push retry. Replaces the CAS-605/755 rebase-based
# retry: a rebase structurally conflicts whenever the remote has touched the same generated file
# this job also regenerates (the normal case whenever a CC-web ticket ships mid-build, since it
# rebuilds+commits index.html too). `git reset --soft` onto the remote tip never conflicts — it
# just re-parents this job's own commit onto whatever the current tip is.
# tests/scripts/test_reset_soft_and_push.sh exercises all four outcomes (remote unchanged /
# advanced elsewhere / advanced on an owned path / push permanently rejected) against throwaway
# local repos.
#
# .github/workflows/daily.yml inlines this same algorithm at each of its two push sites (hardcoded
# to "staging") rather than calling this script directly, so each push site's retry loop stays
# independently greppable in the workflow file. This script is the reusable, parameterized,
# testable form of that identical algorithm.
#
# Usage: reset_soft_and_push.sh <branch> <rebuild_cmd> <owned-path>...
#   <rebuild_cmd>  shell command run after each reset, before staging — regenerates the owned
#                  paths against whatever the remote's other files (e.g. a template) now are.
#   <owned-path>   one or more paths this job generates. Kept exactly as currently on disk across
#                  the reset (excluded from the post-reset sync to the new tip), then `git add`-ed
#                  and committed.
# Env: MAX_ATTEMPTS (default 3)
#
# Run from inside a git working copy with "origin" configured and the owned paths' current content
# already on disk (committed or not). On success, the owned paths are committed on top of the
# current origin/<branch> tip and pushed. Exits non-zero only once MAX_ATTEMPTS is exhausted, or on
# any failure that a retry cannot fix (fetch/reset/rebuild).
set -u
BRANCH="${1:?usage: reset_soft_and_push.sh <branch> <rebuild_cmd> <owned-path>...}"
REBUILD_CMD="${2:?usage: reset_soft_and_push.sh <branch> <rebuild_cmd> <owned-path>...}"
shift 2
OWNED=("$@")
if [ "${#OWNED[@]}" -eq 0 ]; then
  echo "reset_soft_and_push: at least one owned path is required" >&2
  exit 1
fi
MAX_ATTEMPTS="${MAX_ATTEMPTS:-3}"

EXCLUDES=()
for p in "${OWNED[@]}"; do
  EXCLUDES+=(":!$p")
done

attempt=1
while [ "$attempt" -le "$MAX_ATTEMPTS" ]; do
  echo "reset_soft_and_push: attempt $attempt/$MAX_ATTEMPTS"
  if ! git fetch origin "$BRANCH"; then
    echo "reset_soft_and_push: git fetch origin $BRANCH failed" >&2
    exit 1
  fi
  if ! git reset --soft "origin/$BRANCH"; then
    echo "reset_soft_and_push: git reset --soft failed" >&2
    exit 1
  fi
  if ! git checkout HEAD -- . "${EXCLUDES[@]}"; then
    echo "reset_soft_and_push: syncing non-owned paths to the new tip failed" >&2
    exit 1
  fi
  if ! bash -c "$REBUILD_CMD"; then
    echo "reset_soft_and_push: rebuild command failed: $REBUILD_CMD" >&2
    exit 1
  fi
  git add "${OWNED[@]}"
  git commit -m "Daily refresh $(date -u +%F)" || echo "reset_soft_and_push: nothing to commit"
  if git push origin "HEAD:$BRANCH"; then
    echo "reset_soft_and_push: pushed on attempt $attempt"
    exit 0
  fi
  echo "reset_soft_and_push: push rejected on attempt $attempt"
  attempt=$((attempt + 1))
done

echo "reset_soft_and_push: all $MAX_ATTEMPTS attempts failed" >&2
exit 1
