// CAS-789: scaffold for the agent-behaviour suite (run on request via `npm run test:agents`,
// never as part of `npm run qa` — see QA-AGENTS.md). Follow-up tickets fill this file with the
// actual behaviour checks; this placeholder only proves the export surface those checks need is
// really there.
import test from "node:test";
import assert from "node:assert/strict";
import { loadEngine } from "./engine.mjs";

const E = loadEngine();

const REQUIRED_EXPORTS = [
  "recomputeFound", "notify", "entryFor", "cascades", "cascSigOf", "agentFloor",
  "windowEnabled", "windowUsable", "WATCH_LEVEL_KEYS", "firstFound", "admitDrift",
  "filmIsNew", "isNewFound", "admittedAtFor", "watched", "blocked", "movingData",
  "movingWindowRows", "setWatchMarker", "restoreWatchMarker", "msnTrackAreaHTML",
  "msnValueLine", "toggleFilmOpt", "pinFilmToCascadeAndRepaint", "filmWatchSource",
  "filmNotifyState", "listingGroups", "listedBy", "watchesFilm", "agentChipHTML",
  "notifyChipHTML", "agentMetricsCompute", "cascadeScore", "primaryStatus",
  "CascadePersistence", "localStorage",
];

test("CAS-789: placeholder", () => {
  assert.ok(true);
});

test("CAS-789: every required export resolves from tests/js/engine.mjs", () => {
  const missing = REQUIRED_EXPORTS.filter(name => !(name in E) || E[name] === undefined);
  assert.deepEqual(missing, [], `missing engine export(s): ${missing.join(", ")}`);
});

// ============================================================================================
// CAS-791: the agent-behaviour plan's checks G to K. Same rules as the A-to-F ticket (CAS-790):
// every check drives the real exported functions against the real shipped engine, seeding state
// directly (notify, cascades, agent_films, firstFound, admitDrift, watched, blocked) rather than
// re-implementing engine logic. G1/G2/G3/H1-H3/H6/I2/I7/J8/J9/K4/K5/K7 each get exactly one test;
// H5/I1/I3/I6 are covered elsewhere and are comment-only, per the ticket.
// ============================================================================================

// Cinema/Rental/Streaming usable, Premium off — watchPrefsDefaults()'s own shape, made explicit
// so this file never depends on whatever an earlier test (in this file or another) left the
// global watchPrefs pointing at.
const WATCH_PREFS = {
  in_cinema: { list: true, notify: false }, premium: { list: false, notify: false },
  rent: { list: true, notify: false }, stream: { list: true, notify: false },
};
function withWatchPrefs(overrides, fn){
  const saved = E.watchPrefs;
  E.setWatchPrefs({ ...saved, ...overrides });
  try{ fn(); } finally{ E.setWatchPrefs(saved); }
}
// Saves/restores every piece of mutable engine state a check in this section might touch, so
// tests can freely seed cascades/notify/agent_films/firstFound/admitDrift/watched/blocked/the
// persistence-ready flags without leaking into whichever test runs next.
function withState(fn){
  const savedNotify = { ...E.notify };
  const savedCascades = [...E.cascades];
  const savedFirstFound = { ...E.firstFound };
  const savedAdmitDrift = { ...E.admitDrift };
  const savedWatched = new Set(E.watched), savedBlocked = new Set(E.blocked);
  const savedFWR = E.CascadePersistence.filmWatchReady, savedAFR = E.CascadePersistence.agentFilmsReady;
  try{ fn(); }
  finally{
    Object.keys(E.notify).forEach(k => delete E.notify[k]);
    Object.assign(E.notify, savedNotify);
    E.cascades.length = 0; E.cascades.push(...savedCascades);
    Object.keys(E.firstFound).forEach(k => delete E.firstFound[k]);
    Object.assign(E.firstFound, savedFirstFound);
    Object.keys(E.admitDrift).forEach(k => delete E.admitDrift[k]);
    Object.assign(E.admitDrift, savedAdmitDrift);
    E.watched.clear(); savedWatched.forEach(id => E.watched.add(id));
    E.blocked.clear(); savedBlocked.forEach(id => E.blocked.add(id));
    E.CascadePersistence.filmWatchReady = savedFWR;
    E.CascadePersistence.agentFilmsReady = savedAFR;
  }
}
// The one wrapper every check below actually uses — state isolation plus the standard watch
// window shape, so a test only has to describe what it's seeding, not how it cleans up.
function withAgentState(fn){
  withState(() => withWatchPrefs(WATCH_PREFS, fn));
}
// A broad agent — no criteria narrowed at all beyond an explicit watchMarkers floor, so whatever
// film this matches is a real match, not an assumption about the fixture catalogue's shape.
function broadCascade(id, order, markers){
  const c = E.normCascade({ kind: "stream", status: [],
    watchMarkers: markers || { in_cinema: 0, premium: null, rent: 0, stream: 0 } });
  c.id = id; c.paused = false; c.order = order;
  return c;
}
function pickMatchingFilm(c, exclude){
  const ex = exclude || new Set();
  const m = E.MOVIES.find(x => !E.watched.has(x.tmdb_id) && !E.blocked.has(x.tmdb_id) && !ex.has(x.tmdb_id)
    && E.matchesCriteria(x, c));
  if(!m) throw new Error("no film in the harness catalogue matches this agent — this test would prove nothing");
  return m;
}
// The engine runs in its own vm realm — an array it hands back is a real Array by content but not
// by [[Prototype]], so assert.deepEqual (what "strict" assert's .deepEqual actually is) fails on
// two arrays that print identically. Spreading pulls the values into a plain array of this realm.
const arr = a => [...(a || [])];
function daysBeforeToday(n){
  const d = new Date(Date.parse(E.TODAY));
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
}

