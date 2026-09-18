// CAS-1035: a Watch On tick (or any other account write) made inside its own 500ms debounce, then lost to
// a tab closing or being backgrounded-and-killed, used to revert on the next boot — nothing durable ever
// recorded that the push was still owed, and clearAccountNotify()/applyFilmRows()/applyAgentFilmRows() all
// rebuild their state from whatever the account happened to have, wiping an edit the account never saw.
// These tests drive the real seam (CascadePersistence.flushAccountSync/replayOutbox/outboxPending, the
// same convention acct-read.test.mjs and sync-outcomes.test.mjs use) with a stubbed Supabase client.
import test from "node:test";
import assert from "node:assert/strict";
import { loadEngine } from "./engine.mjs";

// A minimal fake client whose upsert/select behaviour is driven per table by the caller — everything else
// (delete, other tables) succeeds with empty data, the same permissive default fakeUpsertClient's sibling
// helpers in sync-outcomes.test.mjs use.
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
function signIn(E, client, userId = "cas1035-test-user"){
  const auth = E.CascadeAuth;
  auth.enabled = true; auth.client = client; auth.session = { user: { id: userId } };
}
function signOut(E){
  const auth = E.CascadeAuth;
  auth.enabled = false; auth.client = null; auth.session = null;
}
// toggleFilmOpt no-ops on a level watchLevelsFor marks "spent" for that film's own rung — pick a film
// where "stream" (the last rung, so it's spent only for something already fully past it) is genuinely
// available, rather than assuming MOVIES[0] happens to qualify.
function pickStreamableFilm(E){
  const film = E.MOVIES.find(m => {
    const row = E.watchLevelsFor(m.tmdb_id).find(l => l.key === "stream");
    return row && !row.spent;
  });
  if(!film) throw new Error("no fixture film has an available Stream level — this test would prove nothing");
  return film;
}

test("CAS-1035 AC1: a change followed immediately by flushAccountSync attempts the push before the 500ms debounce — no wait", () => {
  const E = loadEngine();
  const client = fakeClient();
  signIn(E, client);
  try{
    const film = pickStreamableFilm(E);
    E.toggleFilmOpt(film.tmdb_id, "stream");   // saveNotify -> scheduleWatchSync (500ms setTimeout)
    assert.equal(client.upsertCalls.length, 0, "sanity: the debounce hasn't fired yet");

    E.CascadePersistence.flushAccountSync();   // cancels the debounce, calls runWatchSync() directly
    // No await, no timer advance: flushAccountSync is synchronous up to the point it kicks off the
    // network call, so the upsert must already be recorded the instant this line returns.
    assert.ok(client.upsertCalls.some(c => c.table === "film_watch"),
      "the film_watch push must be attempted synchronously, not after the 500ms debounce");
  } finally{ signOut(E); }
});

