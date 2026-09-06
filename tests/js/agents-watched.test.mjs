// CAS-788: marking a film Watched or "not for me" spends the intent behind any Watch On — the per-film
// alert path (film_watch, driven by notify[id].wins/winsSource) must go quiet with it, the same day, not
// keep alerting off a tick that predates the verdict. Un-marking must not resurrect the OLD value: the
// film goes back to ordinary agent control, and the next recomputeFound re-arms a fresh Watch On itself,
// with winsSource "auto", if an agent still matches the film.
import test from "node:test";
import assert from "node:assert/strict";
import { loadEngine } from "./engine.mjs";

const E = loadEngine();

function withNotifyState(fn){
  const savedNotify = { ...E.notify };
  const savedWatched = new Set(E.watched), savedBlocked = new Set(E.blocked);
  try{ fn(); }
  finally{
    Object.keys(E.notify).forEach(k => delete E.notify[k]);
    Object.assign(E.notify, savedNotify);
    E.watched.clear(); savedWatched.forEach(id => E.watched.add(id));
    E.blocked.clear(); savedBlocked.forEach(id => E.blocked.add(id));
  }
}
function unseedCascade(id){
  const i = E.cascades.findIndex(c => c.id === id);
  if(i >= 0) E.cascades.splice(i, 1);
}
// A broad, unpinned agent — no criteria narrowed, watchMarkers floored to 0 so any real score clears
// the bar — so a real film is admitted, and its Watch On armed, through the ordinary criteria-match
// path (never a pin, which bypasses the very watched-exclusion this ticket is about — see
// matchesCriteria's `c.excludeWatched` gate).
function broadCascade(id, order){
  const c = E.normCascade({ kind: "stream", status: [],
    watchMarkers: { in_cinema: 0, premium: 0, rent: 0, stream: 0 } });
  c.id = id; c.paused = false; c.order = order;
  return c;
}
function pickMatchingFilm(c){
  const m = E.MOVIES.find(x => !E.watched.has(x.tmdb_id) && !E.blocked.has(x.tmdb_id) && E.matchesCriteria(x, c));
  if(!m) throw new Error("no film in the harness catalogue matches a broad agent — this test would prove nothing");
  return m;
}
// Cinema/Rental/Streaming on, Premium off — watchPrefsDefaults()'s own shape, made explicit so this file
// doesn't depend on whatever an earlier test left the global watchPrefs pointing at.
const WATCH_PREFS = {
  in_cinema: { list: true, notify: false }, premium: { list: false, notify: false },
  rent: { list: true, notify: false }, stream: { list: true, notify: false },
};
function withWatchPrefs(overrides, fn){
  const saved = E.watchPrefs;
  E.setWatchPrefs({ ...saved, ...overrides });
  try{ fn(); } finally{ E.setWatchPrefs(saved); }
}
function armedKey(id){
  const e = E.notify[id];
  return E.WATCH_LEVEL_KEYS.find(k => e && e.wins && e.wins[k]);
}
function watchRowFor(id){
  return E.CascadePersistence.watchRows().find(r => r.movie_id === String(id));
}
// A cleared film may keep a bare notify entry (still "found" under some other route) or may be pruned
// out entirely by recomputeFound's own noise-gc (nothing left worth remembering, per its own comment at
// the foot of the function) — both are valid ways of saying "no Watch On", so assertions go through this
// rather than assuming notify[id] still exists.
function noWinsLeft(id){
  const e = E.notify[id];
  if(!e) return true;
  return E.WATCH_LEVEL_KEYS.every(k => !e.wins[k]) && Object.keys(e.winsSource || {}).length === 0;
}

test("CAS-788: marking a film watched clears its Watch On and drops its film_watch row", () => withNotifyState(() => withWatchPrefs(WATCH_PREFS, () => {
  const c = broadCascade("cas788-watched", 0);
  E.cascades.push(c);
  try{
    const film = pickMatchingFilm(c);
    const id = film.tmdb_id;
    E.recomputeFound();
    const key = armedKey(id);
    assert.ok(key, "setup: the agent must actually arm a Watch On before this test can assert it gets cleared");
    assert.equal(E.notify[id].winsSource[key], "auto", "setup: the arm must be auto, an agent's own doing");
    assert.ok(watchRowFor(id), "setup: an armed Watch On must produce a film_watch row");

    E.setOpinion(id, "liked");   // marks the film watched

    assert.ok(noWinsLeft(id),
      "every WATCH_LEVEL_KEYS rung, and its winsSource provenance, must be clear once the film is marked watched");
    assert.ok(!watchRowFor(id), "a watched film must have no film_watch row through watchRows()");
  } finally{
    unseedCascade(c.id);
  }
})));

test("CAS-788: marking a film \"not for me\" clears its Watch On and drops its film_watch row", () => withNotifyState(() => withWatchPrefs(WATCH_PREFS, () => {
  const c = broadCascade("cas788-blocked", 0);
  E.cascades.push(c);
  try{
    const film = pickMatchingFilm(c);
    const id = film.tmdb_id;
    E.recomputeFound();
    assert.ok(armedKey(id), "setup: the agent must actually arm a Watch On before this test can assert it gets cleared");

    E.setOpinion(id, "notfor");   // blocked, not watched — same rule applies (CAS-788 Context)

    assert.ok(noWinsLeft(id),
      "every WATCH_LEVEL_KEYS rung must be clear once the film is marked not for me");
    assert.ok(!watchRowFor(id), "a blocked film must have no film_watch row through watchRows()");
  } finally{
    unseedCascade(c.id);
  }
})));

test("CAS-788: un-marking watched leaves the Watch On clear, then the next recomputeFound re-arms it with winsSource \"auto\"", () => withNotifyState(() => withWatchPrefs(WATCH_PREFS, () => {
  const c = broadCascade("cas788-unmark", 0);
  E.cascades.push(c);
  try{
    const film = pickMatchingFilm(c);
    const id = film.tmdb_id;
    E.recomputeFound();
    const originalKey = armedKey(id);
    assert.ok(originalKey, "setup: the agent must arm a Watch On before this test can assert its lifecycle");

    E.setOpinion(id, "liked");                 // mark watched — clears it (asserted by the tests above)
    assert.ok(noWinsLeft(id), "setup: marking watched must have cleared every rung");

    E.setOpinion(id, "liked");                 // same kind again -> un-marks (setOpinion's own on/off toggle)
    assert.ok(!E.watched.has(id), "setup: the second call must have un-marked the film");

    const rearmedKey = armedKey(id);
    assert.ok(rearmedKey, "the next recomputeFound must re-arm a Watch On now the agent matches the film again");
    assert.equal(E.notify[id].winsSource[rearmedKey], "auto",
      "a value re-armed by recomputeFound itself must carry winsSource \"auto\", never a resurrected manual one");
  } finally{
    unseedCascade(c.id);
  }
})));
