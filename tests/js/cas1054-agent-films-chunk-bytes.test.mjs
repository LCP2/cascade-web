// CAS-1054 AC1/AC2 — agent_films upserts still failed ("TypeError: Failed to fetch"/"Load failed") on
// production after CAS-1049, because that fix addressed concurrency, not the real cause. agent_films
// rows carry agent_sig — cascSigOf(cascade) JSON.stringify'd whole, ~400-500 bytes on a real agent — so a
// chunk capped at SYNC_CHUNK_SIZE (200 rows) routinely produced a 100-150KB request body. A live
// reproduction against the real Supabase project (lee+c21@codynamics.com.au, this ticket's authorised
// throwaway) confirmed a realistic 200-row chunk of that shape is 144.5KB and that an identical POST
// straight from Node (no browser, no keepalive) succeeds every time with 201 — ruling out every
// server-side cause (gateway size cap, a bad row value, the on_conflict target, a trigger, a missing FK).
// The real limit is the browser's own: every fetch this client makes carries keepalive:true (CAS-1035),
// and a keepalive fetch whose body exceeds a 64KiB quota (shared across every in-flight keepalive fetch
// on the page) is rejected client-side, before it ever reaches the network — a bare "Failed to fetch",
// on every browser, regardless of how many requests are concurrent.
//
// Fix: chunk agent_films upserts by cumulative JSON byte size (AGENT_FILMS_UPSERT_BYTE_CAP), not row
// count. This test reproduces the failing shape (200 rows, realistic agent_sig size) and asserts every
// chunk actually sent stays comfortably under the browser's 64KiB quota.
import test from "node:test";
import assert from "node:assert/strict";
import { loadEngine } from "./engine.mjs";

const BROWSER_KEEPALIVE_QUOTA_BYTES = 65536;

function signIn(E, client, userId = "cas1054-test-user"){
  const auth = E.CascadeAuth;
  auth.enabled = true; auth.client = client; auth.session = { user: { id: userId } };
}
function signOut(E){
  const auth = E.CascadeAuth;
  auth.enabled = false; auth.client = null; auth.session = null;
}

// Mirrors cascSigOf's own shape closely enough to reproduce its real size: a JSON array of a cascade's
// whole criteria (genre/culture/exclude lists, watchMarkers/watchWindows objects, service list, etc).
function realisticAgentSig(i){
  return JSON.stringify([
    `Agent ${i}`, "active", ["Action","Drama","Comedy","Thriller"], ["Horror"],
    { lo: 0, hi: 99 }, ["AU","US","UK","NZ"], { lo: 2000, hi: 2026 },
    { lo: 0, hi: 100 }, { lo: 0, hi: 100 }, ["oscar","bafta"], { lo: 0, hi: 500 },
    false, false, false, 3, 2, 1, 4, 2, false, 5, false, 40,
    { hits_cinema: true, hits_stream: true }, ["netflix","stan","binge","prime"], "release_date",
    false, false, { hits_rent: "2026-01-01" },
  ]);
}

function makeByteTrackingClient(){
  const upsertCalls = [];
  return {
    upsertCalls,
    from(table){
      return {
        upsert(rows){
          upsertCalls.push({ table, rows, bytes: Buffer.byteLength(JSON.stringify(rows), "utf8") });
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
          chain.eq = () => chain;
          chain.in = () => ({ then(resolve){ return Promise.resolve({ data: [], error: null }).then(resolve); } });
          return chain;
        },
      };
    },
  };
}

test("CAS-1054 AC2: a 200-row agent_films chunk with realistic agent_sig sizes never sends a request over the browser's keepalive quota", async () => {
  const E = loadEngine();
  const client = makeByteTrackingClient();
  signIn(E, client);
  try{
    for(let i=0;i<200;i++){
      E.CascadePersistence.setAgentFilm("cas1054-cascade", 9_600_000+i,
        { admission_score: 50, admission_status: "stream", agent_sig: realisticAgentSig(i%10) });
    }
    // Sanity: this exact shape is what production hit — confirm it would have been an oversized single
    // chunk under the old row-count-only chunker (proves this test reproduces the real failure).
    const rows = E.CascadePersistence.agentFilmDirtyRows();
    assert.equal(rows.length, 200);
    const wholeBatchBytes = Buffer.byteLength(JSON.stringify(rows), "utf8");
    assert.ok(wholeBatchBytes > BROWSER_KEEPALIVE_QUOTA_BYTES,
      `test sanity: a 200-row batch of this shape must exceed the 64KiB quota to reproduce CAS-1054 (was ${wholeBatchBytes} bytes)`);

    await E.CascadePersistence.syncAgentFilmsNow();

    assert.ok(client.upsertCalls.length > 1, "200 realistically-sized rows must take more than one chunk");
    let totalRows = 0;
    for(const call of client.upsertCalls){
      totalRows += call.rows.length;
      assert.ok(call.bytes <= BROWSER_KEEPALIVE_QUOTA_BYTES,
        `an upsert chunk was ${call.bytes} bytes, over the browser's ${BROWSER_KEEPALIVE_QUOTA_BYTES}-byte keepalive quota`);
    }
    assert.equal(totalRows, 200, "every dirty row must still be sent exactly once across all chunks");
    assert.equal(E.CascadePersistence.syncOutcome.agent_films.ok, true);
  } finally{ signOut(E); }
});

test("CAS-1054: chunkAgentFilmRows caps cumulative JSON byte size, not just row count", () => {
  const E = loadEngine();
  const rows = [];
  for(let i=0;i<500;i++){
    rows.push({ user_id:"u", cascade_id:"c", movie_id:String(i), admitted_at:"2026-09-20T00:00:00.000Z",
      admission_score:50, admission_status:"stream", agent_sig: realisticAgentSig(i%10) });
  }
  const chunks = E.CascadePersistence.chunkAgentFilmRows(rows);
  assert.ok(chunks.length > 1);
  const cap = E.CascadePersistence.AGENT_FILMS_UPSERT_BYTE_CAP;
  let total = 0;
  for(const chunk of chunks){
    total += chunk.length;
    const bytes = Buffer.byteLength(JSON.stringify(chunk), "utf8");
    assert.ok(bytes <= cap, `chunk of ${chunk.length} rows was ${bytes} bytes, over the ${cap}-byte cap`);
  }
  assert.equal(total, 500, "every row must appear in exactly one chunk");
});