// ---- G: a film's own freshness — firstFound, filmIsNew, movingData ---------------------------

test("G1: a film entering `found` for the first time is stamped with today, once — a second pass does not restamp it", () => withAgentState(() => {
  const c = broadCascade("cas791-g1", 0);
  E.cascades.push(c);
  const film = pickMatchingFilm(c);
  const id = film.tmdb_id;
  assert.ok(!E.found.has(id), "setup: the film must not already be in `found`");

  E.recomputeFound();

  assert.ok(E.found.has(id), "setup: the film must have entered `found`");
  assert.equal(E.firstFound[id], E.TODAY, "G1: firstFound must be stamped with today's date");

  E.recomputeFound();   // a second pass, same admission
  assert.equal(E.firstFound[id], E.TODAY, "G1: a second pass must not touch an already-stamped firstFound");
}));

test("G2: a world-driven admission (admitDrift unset) reads as new inside the window, not outside it", () => withAgentState(() => {
  // cascadeDrift(c) reads true whenever an agent holds zero prior rows — including a brand-new
  // agent's very first pass — so a "world-driven" (not agent-driven) admission needs the agent to
  // have already admitted something once before the film under test ever becomes reachable. film2
  // starts spliced OUT of MOVIES (the world hasn't produced it yet); the agent's first pass admits
  // only film1, giving it a non-empty, sig-agreeing row. Splicing film2 back in and recomputing is
  // then a genuine "the world moved" arrival: the agent itself was never touched.
  const c = broadCascade("cas791-g2", 0);
  E.cascades.push(c);
  const film1 = pickMatchingFilm(c);
  const film2 = pickMatchingFilm(c, new Set([film1.tmdb_id]));
  const id = film2.tmdb_id;
  const idx2 = E.MOVIES.findIndex(x => x.tmdb_id === id);
  const removed2 = E.MOVIES.splice(idx2, 1)[0];
  try{
    E.recomputeFound();
    assert.ok(E.CascadePersistence.agentFilmsFor(c.id).length > 0, "setup: the agent must hold a row before film2 'arrives'");

    E.MOVIES.splice(idx2, 0, removed2);   // the world adds film2 to the catalogue — the agent is untouched
    E.recomputeFound();

    assert.ok(E.found.has(id), "setup: film2 must now be admitted");
    assert.ok(!E.admitDrift[id], "G2: a world-driven admission (agent unedited, non-empty prior rows) must not set admitDrift");
    assert.equal(E.filmIsNew(id), true, "G2: inside the new-film window, a drift-free admission reads as new");

    const row = E.CascadePersistence.getAgentFilm(c.id, id);
    const past = new Date(Date.parse(E.TODAY));
    past.setDate(past.getDate() - (E.NEW_DAYS + 2));
    E.CascadePersistence.setAgentFilm(c.id, id, { ...row, admitted_at: past.toISOString() });
    E.recomputeFound();   // agent_sig unchanged -> the sticky-admission branch leaves this row untouched

    assert.equal(E.filmIsNew(id), false, "G2: outside the new-film window, the same drift-free admission reads as not new");
  } finally {
    if(!E.MOVIES.includes(removed2)) E.MOVIES.splice(idx2, 0, removed2);
  }
}));

