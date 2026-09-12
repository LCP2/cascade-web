// CAS-957: device caches (the agent list first among them) used to be keyed to the DEVICE, not the
// account — a second account signing in on the same device inherited whatever the first account left in
// localStorage, and the account fan-out's own "offer up what's genuinely new" merge (CAS-393/733/734) then
// tried to push those inherited rows back to Supabase under the wrong owner, which RLS correctly refused
// (42501) — or, worse, silently accepted for an id the account had simply never seen. These tests drive the
// real seams (loadAccount/loadGuest/syncNow, the same ones the auth-change listener calls in production and
// acct-read.test.mjs/sync-outcomes.test.mjs already drive directly) with a stubbed Supabase client. Each
// test loads its own fresh engine instance — acctSuffix and the one-shot legacy-migration flag are
// module-level state inside the engine, and these tests deliberately exercise transitions in that state, so
// they must never bleed into one another the way tests sharing one `loadEngine()` call safely can.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadEngine } from "./engine.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

function fakeCascadesClient({ selectRows = [], upsertHandler } = {}){
  return {
    from(table){
      assert.equal(table, "cascades", "this fake only serves the cascades table");
      return {
        select(){ return { order(){ return Promise.resolve({ data: selectRows, error: null }); } }; },
        upsert(rows){
          const result = upsertHandler
            ? upsertHandler(rows)
            : { data: rows.map(r => ({ id: r.id, updated_at: new Date().toISOString() })), error: null };
          return { select(){ return Promise.resolve(result); } };
        },
        delete(){
          return { eq(){ return { in(){ return Promise.resolve({ data: null, error: null }); } }; } };
        },
      };
    },
  };
}
function signIn(E, userId, client){
  const auth = E.CascadeAuth;
  auth.enabled = true; auth.client = client; auth.session = { user: { id: userId } };
}

test("CAS-957 AC2: a second account signing in on the same device never inherits the first account's agents, and never upserts either account's ids under the wrong owner", async () => {
  const E = loadEngine();

  // Sign in as A, save two agents.
  signIn(E, "cas957-acct-A", fakeCascadesClient({ selectRows: [] }));
  await E.CascadePersistence.loadAccount();
  assert.equal(E.cascades.length, 0, "sanity: A's account starts empty");
  E.cascades.push(
    E.normCascade({ id: "a1", kind: "stream", status: [] }),
    E.normCascade({ id: "a2", kind: "stream", status: [] }),
  );
  const aUpserts = [];
  signIn(E, "cas957-acct-A", fakeCascadesClient({
    upsertHandler: rows => { aUpserts.push(...rows); return { data: rows.map(r => ({ id: r.id, updated_at: new Date().toISOString() })), error: null }; },
  }));
  await E.CascadePersistence.syncNow();
  assert.deepEqual(aUpserts.map(r => r.id).sort(), ["a1", "a2"], "sanity: A's own two agents really did sync to A's account");

  // Sign out.
  E.CascadeAuth.enabled = false; E.CascadeAuth.client = null; E.CascadeAuth.session = null;
  E.CascadePersistence.loadGuest();
  assert.equal(E.cascades.length, 0, "signed out shows no agents");

  // Sign in as B, whose account already has one agent of its own. A real Supabase cascades row always
  // carries a genuine uuid id — cascadeKnown only remembers uuid-shaped rows (isUuid), so this fixture must
  // be uuid-shaped too, or the test would exercise a code path a real account row never takes.
  const B_ID = "b0000000-0000-4000-8000-000000000001";
  const bRow = { id: B_ID, user_id: "cas957-acct-B", name: "B agent", criteria: {}, alert_moments: [], active: true, created_at: "2026-01-01T00:00:00.000Z" };
  const bUpserts = [];
  signIn(E, "cas957-acct-B", fakeCascadesClient({
    selectRows: [bRow],
    upsertHandler: rows => { bUpserts.push(...rows); return { data: rows.map(r => ({ id: r.id, updated_at: new Date().toISOString() })), error: null }; },
  }));
  await E.CascadePersistence.loadAccount();

  assert.equal(JSON.stringify(E.cascades.map(c => c.id)), JSON.stringify([B_ID]), "B's list must contain exactly B's own agent, none of A's");
  assert.equal(E.CascadePersistence.cascadeDirtyRows().length, 0, "nothing should be dirty after a clean sign-in — no upsert is warranted for either account's ids");
  await E.CascadePersistence.syncNow();
  assert.equal(bUpserts.length, 0, "no upsert must actually be attempted for either account's ids");
});

test("CAS-957 AC3: a 42501-refused agent row is dropped, not retried, and the sync-degraded flag clears", async () => {
  const E = loadEngine();
  signIn(E, "cas957-acct-c", fakeCascadesClient({ selectRows: [] }));
  await E.CascadePersistence.loadAccount();
  E.cascades.push(E.normCascade({ id: "poisoned-id", kind: "stream", status: [] }));

  signIn(E, "cas957-acct-c", fakeCascadesClient({
    upsertHandler: () => ({ data: null, error: { code: "42501", message: "new row violates row-level security policy" } }),
  }));
  await E.CascadePersistence.syncNow();

  assert.equal(E.cascades.length, 0, "the refused row must be dropped from the local list");
  assert.equal(E.CascadePersistence.cascadeKnown.size, 0, "the refused row must be dropped from cascadeKnown too");
  assert.equal(E.CascadePersistence.anySyncTargetDegraded(), false, "a handled 42501 must not read as a degraded sync target");

  const secondUpserts = [];
  signIn(E, "cas957-acct-c", fakeCascadesClient({
    upsertHandler: rows => { secondUpserts.push(...rows); return { data: rows.map(r => ({ id: r.id, updated_at: new Date().toISOString() })), error: null }; },
  }));
  await E.CascadePersistence.syncNow();
  assert.equal(secondUpserts.length, 0, "a dropped row must never be retried on the next sync");
});

test("CAS-957 AC4: a device carrying pre-namespacing cascade_cascades data does not leak it into a different account signing in, and the legacy key is cleaned up", async () => {
  const E = loadEngine();
  E.localStorage.setItem("cascade_cascades", JSON.stringify([
    { id: "legacy-a-1", name: "A's old agent", kind: "stream", status: [] },
  ]));

  const B_ID = "b0000000-0000-4000-8000-0000000000b1";
  const bRow = { id: B_ID, user_id: "cas957-acct-d-B", name: "B real agent", criteria: {}, alert_moments: [], active: true, created_at: "2026-01-01T00:00:00.000Z" };
  signIn(E, "cas957-acct-d-B", fakeCascadesClient({ selectRows: [bRow] }));
  await E.CascadePersistence.loadAccount();

  assert.equal(JSON.stringify(E.cascades.map(c => c.id)), JSON.stringify([B_ID]), "the legacy account's agents must never reach a different account signing in");
  assert.equal(E.localStorage.getItem("cascade_cascades"), null, "the unnamespaced legacy key must be gone after the one-time migration");
});

test("CAS-957 AC5: every read of the agent-list cache goes through the namespaced accessor, never the bare literal key", () => {
  const src = fs.readFileSync(path.join(ROOT, "app_template.html"), "utf8");
  const count = (src.match(/localStorage\.getItem\("cascade_cascades"\)/g) || []).length;
  assert.equal(count, 0, "grep -c 'localStorage.getItem(\"cascade_cascades\")' app_template.html must return 0");
});
