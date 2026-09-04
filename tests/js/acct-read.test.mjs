// CAS-764: acctRead is the shared retry-before-latch helper every account-table load/reconcile call site
// (cascades/lists/list_films/watchlists, load and reconcile — eight sites total) now routes its read
// through, so the retry policy exists in one place and can't drift between them. These tests drive the
// helper directly with a stubbed reader (no real Supabase client needed) and assert acctBannerText, the
// pure decision half of the banner, so they never depend on the DOM-write stub the wider engine harness
// swallows (see engine.mjs's own file-level comment on the write-swallowing node() stub).
import test from "node:test";
import assert from "node:assert/strict";
import { loadEngine } from "./engine.mjs";

const E = loadEngine();
// The real backoff (~400ms / ~1.2s, suggested in the ticket) is a UX choice for a live device reconnecting
// over flaky radio — not something this suite should sit through on every retry-to-failure case below.
E.CascadePersistence.ACCT_READ_DELAYS = [0, 0];

const TABLE = "cas764test";   // acctTableFail is a plain object keyed by table name — an arbitrary key
                               // keeps these tests isolated from the four real tables' own state.

test("acctRead: fails twice then succeeds — the failure flag never latches, and the caller sees the eventual success", async () => {
  E.CascadePersistence.acctTableFail[TABLE] = false;
  let calls = 0;
  const result = await E.CascadePersistence.acctRead(TABLE, async () => {
    calls++;
    if(calls < 3) return { data: null, error: { message: "transient" } };
    return { data: [{ id: 1 }], error: null };
  });
  assert.equal(calls, 3, "must retry through the failures before giving up");
  assert.deepEqual(result, { data: [{ id: 1 }], error: null }, "the caller must see the eventual success, not an earlier failure");
  assert.equal(E.CascadePersistence.acctTableFail[TABLE], false, "a read that recovers within its retry budget must never latch the failure flag");
});

test("acctRead: fails three times — the failure flag latches exactly once, only after the retry budget is exhausted", async () => {
  E.CascadePersistence.acctTableFail[TABLE] = false;
  let calls = 0;
  const result = await E.CascadePersistence.acctRead(TABLE, async () => {
    calls++;
    return { data: null, error: { message: "still down" } };
  });
  assert.equal(calls, 3, "must make exactly 3 attempts before giving up");
  assert.ok(result.error, "the caller must see the final failure once the budget is exhausted");
  assert.equal(E.CascadePersistence.acctTableFail[TABLE], true, "the failure flag must latch once retries are exhausted");
});

test("acctRead: succeeds on the first attempt — no retry, no delay", async () => {
  E.CascadePersistence.acctTableFail[TABLE] = false;
  let calls = 0;
  const result = await E.CascadePersistence.acctRead(TABLE, async () => {
    calls++;
    return { data: [], error: null };
  });
  assert.equal(calls, 1, "a first-try success must not retry at all");
  assert.deepEqual(result, { data: [], error: null });
  assert.equal(E.CascadePersistence.acctTableFail[TABLE], false);
});

test("acctBannerText: names the failed surface and its consequence once retries are exhausted — no raw 'Account not connected' alarm", async () => {
  E.CascadePersistence.acctTableFail.cascades = false;
  await E.CascadePersistence.acctRead("cascades", async () => ({ data: null, error: { message: "down" } }));
  const text = E.CascadePersistence.acctBannerText();
  assert.match(text, /agents/, "the surface list must still name what's affected");
  assert.doesNotMatch(text, /Account not connected/, "the copy must be softened, not the old blanket alarm");
  E.CascadePersistence.acctTableFail.cascades = false;   // leave clean for later tests
});

test("acctBannerText: stays hidden while offline, even though a read has failed — restores once back online", async () => {
  E.CascadePersistence.acctTableFail.cascades = false;
  E.navigator.onLine = false;
  try{
    await E.CascadePersistence.acctRead("cascades", async () => ({ data: null, error: { message: "down" } }));
    assert.equal(E.CascadePersistence.acctTableFail.cascades, true, "the underlying flag still latches — only the banner's presentation is suppressed while offline");
    assert.equal(E.CascadePersistence.acctBannerText(), null, "a user who already knows they're offline must not also be told their account is unreachable");

    E.navigator.onLine = true;
    assert.notEqual(E.CascadePersistence.acctBannerText(), null, "back online, a genuinely still-failing table must be visible again");
  } finally {
    E.navigator.onLine = true;
    E.CascadePersistence.acctTableFail.cascades = false;
  }
});