test("G3: movingData() carries a freshly-found film in the New to your agents group, in the correct time bucket", () => withAgentState(() => {
  const c = broadCascade("cas791-g3", 0);
  E.cascades.push(c);
  const film = pickMatchingFilm(c);
  const id = film.tmdb_id;
  E.recomputeFound();
  assert.ok(E.found.has(id), "setup: the film must be found before this test can assert its moving row");

  const row = E.movingData().newRows.find(r => r.filmId === String(id));
  assert.ok(row, "G3: a movingData() row must exist for a film freshly entering `found`");
  assert.equal(row.groupKey, "new_agents", "G3: it must land in the New to your agents group");
  assert.ok(E.movingInWindow(row.date, "today"), "G3: freshly found today, it must fall in the Today bucket");

  E.firstFound[id] = daysBeforeToday(3);   // still New (< NEW_DAYS), but no longer literally today
  const row2 = E.movingData().newRows.find(r => r.filmId === String(id));
  assert.ok(row2, "setup: the row must still exist after backdating");
  assert.ok(!E.movingInWindow(row2.date, "today"), "G3: 3 days back, it must no longer read as Today");
  assert.ok(E.movingInWindow(row2.date, "week"), "G3: ...but must still read as within the Week bucket");
}));

// ---- H: reordering / hand-moving an already-found film must not read as freshness news -------

test("H1: reordering agents so a film's owner changes leaves firstFound unstamped again — no restamp", () => withAgentState(() => {
  const cA = broadCascade("cas791-h1-a", 0);
  const cB = broadCascade("cas791-h1-b", 5);
  E.cascades.push(cA, cB);
  const film = pickMatchingFilm(cA);
  const id = film.tmdb_id;
  assert.ok(E.matchesCriteria(film, cB), "setup: both agents must genuinely match the film");
  E.recomputeFound();
  assert.deepEqual(arr(E.notify[id].cascadeIds), [cA.id], "setup: A starts as sole owner");
  const stampBefore = E.firstFound[id];
  assert.ok(stampBefore, "setup: the film must be stamped on first admission");

  cA.order = 9; cB.order = 0;
  E.recomputeFound();

  assert.deepEqual(arr(E.notify[id].cascadeIds), [cB.id], "setup: ownership must actually move to B");
  assert.equal(E.firstFound[id], stampBefore, "H1: firstFound must not be restamped just because ownership moved");
}));

test("H2: filmIsNew() is unchanged by the same reordering move", () => withAgentState(() => {
  const cA = broadCascade("cas791-h2-a", 0);
  const cB = broadCascade("cas791-h2-b", 5);
  E.cascades.push(cA, cB);
  const film = pickMatchingFilm(cA);
  const id = film.tmdb_id;
  assert.ok(E.matchesCriteria(film, cB), "setup: both agents must genuinely match the film");
  E.recomputeFound();
  assert.deepEqual(arr(E.notify[id].cascadeIds), [cA.id], "setup: A starts as sole owner");
  const isNewBefore = E.filmIsNew(id);

  cA.order = 9; cB.order = 0;
  E.recomputeFound();

  assert.deepEqual(arr(E.notify[id].cascadeIds), [cB.id], "setup: ownership must actually move to B");
  assert.equal(E.filmIsNew(id), isNewBefore, "H2: filmIsNew must not change just because ownership moved");
}));

