#!/usr/bin/env bash
# CAS-758 — proves scripts/reset_soft_and_push.sh's four outcomes without a live GitHub race:
#   1. remote unchanged — our commit lands as a plain child of the tip.
#   2. remote advanced by an unrelated commit — recovered, no conflict.
#   3. remote advanced by a commit that ALSO touches our owned (generated) path — the case a
#      rebase-based retry would conflict on. reset --soft never conflicts; this also proves the
#      non-owned-path sync step is doing its job: the remote's OTHER file change survives into the
#      final commit rather than being silently reverted by a stale index.
#   4. push rejected on every attempt (remote hook always rejects) — fails fast, non-zero.
#
# Invoke: bash tests/scripts/test_reset_soft_and_push.sh
set -u
FAIL=0
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SCRIPT="$ROOT/scripts/reset_soft_and_push.sh"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

fail() { echo "FAIL: $1" >&2; FAIL=1; }
pass() { echo "PASS: $1"; }

REBUILD_CMD='echo "built-from-$(cat template.txt)" > generated.txt'

# ---- scenario 1: remote unchanged — must succeed, committing our owned-path change -----------
REMOTE1="$WORK/remote1.git"
CLONE_A="$WORK/clone-a"

git init --bare -q -b main "$REMOTE1"
git clone -q "$REMOTE1" "$CLONE_A"
(
  cd "$CLONE_A"
  git config user.email test@example.com
  git config user.name test
  echo "v1" > template.txt
  echo "gen-v1" > generated.txt
  git add template.txt generated.txt
  git commit -qm base
  git push -q origin main
)
(
  cd "$CLONE_A"
  echo "gen-clone-a-prebuild" > generated.txt   # our pipeline's uncommitted output, pre-loop
)

if (cd "$CLONE_A" && bash "$SCRIPT" main "$REBUILD_CMD" generated.txt) >"$WORK/scenario1.log" 2>&1; then
  REMOTE_LOG=$(cd "$REMOTE1" && git log --oneline main | head -5)
  REMOTE_GEN=$(cd "$REMOTE1" && git show main:generated.txt)
  if echo "$REMOTE_LOG" | grep -q "Daily refresh" && [ "$REMOTE_GEN" = "built-from-v1" ]; then
    pass "scenario 1: remote unchanged, owned path rebuilt and pushed"
  else
    fail "scenario 1: pushed but remote content is wrong (got: $REMOTE_GEN)"
    cat "$WORK/scenario1.log" >&2
  fi
else
  fail "scenario 1: expected exit 0 (no contention), got non-zero"
  cat "$WORK/scenario1.log" >&2
fi

# ---- scenario 2: remote advanced by an unrelated commit — must succeed ------------------------
REMOTE2="$WORK/remote2.git"
CLONE_B="$WORK/clone-b"
CLONE_C="$WORK/clone-c"

git init --bare -q -b main "$REMOTE2"
git clone -q "$REMOTE2" "$CLONE_B"
(
  cd "$CLONE_B"
  git config user.email test@example.com
  git config user.name test
  echo "v1" > template.txt
  echo "gen-v1" > generated.txt
  echo "base" > other.txt
  git add template.txt generated.txt other.txt
  git commit -qm base
  git push -q origin main
)

git clone -q "$REMOTE2" "$CLONE_C"
(
  cd "$CLONE_C"
  git config user.email test@example.com
  git config user.name test
  echo "other-change" >> other.txt
  git add other.txt
  git commit -qm "clone-c advances an unrelated file"
  git push -q origin main
)

(
  cd "$CLONE_B"
  echo "gen-clone-b-prebuild" > generated.txt
)

if (cd "$CLONE_B" && bash "$SCRIPT" main "$REBUILD_CMD" generated.txt) >"$WORK/scenario2.log" 2>&1; then
  REMOTE_LOG=$(cd "$REMOTE2" && git log --oneline main | head -5)
  REMOTE_OTHER=$(cd "$REMOTE2" && git show main:other.txt)
  if echo "$REMOTE_LOG" | grep -q "clone-c advances" && echo "$REMOTE_LOG" | grep -q "Daily refresh"; then
    if printf '%s' "$REMOTE_OTHER" | grep -q "other-change"; then
      pass "scenario 2: unrelated remote advance recovered, no conflict"
    else
      fail "scenario 2: pushed, but clone-c's unrelated change did not survive"
      cat "$WORK/scenario2.log" >&2
    fi
  else
    fail "scenario 2: script exited 0 but history is missing a commit"
    cat "$WORK/scenario2.log" >&2
  fi
else
  fail "scenario 2: expected exit 0 (unrelated advance), got non-zero"
  cat "$WORK/scenario2.log" >&2
