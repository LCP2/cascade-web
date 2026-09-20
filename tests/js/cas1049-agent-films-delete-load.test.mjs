// CAS-1049 AC1/AC2 — agent_films sync still failed on sign-in ("TypeError: Failed to fetch") after
// CAS-1039, because the delete phase fanned out one DELETE per pending row via Promise.all (up to
// SYNC_CHUNK_SIZE concurrent requests on a first sign-in's large pending-delete set), and loadAgentFilms
// selected with no range, so a remote table over PostgREST's 1,000-row default cap loaded incomplete.
// AC1: deletes are grouped by cascade_id and sent one .in("movie_id",...) request per
// AGENT_DELETE_CHUNK_SIZE ids, awaited sequentially — never more than one delete request in flight.
// AC2: loadAgentFilms pages with .range() until a page comes back short, so a 2,500-row remote table
// loads completely.
import test from "node:test";
import assert from "node:assert/strict";
import { loadEngine } from "./engine.mjs";

function signIn(E, client, userId = "cas1049-test-user"){
  const auth = E.CascadeAuth;
  auth.enabled = true; auth.client = client; auth.session = { user: { id: userId } };
}
function signOut(E){
  const auth = E.CascadeAuth;
  auth.enabled = false; auth.client = null; auth.session = null;
}

// Tracks concurrency of delete requests directly (resolution deferred a tick, so an accidental
// Promise.all fan-out would show more than one in flight at once) and resolves upserts immediately.
function makeConcurrencyTrackingClient(){
  let inFlight = 0, maxInFlight = 0;
  const deleteCalls = [];
  return {
    deleteCalls, getMaxInFlight: () => maxInFlight,
    from(table){
      return {
        upsert(rows){
          return { then(resolve, reject){ return Promise.resolve({ data: rows, error: null }).then(resolve, reject); } };
        },
        select(){
          const thenable = { then(resolve){ return Promise.resolve({ data: [], error: null }).then(resolve); } };
          thenable.order = () => thenable; thenable.limit = () => thenable; thenable.eq = () => thenable;
          thenable.range = () => thenable;
          return thenable;
        },
        delete(){
          const chain = { _eq: {} };
          chain.eq = (col, val) => { chain._eq[col] = val; return chain; };
          chain.in = (col, vals) => {
            const call = { table, eq: { ...chain._eq, [col]: vals } };
            deleteCalls.push(call);
            inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
            return {
              then(resolve, reject){
                return new Promise(res => setTimeout(res, 0))
                  .then(() => { inFlight--; resolve({ data: [], error: null }); })
                  .catch(reject);
              },
            };
          };
          return chain;
        },
      };
    },
  };
}

test("CAS-1049 AC1: 3,000 pending agent_films deletes take no more than ceil(3000/100) requests, never more than 1 in flight", async () => {
  const E = loadEngine();
  const client = makeConcurrencyTrackingClient();
  signIn(E, client);
  try{
    const cascadeIds = ["cas1049-a", "cas1049-b", "cas1049-c"];
    for(let i=0;i<3000;i++){
      E.CascadePersistence.setAgentFilm(cascadeIds[i % cascadeIds.length], 9700000+i,
        { admission_score: 50, admission_status: "stream", agent_sig: "sig-"+i });
    }
    await E.CascadePersistence.syncAgentFilmsNow();   // full resync — seeds agentFilmsKnown, no deletes yet

    for(let i=0;i<3000;i++) E.CascadePersistence.clearAgentFilm(cascadeIds[i % cascadeIds.length], 9700000+i);
    client.deleteCalls.length = 0;

    await E.CascadePersistence.syncAgentFilmsNow();

    const calls = client.deleteCalls.filter(c => c.table==="agent_films");
    const totalIds = calls.reduce((n,c) => n + c.eq.movie_id.length, 0);
    assert.equal(totalIds, 3000, "every pending delete must be sent exactly once across all chunks");
    calls.forEach(c => assert.ok(c.eq.movie_id.length <= 100, `a delete request carried ${c.eq.movie_id.length} ids, over the 100 cap`));
    assert.ok(calls.length <= Math.ceil(3000/100), `expected at most 30 delete requests, got ${calls.length}`);
    assert.equal(client.getMaxInFlight(), 1, "no more than one delete request must ever be in flight at a time");
    assert.equal(E.CascadePersistence.syncOutcome.agent_films.ok, true);
  } finally{ signOut(E); }
});

test("CAS-1049 AC2: a remote table of 2,500 agent_films rows loads completely via paging", async () => {
  const E = loadEngine();
  const cascadeIds = ["cas1049-load-a", "cas1049-load-b"];
  const allRows = [];
  for(let i=0;i<2500;i++){
    allRows.push({
      cascade_id: cascadeIds[i % cascadeIds.length], movie_id: String(9800000+i),
      admitted_at: "2026-09-20T00:00:00.000Z", admission_score: 50, admission_status: "stream", agent_sig: "sig-"+i,
    });
  }
  const selectCalls = [];
  const client = {
    from(){
      return {
        select(){
          const thenable = {
            range(from, to){
              selectCalls.push([from, to]);
              const slice = allRows.slice(from, to+1);
              return Promise.resolve({ data: slice, error: null });
            },
          };
          return thenable;
        },
      };
    },
  };
  signIn(E, client);
  try{
    await E.CascadePersistence.loadAgentFilms();
    assert.ok(selectCalls.length > 1, "sanity: 2,500 rows must have taken more than one page");
    const known = E.CascadePersistence.agentFilmsKnown;
    assert.equal(known.size, 2500, "every remote row must be present after paging, none dropped by the 1,000-row default cap");
    allRows.forEach(r => assert.ok(known.has(r.cascade_id+"::"+r.movie_id), `row ${r.cascade_id}::${r.movie_id} missing after load`));
  } finally{ signOut(E); }
});