test("H3: movingData() carries no new row across the same reordering move", () => withAgentState(() => {
  const cA = broadCascade("cas791-h3-a", 0);
  const cB = broadCascade("cas791-h3-b", 5);
  E.cascades.push(cA, cB);
  const film = pickMatchingFilm(cA);
  const id = film.tmdb_id;
  assert.ok(E.matchesCriteria(film, cB), "setup: both agents must genuinely match the film");
  E.recomputeFound();
  assert.deepEqual(arr(E.notify[id].cascadeIds), [cA.id], "setup: A starts as sole owner");
  const before = E.movingData().newRows.map(r => r.filmId).sort();

  cA.order = 9; cB.order = 0;
  E.recomputeFound();

  assert.deepEqual(arr(E.notify[id].cascadeIds), [cB.id], "setup: ownership must actually move to B");
  const after = E.movingData().newRows.map(r => r.filmId).sort();
  assert.deepEqual(after, before, "H3: reordering ownership must not add or remove a moving row");
}));

// H5 — covered by tests/js/agents-firstfound.test.mjs. Comment only, no test here.

test("H6: hand-moving a film from one agent to another leaves firstFound unstamped and adds no moving row", () => withAgentState(() => {
  const cA = broadCascade("cas791-h6-a", 0);
  const cB = broadCascade("cas791-h6-b", 1);
  E.cascades.push(cA, cB);
  const film = pickMatchingFilm(cA);
  const id = film.tmdb_id;
  assert.ok(E.matchesCriteria(film, cB), "setup: both agents must genuinely match the film");
  E.recomputeFound();
  assert.deepEqual(arr(E.notify[id].cascadeIds), [cA.id], "setup: A starts as sole owner");
  const stampBefore = E.firstFound[id];
  const rowsBefore = E.movingData().newRows.map(r => r.filmId).sort();

  E.pinFilmToCascadeAndRepaint(id, cB.id);
  E.recomputeFound();

  assert.deepEqual(arr(E.notify[id].cascadeIds), [cB.id], "setup: the hand-move must actually land on B");
  assert.equal(E.firstFound[id], stampBefore, "H6: firstFound must not be restamped by a hand-move");
  const rowsAfter = E.movingData().newRows.map(r => r.filmId).sort();
  assert.deepEqual(rowsAfter, rowsBefore, "H6: a hand-move must add no moving row");
}));

// ---- I: leaving the list (watched / blocked) --------------------------------------------------

// I1, I3, I6 — covered by tests/js/agents-watched.test.mjs. Comment only, no test here.

test("I2: a watched film without a placement is pruned entirely; with a placement, the entry survives", () => withAgentState(() => {
  const c = broadCascade("cas791-i2", 0);
  E.cascades.push(c);
  const film = pickMatchingFilm(c);
  const id = film.tmdb_id;
  E.recomputeFound();
  assert.ok(E.found.has(id), "setup: the film must be found before it's watched");

  E.setOpinion(id, "liked");   // marks watched — its own repaint already recomputes

  assert.ok(!E.found.has(id), "I2: a watched film must leave found");
  assert.ok(!(id in E.notify), "I2: with no placement, the entry must be pruned entirely");

  E.setOpinion(id, "liked");   // un-marks
  E.recomputeFound();
  E.pinFilmToCascadeAndRepaint(id, c.id);
  E.recomputeFound();
  assert.ok(E.found.has(id), "setup: the film must be re-found, now placed, before watching it again");

  E.setOpinion(id, "liked");   // marks watched again, this time placed

  assert.ok(!E.found.has(id), "I2: a watched, placed film must still leave found");
  assert.ok(id in E.notify, "I2: a placement must keep the entry from being pruned");
  assert.deepEqual(arr(E.notify[id].pinnedTo), [c.id], "I2: the placement itself must survive");
}));

test("I7: marking a film \"not for me\" excludes it from found and it is not re-admitted on a later pass", () => withAgentState(() => {
  const c = broadCascade("cas791-i7", 0);
  E.cascades.push(c);
  const film = pickMatchingFilm(c);
  const id = film.tmdb_id;
  E.recomputeFound();
  assert.ok(E.found.has(id), "setup: the film must be found before being blocked");

  E.setOpinion(id, "notfor");

  assert.ok(!E.found.has(id), "I7: a blocked film must leave found");
  assert.ok(E.blocked.has(id), "setup: the film must actually be recorded as blocked");

  E.recomputeFound();   // a later, unrelated pass
  assert.ok(!E.found.has(id), "I7: a blocked film must not be re-admitted on a later pass");
  assert.ok(!(id in E.notify) || !E.notify[id].cascadeIds.includes(c.id),
    "I7: the agent must not re-claim the blocked film");
}));

