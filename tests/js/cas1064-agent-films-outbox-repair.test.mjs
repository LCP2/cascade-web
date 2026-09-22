// CAS-1064: agent_films writes were failing with a foreign-key violation (23503) and retrying forever —
// nothing ever told the outbox that a rejection like that can never succeed, so the row stayed queued and
// the "not yet saved" banner never cleared. Two root causes, per the ticket's own hypothesis: (1) an
// agent_films row can be queued before its own cascade has reached the account (replayOutbox raced the two
// pushes concurrently), and (2) an agent_films row can be queued for a cascade that was later deleted on
// this device, so it can never succeed at all. This file drives the real seam (CascadePersistence.
// syncAgentFilmsNow/replayOutbox/pruneOrphanAgentFilmOutbox/outboxPending), the same convention
// outbox-durability.test.mjs and cas1049/cas1054's own agent_films tests use, with a stubbed Supabase client.
import test from "node:test";
import assert from "node:assert/strict";
import { loadEngine } from "./engine.mjs";

function signIn(E, client, userId = "cas1064-test-user"){
  const auth = E.CascadeAuth;
  auth.enabled = true; auth.client = client; auth.session = { user: { id: userId } };
}
function signOut(E){
  const auth = E.CascadeAuth;
  auth.enabled = false; auth.client = null; auth.session = null;
}
// A fake client whose agent_films/cascades upsert behaviour is driven per table by the caller — everything
// else (delete, select, other tables) succeeds with empty data, the same permissive-default shape
// outbox-durability.test.mjs's fakeClient uses.
function fakeClient({ upserts = {} } = {}){
  const calls = [];
  return {
    calls,
    from(table){
      return {
        upsert(rows){
          calls.push({ table, rows });
          const spec = upserts[table];
          const err = typeof spec === "function" ? spec(rows) : spec;
          const result = err ? { data: null, error: err }
            : { data: rows.map(r => ({ ...r, updated_at: "2026-01-01T00:00:00.000Z" })), error: null };
          return { then(resolve, reject){ return Promise.resolve(result).then(resolve, reject); },
                   select(){ return Promise.resolve(result); } };
        },
        select(){
          const thenable = { then(resolve){ return Promise.resolve({ data: [], error: null }).then(resolve); } };
          thenable.order = () => thenable; thenable.limit = () => thenable; thenable.eq = () => thenable;
          thenable.range = () => Promise.resolve({ data: [], error: null });
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

test("CAS-1064 AC1: an agent_films push rejected with 23503 drops that entry from the outbox, logs it, and leaves other entries untouched", async () => {
  const E = loadEngine();
  const badCascade = "cas1064-bad-cascade", goodCascade = "cas1064-good-cascade";
  const filmBad = E.MOVIES[0].tmdb_id, filmGood = E.MOVIES[1].tmdb_id;
  const client = fakeClient({
    // A real FK violation fails the WHOLE multi-row statement, not just the offending row — the fix must
    // retry singly to tell them apart, the same shape cascades' own 42501 handling already uses.
    upserts: { agent_films: rows => rows.some(r => r.cascade_id === badCascade)
      ? { code: "23503", message: 'insert or update on table "agent_films" violates foreign key constraint "agent_films_cascade_id_fkey"' }
      : null },
  });
  signIn(E, client);
  try{
    E.CascadePersistence.setAgentFilm(badCascade, filmBad, { admission_score: 50, admission_status: "stream", agent_sig: "sig-bad" });
    E.CascadePersistence.setAgentFilm(goodCascade, filmGood, { admission_score: 50, admission_status: "stream", agent_sig: "sig-good" });
    await E.CascadePersistence.syncAgentFilmsNow();

    const pending = E.CascadePersistence.outboxPending("agent_films");
    assert.ok(!(badCascade + "::" + filmBad in pending), "the permanently-rejected row must be dropped from the outbox");
    assert.ok(!(goodCascade + "::" + filmGood in pending), "the other row in the same batch must still have synced normally");

    const failedRows = E.usageQueue.filter(q => q.type === "sync_failed");
    assert.ok(failedRows.some(r => r.data.table === "agent_films" && r.data.code === "23503"),
      "the permanent rejection must be logged via the existing client-health sync_failed path");
  } finally{ signOut(E); }
});

test("CAS-1064 AC2: a transient (network) agent_films failure keeps the entry queued, and a later retry drains it", async () => {
  const E = loadEngine();
  const cascadeId = "cas1064-transient-cascade";
  const film = E.MOVIES[0].tmdb_id;
  let attempt = 0;
  const client = fakeClient({ upserts: { agent_films: () => { attempt++; return attempt === 1 ? { message: "network down" } : null; } } });
  signIn(E, client);
  try{
    E.CascadePersistence.setAgentFilm(cascadeId, film, { admission_score: 50, admission_status: "stream", agent_sig: "sig" });
    await E.CascadePersistence.syncAgentFilmsNow();

    assert.ok(cascadeId + "::" + film in E.CascadePersistence.outboxPending("agent_films"),
      "a transient failure must leave the row queued, not drop it");
    assert.equal(E.CascadePersistence.syncOutcome.agent_films.ok, false, "the failed attempt must still be recorded");

    await E.CascadePersistence.syncAgentFilmsNow();   // the network recovers on this attempt
    assert.ok(!(cascadeId + "::" + film in E.CascadePersistence.outboxPending("agent_films")),
      "a retry that succeeds must clear the row exactly like any other successful push");
  } finally{ signOut(E); }
});

test("CAS-1064 AC3: an outbox entry for an unknown cascade_id is pruned on boot, without a network round trip", () => {
  const E = loadEngine();
  const cascadeId = "cas1064-deleted-cascade";
  const film = E.MOVIES[0].tmdb_id;
  // No client signed in at all — pruning must not depend on connectivity.
  const client = fakeClient({ upserts: { agent_films: () => { throw new Error("must not attempt a network push"); } } });
  signIn(E, client);
  try{
    E.CascadePersistence.setAgentFilm(cascadeId, film, { admission_score: 50, admission_status: "stream", agent_sig: "sig" });
    assert.ok(cascadeId + "::" + film in E.CascadePersistence.outboxPending("agent_films"), "sanity: the row is queued");
    assert.equal(E.cascades.some(c => c.id === cascadeId), false, "sanity: this device has no such agent");

    E.CascadePersistence.pruneOrphanAgentFilmOutbox();

    assert.ok(!(cascadeId + "::" + film in E.CascadePersistence.outboxPending("agent_films")),
      "an outbox entry naming an agent this device doesn't have must be pruned on boot");
  } finally{ signOut(E); }
});

test("CAS-1064 AC4: a new agent and one of its agent_films rows queued together push in order — agent_films only sent after cascades confirms", async () => {
  const E = loadEngine();
  const cascadeId = "cas1064-new-agent";
  const film = E.MOVIES[0].tmdb_id;
  const createdCascades = new Set();
  const client = {
    from(table){
      if(table === "cascades"){
        return { upsert(rows){
          const result = { data: rows.map(r => ({ id: r.id, updated_at: "2026-01-01T00:00:00.000Z" })), error: null };
          // Resolves on a later tick and only marks the cascade "created" once this actually lands — not
          // at call time — the same way a real network round trip would.
          return { select(){ return new Promise(res => setTimeout(res, 5))
            .then(() => { rows.forEach(r => createdCascades.add(r.id)); return result; }); } };
        } };
      }
      if(table === "agent_films"){
        return {
          upsert(rows){
            const missing = rows.some(r => !createdCascades.has(r.cascade_id));
            const result = missing ? { data: null, error: { code: "23503", message: "violates foreign key constraint" } }
                                    : { data: rows, error: null };
            return { then(resolve, reject){ return Promise.resolve(result).then(resolve, reject); } };
          },
          select(){
            const thenable = { then(resolve){ return Promise.resolve({ data: [], error: null }).then(resolve); } };
            thenable.range = () => Promise.resolve({ data: [], error: null });
            return thenable;
          },
          delete(){ const chain = { then(resolve){ return Promise.resolve({ data: [], error: null }).then(resolve); } };
            chain.eq = () => chain; chain.in = () => chain; return chain; },
        };
      }
      // Every other outbox target replayOutbox also drives: a permissive no-op, nothing under test here.
      return {
        upsert(rows){ const r = { data: rows, error: null };
          return { then(resolve){ return Promise.resolve(r).then(resolve); }, select(){ return Promise.resolve(r); } }; },
        select(){ const t = { then(resolve){ return Promise.resolve({ data: [], error: null }).then(resolve); } };
          t.order = () => t; t.limit = () => t; t.eq = () => t; t.range = () => Promise.resolve({ data: [], error: null }); return t; },
        delete(){ const c = { then(resolve){ return Promise.resolve({ data: [], error: null }).then(resolve); } };
          c.eq = () => c; c.in = () => c; return c; },
      };
    },
  };
  signIn(E, client);
  try{
    const c = E.normCascade({ kind: "stream", status: [] });
    c.id = cascadeId; c.paused = false; c.order = 0;
    E.cascades.push(c);
    E.CascadePersistence.saveCascades();   // the real edit chokepoint: marks dirty + schedules the cascades sync
    E.CascadePersistence.setAgentFilm(cascadeId, film, { admission_score: 50, admission_status: "stream", agent_sig: "sig" });

    await E.CascadePersistence.replayOutbox();

    assert.ok(createdCascades.has(cascadeId), "sanity: the cascade push must have actually landed");
    assert.equal(E.CascadePersistence.syncOutcome.agent_films.ok, true,
      "the agent_films row must sync successfully once its cascade is confirmed, not race ahead of it");
    assert.ok(!(cascadeId + "::" + film in E.CascadePersistence.outboxPending("agent_films")),
      "the agent_films row must be cleared from the outbox once it actually succeeded");
  } finally{ signOut(E); }
});
