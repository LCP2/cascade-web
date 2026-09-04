#!/usr/bin/env bash
# CAS-605 — proves scripts/push_with_rebase.sh's two outcomes without a live GitHub race:
#   1. a lost race (remote advanced on an unrelated path) is recovered by rebase + retry.
#   2. a genuine conflict (remote advanced the same lines the local commit touches) fails fast,
#      non-zero, without attempting a resolution.
#
# Invoke: bash tests/scripts/test_push_with_rebase.sh
set -u
FAIL=0
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SCRIPT="$ROOT/scripts/push_with_rebase.sh"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

fail() { echo "FAIL: $1" >&2; FAIL=1; }
pass() { echo "PASS: $1"; }

# ---- scenario 1: lost race, no real conflict — must succeed by rebasing then pushing --------
REMOTE1="$WORK/remote1.git"
CLONE_A="$WORK/clone-a"
CLONE_B="$WORK/clone-b"

git init --bare -q -b main "$REMOTE1"

git clone -q "$REMOTE1" "$CLONE_A"
(
  cd "$CLONE_A"
  git config user.email test@example.com
  git config user.name test
  echo "base" > shared.txt
  echo "b" > only-b.txt
  git add shared.txt only-b.txt
  git commit -qm base
  git push -q origin main
)

git clone -q "$REMOTE1" "$CLONE_B"
(
  cd "$CLONE_B"
  git config user.email test@example.com
  git config user.name test
  echo "b-change" >> only-b.txt
  git add only-b.txt
  git commit -qm "clone-b advances an unrelated file"
  git push -q origin main
)

(
  cd "$CLONE_A"
  git config user.email test@example.com
  git config user.name test
  echo "a-change" >> shared.txt
  git add shared.txt
  git commit -qm "clone-a's own change, on a now-stale base"
)

if (cd "$CLONE_A" && bash "$SCRIPT" main) >"$WORK/scenario1.log" 2>&1; then
  REMOTE_LOG=$(cd "$REMOTE1" && git log --oneline main | head -5)
  if echo "$REMOTE_LOG" | grep -q "clone-a's own change"; then
    pass "scenario 1: lost race recovered by rebase + push"
  else
    fail "scenario 1: script exited 0 but clone-a's commit is not on remote main"
    cat "$WORK/scenario1.log" >&2
  fi
else
  fail "scenario 1: expected exit 0 (recoverable lost race), got non-zero"
  cat "$WORK/scenario1.log" >&2
fi

# ---- scenario 2: genuine conflict — must fail fast, non-zero ---------------------------------
REMOTE2="$WORK/remote2.git"
CLONE_C="$WORK/clone-c"
CLONE_D="$WORK/clone-d"

git init --bare -q -b main "$REMOTE2"

git clone -q "$REMOTE2" "$CLONE_C"
(
  cd "$CLONE_C"
  git config user.email test@example.com
  git config user.name test
  echo "line one" > conflict.txt
  git add conflict.txt
  git commit -qm base
  git push -q origin main
)

git clone -q "$REMOTE2" "$CLONE_D"
(
  cd "$CLONE_D"
  git config user.email test@example.com
  git config user.name test
  echo "line one, changed by clone-d" > conflict.txt
  git add conflict.txt
  git commit -qm "clone-d changes the same line"
  git push -q origin main
)

(
  cd "$CLONE_C"
  git config user.email test@example.com
  git config user.name test
  echo "line one, changed by clone-c" > conflict.txt
  git add conflict.txt
  git commit -qm "clone-c changes the same line differently"
)

if (cd "$CLONE_C" && bash "$SCRIPT" main) >"$WORK/scenario2.log" 2>&1; then
  fail "scenario 2: expected non-zero exit on a genuine conflict, got 0"
  cat "$WORK/scenario2.log" >&2
else
  if grep -q "conflicted on" "$WORK/scenario2.log" && grep -q "conflict.txt" "$WORK/scenario2.log"; then
    pass "scenario 2: genuine conflict fails fast and names the conflicting path"
  else
    fail "scenario 2: exited non-zero but did not name the conflicting path"
    cat "$WORK/scenario2.log" >&2
  fi
  (cd "$CLONE_C" && git rebase --abort 2>/dev/null; git status --porcelain | grep -q . && fail "scenario 2: clone-c working tree left dirty after abort")
fi

# ---- scenario 3: committed change PLUS an unstaged modification to a tracked file, against a
# remote advanced by an unrelated commit (CAS-755 — build residue like version.json/www/ left
# unstaged every run). Must succeed via --autostash: exit 0, and the remote gains the commit. ---
REMOTE3="$WORK/remote3.git"
CLONE_E="$WORK/clone-e"
CLONE_F="$WORK/clone-f"

git init --bare -q -b main "$REMOTE3"

git clone -q "$REMOTE3" "$CLONE_E"
(
  cd "$CLONE_E"
  git config user.email test@example.com
  git config user.name test
  echo "base" > shared.txt
  echo "stamp" > tracked-stamp.txt
  git add shared.txt tracked-stamp.txt
  git commit -qm base
  git push -q origin main
)

git clone -q "$REMOTE3" "$CLONE_F"
(
  cd "$CLONE_F"
  git config user.email test@example.com
  git config user.name test
  echo "f-change" >> only-f.txt
  git add only-f.txt
  git commit -qm "clone-f advances an unrelated file"
  git push -q origin main
)

(
  cd "$CLONE_E"
  git config user.email test@example.com
  git config user.name test
  echo "e-change" >> shared.txt
  git add shared.txt
  git commit -qm "clone-e's own committed change, on a now-stale base"
  # Regenerated-output residue left unstaged on a tracked file — the exact shape of
  # version.json/www/ being rewritten by every build but only partially staged (CAS-755).
  echo "regenerated stamp" > tracked-stamp.txt
)

if (cd "$CLONE_E" && bash "$SCRIPT" main) >"$WORK/scenario3.log" 2>&1; then
  REMOTE_LOG=$(cd "$REMOTE3" && git log --oneline main | head -5)
  if echo "$REMOTE_LOG" | grep -q "clone-e's own committed change"; then
    if [ "$(cat "$CLONE_E/tracked-stamp.txt")" = "regenerated stamp" ]; then
      pass "scenario 3: dirty tracked file (CAS-755 shape) recovered by autostash rebase + push"
    else
      fail "scenario 3: pushed, but the autostashed tracked-file residue was not restored"
      cat "$WORK/scenario3.log" >&2
    fi
  else
    fail "scenario 3: script exited 0 but clone-e's commit is not on remote main"
    cat "$WORK/scenario3.log" >&2
  fi
else
  fail "scenario 3: expected exit 0 (autostash should handle unstaged tracked-file residue), got non-zero"
  cat "$WORK/scenario3.log" >&2
fi

if [ "$FAIL" -eq 0 ]; then
  echo "All push_with_rebase.sh tests passed."
  exit 0
else
  echo "push_with_rebase.sh tests FAILED." >&2
  exit 1
fi
