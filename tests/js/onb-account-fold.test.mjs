// CAS-959: onboarding used to be idempotent against the DEVICE (cascade_onboarded), not the ACCOUNT — a
// device that walked the v2 wizard and committed a fresh roster, then signed in (the membership step's own
// email gate, CAS-387) to an account that already had its own agents, had its draft folded straight into
// the account by loadAccount()'s "genuinely new, fold it in" rule (CAS-393/733/734), duplicating the
// roster. These tests drive the real seam (CascadePersistence.loadAccount, onbV2CommittedSave/Load/Clear)
// with a stubbed Supabase client, the same convention acct-namespacing.test.mjs uses.
import test from "node:test";
import assert from "node:assert/strict";
import { loadEngine } from "./engine.mjs";

function fakeCascadesClient({ selectRows = [] } = {}){
  const upserts = [];
  return {
    upserts,
    from(table){
      assert.equal(table, "cascades", "this fake only serves the cascades table");
      return {
        select(){ return { order(){ return Promise.resolve({ data: selectRows, error: null }); } }; },
        upsert(rows){
          upserts.push(...rows);
          return { select(){ return Promise.resolve({ data: rows.map(r => ({ id: r.id, updated_at: new Date().toISOString() })), error: null }); } };
        },
        delete(){ return { eq(){ return { in(){ return Promise.resolve({ data: null, error: null }); } }; } }; },
      };
    },
  };
}
function signIn(E, userId, client){
  const auth = E.CascadeAuth;
  auth.enabled = true; auth.client = client; auth.session = { user: { id: userId } };
}

test("CAS-959 AC2/observation: an onboarding draft this device committed is dropped, not folded in, once the account it signs into already has its own agents — no insert/upsert of the draft's ids", async () => {
  const E = loadEngine();

  // The device walked v2_done before ever knowing the account's state — exactly what onboarding's own
  // commit does: push the built agents into `cascades` and remember them as an unconfirmed draft.
  const draft = [
    E.normCascade({ id: "draft-massive", name: "Massive Movies", kind: "stream", status: [] }),
    E.normCascade({ id: "draft-favs", name: "Personal Favs", kind: "stream", status: [] }),
  ];
  E.cascades.push(...draft);
  E.onbV2CommittedSave(draft);

  // The membership email gate now signs in — to an account that turns out to already have two agents of
  // its own (a second device's earlier onboarding run, per the ticket's own observed shape).
  const A_ID = "a0000000-0000-4000-8000-000000000001";
  const B_ID = "b0000000-0000-4000-8000-000000000002";
  const existingRows = [
    { id: A_ID, user_id: "cas959-acct", name: "Massive Movies", criteria: {}, alert_moments: [], active: true, created_at: "2026-01-01T00:00:00.000Z" },
    { id: B_ID, user_id: "cas959-acct", name: "Personal Favs", criteria: {}, alert_moments: [], active: true, created_at: "2026-01-01T00:00:01.000Z" },
  ];
  const client = fakeCascadesClient({ selectRows: existingRows });
  signIn(E, "cas959-acct", client);
  await E.CascadePersistence.loadAccount();

  assert.equal(JSON.stringify(E.cascades.map(c => c.id).sort()), JSON.stringify([A_ID, B_ID].sort()),
    "the account's own two agents must be adopted exactly — the draft must not survive alongside them");
  assert.equal(E.CascadePersistence.cascadeDirtyRows().length, 0,
    "nothing should be dirty after dropping the draft — no upsert is warranted");
  await E.CascadePersistence.syncNow();
  assert.equal(client.upserts.length, 0, "no insert/upsert of the draft's ids must be attempted");
  assert.equal(E.onbV2CommittedLoad(), null, "the discarded draft's marker must be cleared, not left to resurface");
});

test("CAS-959: a genuinely new account (no existing agents) still folds the onboarding draft in exactly as before", async () => {
  const E = loadEngine();
  const draft = [E.normCascade({ id: "draft-only", name: "Massive Movies", kind: "stream", status: [] })];
  E.cascades.push(...draft);
  E.onbV2CommittedSave(draft);

  const client = fakeCascadesClient({ selectRows: [] });
  signIn(E, "cas959-fresh-acct", client);
  await E.CascadePersistence.loadAccount();

  assert.equal(JSON.stringify(E.cascades.map(c => c.id)), JSON.stringify(["draft-only"]),
    "a first-run account with nothing of its own must still receive the freshly built roster");
  await E.CascadePersistence.syncNow();
  assert.deepEqual(client.upserts.map(r => r.id), ["draft-only"],
    "the genuinely-new roster must still sync to a genuinely-empty account");
});

test("CAS-959: a hand-built local agent that is NOT an onboarding draft still folds in even when the account already has agents (unrelated to this defect)", async () => {
  const E = loadEngine();
  E.cascades.push(E.normCascade({ id: "hand-built", name: "My own agent", kind: "stream", status: [] }));
  // No onbV2CommittedSave call — this agent was never part of an onboarding draft.

  const A_ID = "a0000000-0000-4000-8000-000000000003";
  const existingRows = [
    { id: A_ID, user_id: "cas959-acct-2", name: "Massive Movies", criteria: {}, alert_moments: [], active: true, created_at: "2026-01-01T00:00:00.000Z" },
  ];
  signIn(E, "cas959-acct-2", fakeCascadesClient({ selectRows: existingRows }));
  await E.CascadePersistence.loadAccount();

  assert.equal(JSON.stringify(E.cascades.map(c => c.id).sort()), JSON.stringify([A_ID, "hand-built"].sort()),
    "CAS-393/733/734's own fold-in for organic local work must be untouched by this fix");
});
