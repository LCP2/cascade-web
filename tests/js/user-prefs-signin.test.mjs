// CAS-1045: signing in used to rewrite the account's real user_prefs row with whatever this device had in
// memory a moment before loadUserPrefs ever ran — the previous account's (or a signed-out guest's) prefs,
// or a stale local copy this device happened to be carrying for the account signing in. fireAccountFanout
// awaits replayOutbox() BEFORE loadAccount()/loadUserPrefs() get a chance to load the account's real answer,
// and runUserPrefsSync() (unlike the diff-based syncs replayOutbox also drives) is a whole-row "last write
// wins" upsert with no dirty check at all — replaying it unconditionally echoed whatever was in memory back
// onto the account on every single sign-in, wiping `touched` and any service another device had since added.
// These tests drive the real seams (loadAccount/loadGuest/loadUserPrefs/replayOutbox/outboxPending, the same
// convention outbox-durability.test.mjs and acct-namespacing.test.mjs use) with a stubbed Supabase client.
import test from "node:test";
import assert from "node:assert/strict";
import { loadEngine } from "./engine.mjs";

// Same permissive per-table fake as outbox-durability.test.mjs's fakeClient: whatever isn't explicitly
// configured for a table succeeds with empty data, so every replay target replayOutbox also drives
// (cascades, film_watch, notify_prefs, ...) is a harmless no-op alongside the user_prefs behaviour under test.
function fakeClient({ upserts = {}, selects = {} } = {}){
  const upsertCalls = [];
  return {
    upsertCalls,
    from(table){
      return {
        upsert(rows){
          upsertCalls.push({ table, rows });
          const spec = upserts[table];
          const err = typeof spec === "function" ? spec(rows) : spec;
          const result = err ? { data: null, error: err } : { data: rows, error: null };
          return { then(resolve, reject){ return Promise.resolve(result).then(resolve, reject); },
                   select(){ return Promise.resolve(result); } };
        },
        select(){
          const spec = selects[table];
          const result = spec ? spec() : { data: [], error: null };
          const thenable = { then(resolve, reject){ return Promise.resolve(result).then(resolve, reject); } };
          thenable.order = () => thenable;
          thenable.limit = () => thenable;
          thenable.eq = () => thenable;
          return thenable;
        },
        delete(){
          const chain = { then(resolve){ return Promise.resolve({ data: [], error: null }).then(resolve); } };
          chain.eq = () => chain; chain.in = () => chain;
          return chain;
        },
      };
    },
  };
}
function signIn(E, userId, client){
  const auth = E.CascadeAuth;
  auth.enabled = true; auth.client = client; auth.session = { user: { id: userId } };
}
function signOut(E){
  const auth = E.CascadeAuth;
  auth.enabled = false; auth.client = null; auth.session = null;
}
// A full, self-consistent user_prefs row — every field loadUserPrefs reads, so no field ever falls into a
// carry-up branch and schedules a second, unrelated push this test isn't about.
function serverRow(userId, overrides){
  return { user_id: userId, sub_services: ["Netflix", "Stan"], store_services: [], services_only: false,
    touched: true, taste: { mood: 1 }, watch_windows: { cinema: true }, never_show: [], onb_depth: "shallow",
    framing: false, moving_seen: { x: 1 }, occasions: [], ref_code: "CAS1045REF", ...overrides };
}

test("CAS-1045: a sign-in adopts the account's user_prefs row rather than echoing this device's stale local copy over it, and never writes when nothing is genuinely pending", async () => {
  const E = loadEngine();
  const acctId = "cas1045-acct-x";

  // This device's earlier session as acctId: the account already has services + touched:true.
  const client1 = fakeClient({ selects: { user_prefs: () => ({ data: [serverRow(acctId)], error: null }) } });
  signIn(E, acctId, client1);
  await E.CascadePersistence.loadAccount();
  await E.CascadePersistence.loadUserPrefs();
  assert.deepEqual([...E.prefs.sub].sort(), ["Netflix", "Stan"], "sanity: this device adopted and locally cached the account's real services");
  assert.equal(E.prefs.touched, true, "sanity: this device's local cache also carries touched:true");
  assert.equal(client1.upsertCalls.filter(c => c.table === "user_prefs").length, 0, "sanity: a clean load of a fully-populated row must not push anything back");

  // Sign out — CAS-957's loadGuest() switches this device's in-memory prefs to the guest's own (blank)
  // local copy, exactly like a real sign-out. acctId's own local cache is untouched on disk.
  E.CascadePersistence.loadGuest();
  assert.equal(E.prefs.touched, false, "sanity: signed out, in-memory prefs are the guest's blank defaults");

  // Another device adds a service while this one was signed out — touched is untouched by that edit.
  const client2 = fakeClient({ selects: { user_prefs: () => ({ data: [serverRow(acctId, { sub_services: ["Netflix", "Stan", "Binge"] })], error: null }) } });

  // Sign back in, in the exact order fireAccountFanout uses in production: replayOutbox() first, then
  // loadAccount()/loadUserPrefs(). If replayOutbox ever echoes the in-memory prefs (still the guest's blank
  // copy at this point) back to the account, this is where it would happen.
  signIn(E, acctId, client2);
  await E.CascadePersistence.replayOutbox();
  assert.equal(client2.upsertCalls.filter(c => c.table === "user_prefs").length, 0,
    "replayOutbox must never push user_prefs when this device holds no genuinely unsent edit for this account");

  await E.CascadePersistence.loadAccount();
  await E.CascadePersistence.loadUserPrefs();

  assert.deepEqual([...E.prefs.sub].sort(), ["Binge", "Netflix", "Stan"], "device must show the account's real (newer) service list after sign-in");
  assert.equal(E.prefs.touched, true, "touched must never be reset by a sign-in — the other device's edit never touched it");
  assert.equal(client2.upsertCalls.filter(c => c.table === "user_prefs").length, 0,
    "a sign-in that adopts the server row cleanly must never write user_prefs at all");

  signOut(E);
});

