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