// ---- J: Watch On placement as the world moves on ------------------------------------------------

test("J8: a film moving to a later window advances Watch On to standing and shows up in movingData()", () => withAgentState(() => {
  const film = E.MOVIES.find(x => !E.watched.has(x.tmdb_id) && !E.blocked.has(x.tmdb_id));
  const id = film.tmdb_id;
  const savedStatus = film.status;
  const c = broadCascade("cas791-j8", 0);
  E.cascades.push(c);
  try{
    film.status = ["in_cinema"];
    E.CascadePersistence.setAgentFilm(c.id, id,
      { admission_score: 60, admission_status: "in_cinema", agent_sig: E.cascSigOf(c) });
    E.recomputeFound();
    assert.equal(E.notify[id].wins.in_cinema, true, "setup: the film must earn Cinema, the first usable rung");
    assert.ok(E.found.has(id), "setup: the film must be found before this test's move");

    film.status = ["included_streaming"];   // the world moves the film all the way to Stream
    E.recomputeFound();

    assert.equal(E.notify[id].wins.stream, true, "J8: Watch On must advance to standing (Stream) once the film reaches it");
    assert.equal(E.notify[id].wins.in_cinema, false, "J8: ...and no longer sit at the earlier earned rung");
    const st = E.filmNotifyState(id);
    assert.equal(st.current, true, "J8: the card's notify state must read its \"can watch\" form");
    const row = E.movingData().newRows.find(r => r.filmId === String(id));
    assert.ok(row, "J8: a movingData() row must exist for the film");
  } finally {
    film.status = savedStatus;
  }
}));

test("J9: the same move leaves a manual Watch On untouched, and a movingData() row still appears", () => withAgentState(() => {
  const film = E.MOVIES.find(x => !E.watched.has(x.tmdb_id) && !E.blocked.has(x.tmdb_id));
  const id = film.tmdb_id;
  const savedStatus = film.status;
  const c = broadCascade("cas791-j9", 0);
  E.cascades.push(c);
  try{
    film.status = ["in_cinema"];
    E.CascadePersistence.setAgentFilm(c.id, id,
      { admission_score: 60, admission_status: "in_cinema", agent_sig: E.cascSigOf(c) });
    E.recomputeFound();
    E.toggleFilmOpt(id, "in_cinema");
    assert.equal(E.notify[id].winsSource.in_cinema, "manual", "setup: the tick must land as manual");

    film.status = ["included_streaming"];   // the world moves the film all the way to Stream
    E.recomputeFound();

    assert.equal(E.notify[id].wins.in_cinema, true, "J9: a manual Watch On must be untouched by the film's own move");
    assert.equal(E.notify[id].winsSource.in_cinema, "manual", "J9: ...and still read manual");
    const row = E.movingData().newRows.find(r => r.filmId === String(id));
    assert.ok(row, "J9: a movingData() row must still appear");
  } finally {
    film.status = savedStatus;
  }
}));

// ---- K: engine-level invariants and ledger edge cases ------------------------------------------

