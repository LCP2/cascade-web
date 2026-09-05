// CAS-782: regression coverage for the existing pin stickiness (Lee's decision, 2026-09-04 — a film placed
// on an agent by hand stays there regardless of re-ranking, agent edits or status changes) plus the new
// release-on-delete behaviour this ticket adds: deleting the agent a film is pinned to must scrub that
// agent's id out of notify[*].pinnedTo/notIn and let the film fall back to ordinary agent-owned membership,
// rather than leaving it pointing at an agent that no longer exists (the `overridden` prune-guard at ~4984
// was what kept such an entry alive forever).
import test from "node:test";
import assert from "node:assert/strict";
import { loadEngine } from "./engine.mjs";

const E = loadEngine();

function withNotifyState(fn){
  const savedNotify = { ...E.notify };
  try{ fn(); }
  finally{
    Object.keys(E.notify).forEach(k => delete E.notify[k]);
    Object.assign(E.notify, savedNotify);
  }
}
function unseedCascade(id){
  const i = E.cascades.findIndex(c => c.id === id);
  if(i >= 0) E.cascades.splice(i, 1);
}
// A broad agent — no criteria narrowed at all — so whatever film we pick against it is a real match, not an
// assumption about the fixture catalogue's shape.
function broadCascade(id, order){
  const c = E.normCascade({ kind: "stream", status: [] });
  c.id = id; c.paused = false; c.order = order;
  return c;
}
function pickMatchingFilm(c){
  const m = E.MOVIES.find(x => !E.watched.has(x.tmdb_id) && !E.blocked.has(x.tmdb_id) && E.matchesCriteria(x, c));
  if(!m) throw new Error("no film in the harness catalogue matches a broad agent — this test would prove nothing");
  return m;
}
// The engine runs in its own vm realm — an array it hands back is a real Array by content but not by
// [[Prototype]], so assert.deepStrictEqual (what the "strict" assert's .deepEqual actually is) fails on two
// arrays that print identically. Spreading pulls the values into a plain array of THIS realm first.
const arr = a => [...(a || [])];

test("CAS-782 AC1: a hand-placed film stays on its agent across a re-order, an edit to another agent, and a status change", () => withNotifyState(() => {
  const cA = broadCascade("cas782-ac1-a", 5);
  const film = pickMatchingFilm(cA);
  const id = film.tmdb_id;
  const savedStatus = film.status;
  const offYear = E.yearOf(film) - 1;                 // a year the film provably is NOT — excludes it by criteria
  cA.year = [offYear];                                // A starts out NOT matching the film
  const cB = broadCascade("cas782-ac1-b", 1);
  cB.year = [offYear];                                // B never matches the film either — the pin is the only reason it's there
  E.cascades.push(cA, cB);
  try{
    assert.ok(!E.matchesCriteria(film, cA), "setup: A must not match the film yet");
    assert.ok(!E.matchesCriteria(film, cB), "setup: B's criteria must exclude the film");

    E.pinFilmToCascadeAndRepaint(id, cB.id);
    E.recomputeFound();
    assert.deepEqual(arr(E.notify[id].pinnedTo), [cB.id], "setup: the pin must land on B");
    assert.deepEqual(arr(E.notify[id].cascadeIds), [cB.id], "setup: the film must be found under B despite B's own criteria excluding it");

    // A re-order that makes agent A rank 1.
    cA.order = 0; cB.order = 1;
    E.recomputeFound();
    assert.deepEqual(arr(E.notify[id].cascadeIds), [cB.id], "AC1: re-ordering A to rank 1 must not move the film off B");

    // An edit to A that would have matched it.
    cA.year = [];
    assert.ok(E.matchesCriteria(film, cA), "setup: the edit must actually make A match the film now");
    E.recomputeFound();
    assert.deepEqual(arr(E.notify[id].cascadeIds), [cB.id], "AC1: an edit to A that now matches the film must not move it off B");

    // A status change.
    film.status = film.status.includes("in_cinema") ? ["rental"] : ["in_cinema"];
    E.recomputeFound();
    assert.deepEqual(arr(E.notify[id].cascadeIds), [cB.id], "AC1: a status change must not move the film off B");
  } finally{
    film.status = savedStatus;
    unseedCascade(cA.id); unseedCascade(cB.id);
  }
}));

