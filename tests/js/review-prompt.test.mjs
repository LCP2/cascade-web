// CAS-969: the App Store rating prompt's trigger conditions. reviewPromptEligible is the single named
// predicate every threshold lives in (AC3) — this drives it true and false across each boundary. The
// second block proves the "asked at most once per version" state really survives a reload (AC4), by
// sharing one localStorage-backed Map across two separate loadEngine() calls (two JS realms, one device).
// The third proves the trigger path never gates anything else the app does (AC6).
import test from "node:test";
import assert from "node:assert/strict";
import { loadEngine } from "./engine.mjs";

const E = loadEngine();

test("CAS-969 AC3: reviewPromptEligible — sessions boundary", () => {
  const base = { agentFoundMatch: true, askedVersion: null, currentVersion: "1.0.0" };
  assert.equal(E.reviewPromptEligible({ ...base, sessions: E.REVIEW_PROMPT_MIN_SESSIONS - 1 }), false,
    "one session short of the threshold must not be eligible");
  assert.equal(E.reviewPromptEligible({ ...base, sessions: E.REVIEW_PROMPT_MIN_SESSIONS }), true,
    "exactly the threshold must be eligible");
});

test("CAS-969 AC3: reviewPromptEligible — no agent match yet, regardless of sessions", () => {
  assert.equal(E.reviewPromptEligible({
    sessions: E.REVIEW_PROMPT_MIN_SESSIONS + 10, agentFoundMatch: false, askedVersion: null, currentVersion: "1.0.0",
  }), false, "no agent having found anything must block the prompt no matter how many sessions have passed");
});

test("CAS-969 AC3: reviewPromptEligible — already asked this version, not eligible again; a new version, eligible again", () => {
  const base = { sessions: E.REVIEW_PROMPT_MIN_SESSIONS, agentFoundMatch: true };
  assert.equal(E.reviewPromptEligible({ ...base, askedVersion: "1.0.0", currentVersion: "1.0.0" }), false,
    "already asked on this exact version must not ask again");
  assert.equal(E.reviewPromptEligible({ ...base, askedVersion: "1.0.0", currentVersion: "1.1.0" }), true,
    "a new version must be eligible again even if a prior version already asked");
  assert.equal(E.reviewPromptEligible({ ...base, askedVersion: null, currentVersion: "1.0.0" }), true,
    "never having asked must be eligible once the other thresholds are met");
});

test("CAS-969 AC4: the asked-this-version flag survives a reload (a fresh JS realm over the same device storage)", () => {
  const store = new Map();
  const E1 = loadEngine({ localStorageStore: store });
  assert.equal(E1.reviewPromptAskedVersion(), null, "a fresh device must start with nothing recorded");
  E1.markReviewPromptAsked("1.0.0");
  assert.equal(E1.reviewPromptAskedVersion(), "1.0.0", "marking asked must read back immediately");

  // Simulate a reload: a brand new engine instance (fresh module-level state) reading the SAME backing store.
  const E2 = loadEngine({ localStorageStore: store });
  assert.equal(E2.reviewPromptAskedVersion(), "1.0.0", "AC4: the asked-this-version mark must survive a reload");
  assert.equal(
    E2.reviewPromptEligible({ sessions: 99, agentFoundMatch: true, askedVersion: E2.reviewPromptAskedVersion(), currentVersion: "1.0.0" }),
    false,
    "AC4: driving the trigger again after a reload, on the same version, must not re-arm the prompt"
  );
});

test("CAS-969 AC4: the session count itself survives a reload the same way", () => {
  // Loading the engine at all replays the app's own boot sequence, which bumps the count once — exactly
  // like a real page load — so a fresh store already reads 1 after the first loadEngine() call.
  const store = new Map();
  const E1 = loadEngine({ localStorageStore: store });
  const afterFirstLoad = E1.reviewPromptSessionCount();
  assert.equal(afterFirstLoad, 1, "a fresh device's first load must count as session 1");

  const E2 = loadEngine({ localStorageStore: store }); // simulates a reload: a second boot, same device storage
  assert.equal(E2.reviewPromptSessionCount(), afterFirstLoad + 1,
    "AC4: a reload must accumulate, not restart, the session count");
});

test("CAS-969 AC6: marking a found film watched is unaffected by review-prompt eligibility, in either direction", () => {
  const id = 987660001;
  const savedWatched = new Set(E.watched);
  const savedFound = new Set(E.found);
  try{
    const e = E.entryFor(id);
    e.source = "manual";
    E.recomputeFound();
    assert.ok(E.found.has(id), "setup: the film must actually be in `found` for this to exercise the trigger's wasFound guard");

    // Not eligible (no sessions recorded yet in this engine instance) — must still mark watched normally.
    assert.doesNotThrow(() => E.setOpinion(id, "enjoyed"));
    assert.ok(E.watched.has(id), "AC6: the watched verdict must be recorded even when the review prompt is not eligible");

    // Now make it eligible (native plugin still absent in this sandbox, so the call itself is a no-op) —
    // must still behave identically, nothing withheld or delayed.
    for(let i = 0; i < E.REVIEW_PROMPT_MIN_SESSIONS; i++) E.bumpReviewPromptSessionCount();
    const id2 = 987660002;
    const e2 = E.entryFor(id2);
    e2.source = "manual";
    E.recomputeFound();
    assert.doesNotThrow(() => E.setOpinion(id2, "wow"));
    assert.ok(E.watched.has(id2), "AC6: the watched verdict must be recorded the same way when the review prompt IS eligible");
  } finally {
    E.watched.clear(); savedWatched.forEach(x => E.watched.add(x));
    E.found.clear(); savedFound.forEach(x => E.found.add(x));
  }
});