fi

# ---- scenario 3: remote advanced by a commit that ALSO touches our owned path — the shape a
# rebase would conflict on. Must succeed via reset --soft, AND the remote's own unrelated
# (non-owned) file change must survive into the final commit, not get reverted by a stale index. -
REMOTE3="$WORK/remote3.git"
CLONE_D="$WORK/clone-d"
CLONE_E="$WORK/clone-e"

git init --bare -q -b main "$REMOTE3"
git clone -q "$REMOTE3" "$CLONE_D"
(
  cd "$CLONE_D"
  git config user.email test@example.com
  git config user.name test
  echo "v1" > template.txt
  echo "gen-v1" > generated.txt
  echo "base" > other.txt
  git add template.txt generated.txt other.txt
  git commit -qm base
  git push -q origin main
)

git clone -q "$REMOTE3" "$CLONE_E"
(
  cd "$CLONE_E"
  git config user.email test@example.com
  git config user.name test
  echo "v2" > template.txt          # a source-file change (e.g. app_template.html)...
  echo "gen-clone-e" > generated.txt # ...and its OWN build of the SAME generated file
  git add template.txt generated.txt
  git commit -qm "clone-e changes the template and rebuilds the same generated file"
  git push -q origin main
)

(
  cd "$CLONE_D"
  echo "gen-clone-d-prebuild" > generated.txt   # our uncommitted pre-loop build, stale template
)

if (cd "$CLONE_D" && bash "$SCRIPT" main "$REBUILD_CMD" generated.txt) >"$WORK/scenario3.log" 2>&1; then
  REMOTE_LOG=$(cd "$REMOTE3" && git log --oneline main | head -5)
  REMOTE_GEN=$(cd "$REMOTE3" && git show main:generated.txt)
  REMOTE_TEMPLATE=$(cd "$REMOTE3" && git show main:template.txt)
  if ! echo "$REMOTE_LOG" | grep -q "Daily refresh"; then
    fail "scenario 3: script exited 0 but our commit is not on remote main"
    cat "$WORK/scenario3.log" >&2
  elif [ "$REMOTE_GEN" != "built-from-v2" ]; then
    fail "scenario 3: generated.txt was not rebuilt against clone-e's NEW template (got: $REMOTE_GEN)"
    cat "$WORK/scenario3.log" >&2
  elif [ "$REMOTE_TEMPLATE" != "v2" ]; then
    fail "scenario 3: clone-e's template change was reverted by our commit (got: $REMOTE_TEMPLATE)"
    cat "$WORK/scenario3.log" >&2
  else
    pass "scenario 3: same-generated-file remote advance recovered with no conflict, template preserved"
  fi
else
  fail "scenario 3: expected exit 0 (reset --soft never conflicts), got non-zero"
  cat "$WORK/scenario3.log" >&2
fi

# ---- scenario 4: push rejected on every attempt — must fail fast, non-zero --------------------
REMOTE4="$WORK/remote4.git"
CLONE_F="$WORK/clone-f"

git init --bare -q -b main "$REMOTE4"
git clone -q "$REMOTE4" "$CLONE_F"
(
  cd "$CLONE_F"
  git config user.email test@example.com
  git config user.name test
  echo "v1" > template.txt
  echo "gen-v1" > generated.txt
  git add template.txt generated.txt
  git commit -qm base
  git push -q origin main
)

# Install the hook only AFTER the base commit is safely on the remote, so it blocks only the
# script's own push attempts below, not the test's own setup.
cat > "$REMOTE4/hooks/pre-receive" <<'HOOK'
#!/usr/bin/env bash
echo "rejected by test hook" >&2
exit 1
HOOK
chmod +x "$REMOTE4/hooks/pre-receive"

(
  cd "$CLONE_F"
  echo "gen-clone-f-prebuild" > generated.txt
)

if (cd "$CLONE_F" && MAX_ATTEMPTS=2 bash "$SCRIPT" main "$REBUILD_CMD" generated.txt) >"$WORK/scenario4.log" 2>&1; then
  fail "scenario 4: expected non-zero exit when every push is rejected, got 0"
  cat "$WORK/scenario4.log" >&2
else
  if grep -q "all 2 attempts failed" "$WORK/scenario4.log"; then
    pass "scenario 4: push rejected on every attempt fails fast, non-zero"
  else
    fail "scenario 4: exited non-zero but did not report attempts exhausted"
    cat "$WORK/scenario4.log" >&2
  fi
fi

if [ "$FAIL" -eq 0 ]; then
  echo "All reset_soft_and_push.sh tests passed."
  exit 0
else
  echo "reset_soft_and_push.sh tests FAILED." >&2
  exit 1
fi