test("CAS-1045: replayOutbox still replays a user_prefs edit this device genuinely never got to push", async () => {
  const E = loadEngine();
  const acctId = "cas1045-acct-y";
  const client1 = fakeClient({ selects: { user_prefs: () => ({ data: [serverRow(acctId)], error: null }) } });
  signIn(E, acctId, client1);
  await E.CascadePersistence.loadAccount();
  await E.CascadePersistence.loadUserPrefs();

  // A genuine edit on this device, arming the outbox exactly as scheduleUserPrefsSync does — standing in
  // for a real edit whose debounce never got to fire before the tab died.
  E.prefs.sub.add("Binge");
  const userPrefsRow = E.CascadePersistence.userPrefsRow();
  E.CascadePersistence.outbox.user_prefs = { _: userPrefsRow };
  assert.ok(E.CascadePersistence.outboxPending("user_prefs")._, "sanity: the edit is armed as genuinely pending");

  const client2 = fakeClient({ selects: { user_prefs: () => ({ data: [serverRow(acctId)], error: null }) } });
  signIn(E, acctId, client2);
  await E.CascadePersistence.replayOutbox();
  assert.ok(client2.upsertCalls.some(c => c.table === "user_prefs"),
    "a genuinely pending edit must still be replayed on the next sign-in/boot");

  signOut(E);
});

// CAS-1053: production reported Rental/Streaming both showing "you haven't picked any services yet" for an
// account that has had services for weeks — watchMineOnlyDeadEndHTML's own gate (mineOnly && !servicesPicked())
// has no idea whether "no services" means the account genuinely has none, or user_prefs simply hasn't loaded
// yet on this boot. A fresh device (or one whose local cache doesn't yet carry this account's prefs) reads as
// the former until loadUserPrefs resolves, so it showed the dead end instead of waiting.
test("CAS-1053 AC1/AC4: the loading state wins the race while user_prefs is unresolved, and the real services are adopted once it loads", async () => {
  const E = loadEngine();   // a fresh engine == a fresh device's empty local storage, per CAS-1045's own tests
  const acctId = "cas1053-acct-fresh";
  const client = fakeClient({ selects: { user_prefs: () => ({ data: [serverRow(acctId)], error: null }) } });
  signIn(E, acctId, client);
  await E.CascadePersistence.loadAccount();

  // Mid-flight: user_prefs hasn't resolved yet, so prefs.sub/store are still this fresh device's empty
  // defaults — exactly the moment the false dead end used to render.
  E.CascadePersistence.userPrefsReady = false;
  assert.equal(E.servicesPicked(), false, "sanity: a fresh device has no services loaded yet");
  assert.equal(E.watchMineOnlyEmptyKind(true, true), "loading",
    "AC4: must show the loading state, not the dead end, while user_prefs is still unresolved");

  await E.CascadePersistence.loadUserPrefs();

  assert.deepEqual([...E.prefs.sub].sort(), ["Netflix", "Stan"], "AC1: the account's real services are adopted");
  assert.equal(E.servicesPicked(), true);
  assert.equal(E.watchMineOnlyEmptyKind(true, true), null,
    "AC1: with services picked, neither empty variant applies — the real listing shows instead");

  signOut(E);
});

// CAS-1053 AC3: syncOutcome (CAS-787) used to be written only by runUserPrefsSync (a push), so a device that
// only ever reads a clean, fully-populated row — the common case — left the diagnostics panel reporting
// user_prefs "not yet attempted" forever, indistinguishable from a load that never ran.
test("CAS-1053 AC3: a clean sign-in load records user_prefs OK in diagnostics", async () => {
  const E = loadEngine();
  const acctId = "cas1053-acct-diag";
  const client = fakeClient({ selects: { user_prefs: () => ({ data: [serverRow(acctId)], error: null }) } });
  signIn(E, acctId, client);
  await E.CascadePersistence.loadAccount();
  await E.CascadePersistence.loadUserPrefs();

  const report = E.CascadePersistence.syncOutcomeReport().find(r => r.target === "user_prefs");
  assert.ok(report, "user_prefs must appear in the sync outcome report");
  assert.equal(report.ok, true, "a clean load with nothing to push must record success, not stay 'not yet attempted'");
  assert.notEqual(report.when, null);

  signOut(E);
});