test("CAS-782 AC2: deleting the agent a film is pinned to releases the film", () => withNotifyState(() => {
  const cA = broadCascade("cas782-ac2-a", 0);
  const film = pickMatchingFilm(cA);                  // A matches this film unassisted — it's what the film falls back to
  const id = film.tmdb_id;
  const cB = broadCascade("cas782-ac2-b", 1);
  cB.year = [E.yearOf(film) - 1];                      // B's own criteria exclude the film — only the pin puts it there
  E.cascades.push(cA, cB);
  try{
    E.pinFilmToCascadeAndRepaint(id, cB.id);
    E.recomputeFound();
    assert.deepEqual(arr(E.notify[id].pinnedTo), [cB.id], "setup: the pin must land on B");
    assert.deepEqual(arr(E.notify[id].cascadeIds), [cB.id], "setup: the film must be found under B");

    const deleted = E.deleteAgentAsk(cB);
    assert.equal(deleted, true, "deleteAgentAsk must report the deletion succeeded");
    assert.ok(!E.cascades.some(c => c.id === cB.id), "setup: B must actually be off the deck");

    const e = E.notify[id];
    assert.ok(!(e && arr(e.pinnedTo).includes(cB.id)),
      "AC2: notify[F].pinnedTo must no longer contain B's id once B is deleted");
    assert.deepEqual(arr(e && e.cascadeIds), [cA.id],
      "AC2: cascadeIds must fall back to A, the one agent still matching the film");
  } finally{
    unseedCascade(cA.id); unseedCascade(cB.id);
  }
}));

test("CAS-782 AC2b: deleting the ONLY agent a film is pinned to leaves it matching no agent", () => withNotifyState(() => {
  const cB = broadCascade("cas782-ac2b-b", 0);
  const film = pickMatchingFilm(cB);
  const id = film.tmdb_id;
  cB.year = [E.yearOf(film) - 1];                      // excluded by its own criteria — the pin is the only reason it's there
  E.cascades.push(cB);
  try{
    E.pinFilmToCascadeAndRepaint(id, cB.id);
    E.recomputeFound();
    assert.deepEqual(arr(E.notify[id].pinnedTo), [cB.id], "setup: the pin must land on B");

    const deleted = E.deleteAgentAsk(cB);
    assert.equal(deleted, true, "deleteAgentAsk must report the deletion succeeded");

    const e = E.notify[id];
    assert.ok(!(e && arr(e.pinnedTo).includes(cB.id)),
      "AC2: notify[F].pinnedTo must no longer contain B's id once B is deleted");
    assert.deepEqual(arr(e && e.cascadeIds), [],
      "AC2: cascadeIds must be empty — no agent matches the film once its only placement is released");
  } finally{
    unseedCascade(cB.id);
  }
}));

test("CAS-782 AC3: placing a film on agent C when it was previously placed on B replaces the placement", () => withNotifyState(() => {
  const cB = broadCascade("cas782-ac3-b", 0);
  const film = pickMatchingFilm(cB);
  const id = film.tmdb_id;
  const cC = broadCascade("cas782-ac3-c", 1);
  E.cascades.push(cB, cC);
  try{
    E.pinFilmToCascadeAndRepaint(id, cB.id);
    E.recomputeFound();
    assert.deepEqual(arr(E.notify[id].pinnedTo), [cB.id], "setup: the pin must land on B first");

    E.pinFilmToCascadeAndRepaint(id, cC.id);
    E.recomputeFound();
    assert.equal(E.notify[id].pinnedTo.length, 1, "AC3: pinnedTo must hold exactly one agent after re-pinning");
    assert.deepEqual(arr(E.notify[id].pinnedTo), [cC.id], "AC3: re-pinning to C must replace B, not add to it");
  } finally{
    unseedCascade(cB.id); unseedCascade(cC.id);
  }
}));