test("CAS-1035 AC2: a failed film_watch push leaves an outbox entry; a simulated reboot replays it before loadFilmWatches applies an older remote row, and the local tick survives", async () => {
  const store = new Map();   // shared localStorage backing — the CAS-969 "simulated reboot" technique
  const E1 = loadEngine({ localStorageStore: store });
  const film = pickStreamableFilm(E1);
  const movieId = String(film.tmdb_id);

  const failingClient = fakeClient({ upserts: { film_watch: { message: "network down" } } });
  signIn(E1, failingClient);
  E1.toggleFilmOpt(film.tmdb_id, "stream");
  await E1.CascadePersistence.syncWatchesNow();   // forces the push attempt (skips the 500ms wait) — fails

  const pending = E1.CascadePersistence.outboxPending("film_watch");
  assert.ok(movieId in pending, "a failed push must leave a durable outbox entry for this movie");
  assert.equal(E1.notify[film.tmdb_id].wins.stream, true, "sanity: the local tick itself is still on");

  // Simulated reboot: a fresh JS realm (new loadEngine call) sharing the same localStorage-backed outbox —
  // `notify` itself is also restored from localStorage at top-level init, exactly as a real page load does.
  const E2 = loadEngine({ localStorageStore: store });
  assert.equal(E2.notify[film.tmdb_id]?.wins?.stream, true,
    "sanity: the tick survived the localStorage round-trip on its own, before any account load runs");

  // This boot's connection still fails the upsert, and film_watch's own read returns an OLDER remote row
  // for the same movie — no windows ticked at all, i.e. the state from before this device's tick.
  const staleRemoteRow = { movie_id: movieId, windows: [], sources: {}, updated_at: "2020-01-01T00:00:00.000Z" };
  const bootClient = fakeClient({
    upserts: { film_watch: { message: "still down" } },
    selects: { film_watch: () => ({ data: [staleRemoteRow], error: null }) },
  });
  signIn(E2, bootClient, "cas1035-test-user");
  try{
    await E2.CascadePersistence.replayOutbox();   // AC2: replayed BEFORE the load below
    assert.ok(bootClient.upsertCalls.some(c => c.table === "film_watch"),
      "replayOutbox must have attempted the film_watch push again on this boot");

    await E2.CascadePersistence.loadFilmWatches();   // the exact call fireAccountFanout makes next
    assert.equal(E2.notify[film.tmdb_id].wins.stream, true,
      "the local tick must survive a load whose remote row is older, even though the replay above also failed");
  } finally{ signOut(E2); }
});

// This is the requeue this ticket kept hitting on AC3 itself: outboxMark's own persist is coalesced onto a
// microtask (recomputeFound's bulk admission pass needs that batching, or the whole loop is O(catalogue^2) —
// see the O(n^2) fix above), which is NOT guaranteed to have run yet the instant a real pagehide fires — a
// reload landing in that exact gap durably lost the row despite outboxPending() already showing it pending
// in memory. flushAccountSync (the pagehide/hidden handler) must force that persist through synchronously,
// with no await anywhere in this test standing in for the microtask tick a real close doesn't guarantee.
test("CAS-1035 AC3 regression: flushAccountSync durably persists the outbox before any microtask can, so a reload landing immediately after it never loses the mark", () => {
  const store = new Map();
  const E1 = loadEngine({ localStorageStore: store });
  const film = pickStreamableFilm(E1);
  const movieId = String(film.tmdb_id);

  const client = fakeClient({ upserts: { film_watch: { message: "network down" } } });
  signIn(E1, client);
  E1.toggleFilmOpt(film.tmdb_id, "stream");
  assert.ok(movieId in E1.CascadePersistence.outboxPending("film_watch"),
    "sanity: the mark is visible in memory immediately");

  // No await here — a real pagehide is not preceded by one either. If the fix regresses to relying on the
  // deferred microtask alone, this call does nothing and the assertion below fails.
  E1.CascadePersistence.flushAccountSync();

  // Simulated reboot, same technique as AC2 above: a fresh JS realm sharing the same localStorage-backed
  // outbox, with nothing awaited between the mark and this "reload".
  const E2 = loadEngine({ localStorageStore: store });
  assert.ok(movieId in E2.CascadePersistence.outboxPending("film_watch"),
    "the outbox entry must already be durable in localStorage by the time flushAccountSync returns");
  signOut(E1);
});

test("CAS-1035: outboxPending clears once its push actually succeeds", async () => {
  const E = loadEngine();
  const client = fakeClient({ upserts: { film_watch: null } });   // succeeds
  const film = pickStreamableFilm(E);
  signIn(E, client);
  try{
    E.toggleFilmOpt(film.tmdb_id, "stream");
    assert.ok(String(film.tmdb_id) in E.CascadePersistence.outboxPending("film_watch"),
      "sanity: scheduling the sync marks the row pending immediately");

    await E.CascadePersistence.syncWatchesNow();
    assert.ok(!(String(film.tmdb_id) in E.CascadePersistence.outboxPending("film_watch")),
      "a successful push must clear its own outbox entry");
  } finally{ signOut(E); }
});