test("K4: a film disappearing from MOVIES between passes clears its agent_films row and leaves no orphan membership", () => withAgentState(() => {
  const c = broadCascade("cas791-k4", 0);
  E.cascades.push(c);
  const film = pickMatchingFilm(c);
  const id = film.tmdb_id;
  const other = pickMatchingFilm(c, new Set([id]));
  const otherId = other.tmdb_id;
  E.recomputeFound();
  assert.ok(E.CascadePersistence.agentFilmsFor(c.id).some(r => r.movie_id === String(id)), "setup: the row must exist before removal");
  assert.ok(E.notify[id].cascadeIds.includes(c.id), "setup: the film must be a member before removal");
  const sigBefore = E.cascSigOf(c);
  const otherRowBefore = E.CascadePersistence.getAgentFilm(c.id, otherId);
  assert.ok(otherRowBefore, "setup: a second, untouched row must exist on this agent");

  const idx = E.MOVIES.findIndex(x => x.tmdb_id === id);
  const removed = E.MOVIES.splice(idx, 1)[0];
  try{
    E.recomputeFound();

    assert.equal(E.cascSigOf(c), sigBefore,
      "setup: the agent must remain unedited (same agent_sig) across this pass — the case that failed before CAS-795");
    assert.ok(!E.CascadePersistence.agentFilmsFor(c.id).some(r => r.movie_id === String(id)),
      "K4: the agent_films row must be cleared once the film is gone from MOVIES, even on an unedited agent");
    assert.ok(!(id in E.notify), "K4: no orphan membership may remain in notify");

    const otherRowAfter = E.CascadePersistence.getAgentFilm(c.id, otherId);
    assert.ok(otherRowAfter, "K4: an unrelated row on the same unedited agent must survive");
    assert.equal(otherRowAfter.admitted_at, otherRowBefore.admitted_at, "K4: an untouched row keeps its admitted_at");
    assert.equal(otherRowAfter.admission_score, otherRowBefore.admission_score, "K4: an untouched row keeps its admission_score");
    assert.equal(otherRowAfter.admission_status, otherRowBefore.admission_status, "K4: an untouched row keeps its admission_status");
    assert.equal(otherRowAfter.agent_sig, otherRowBefore.agent_sig, "K4: an untouched row keeps its agent_sig");
  } finally {
    E.MOVIES.splice(idx, 0, removed);
  }
}));

test("K5: every listing group's item count equals the rows that belong to it, and narrowing an agent's criteria never increases its total", () => withAgentState(() => {
  const c = E.normCascade({ kind: "stream", status: [] });
  c.id = "cas791-k5"; c.paused = false; c.order = 0;
  const rows = E.MOVIES.filter(m => E.listedBy(m, c));
  const groups = E.listingGroups(rows, c);
  const total = groups.reduce((n, x) => n + x.items.length, 0);
  assert.equal(total, rows.length, "K5: every listed row must land in exactly one group — none dropped, none duplicated");
  for(const { g, items } of groups){
    assert.equal(items.length, rows.filter(m => E.primaryStatus(m) === g).length,
      `K5: group ${g}'s count must equal the length of the set it labels`);
  }

  const before = E.agentMetricsCompute(c).total;
  c.year = [1900];   // narrow: a year almost certainly absent from the catalogue
  const after = E.agentMetricsCompute(c).total;
  assert.ok(after <= before, "K5: narrowing an agent's criteria must never increase its listed count");
}));

test("K7: a refresh that changes a film's score but not its window leaves admission held — admission_score is not re-thresholded", () => withAgentState(() => {
  const film = E.MOVIES.find(x => !E.watched.has(x.tmdb_id) && !E.blocked.has(x.tmdb_id)
    && E.imdbReliable(x) && ["pvod", "rental", "included_streaming"].includes(E.primaryStatus(x)));
  if(!film) throw new Error("no unwatched, IMDb-reliable released film in the harness catalogue — this test would prove nothing");
  const id = film.tmdb_id;
  const c = broadCascade("cas791-k7", 0);
  E.cascades.push(c);
  const sig = E.cascSigOf(c);
  const originalScore = E.cascadeScore(film);
  E.CascadePersistence.setAgentFilm(c.id, id,
    { admission_score: originalScore, admission_status: E.primaryStatus(film), agent_sig: sig });
  E.recomputeFound();
  assert.ok(E.notify[id].cascadeIds.includes(c.id), "setup: the film must be admitted before the refresh");

  const savedImdb = film.imdb_rating;
  try{
    film.imdb_rating = (film.imdb_rating == null || film.imdb_rating < 5) ? 9.9 : 0.1;   // force a real score move
    E.invalidateComputeCaches();
    assert.notEqual(E.cascadeScore(film), originalScore, "setup: this edit must actually move cascadeScore(film)");

    E.recomputeFound();   // the "refresh" — the agent itself is untouched, so nothing may re-threshold

    const row = E.CascadePersistence.agentFilmsFor(c.id).find(r => r.movie_id === String(id));
    assert.ok(row, "K7: the admission must hold across the refresh");
    assert.equal(row.admission_score, originalScore, "K7: admission_score must not be re-thresholded off the film's new score");
  } finally {
    film.imdb_rating = savedImdb;
    E.invalidateComputeCaches();
  }
}));
