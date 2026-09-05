// CAS-781: a Watch On set by hand is a human selection (Lee's decision, 2026-09-04) and now outranks an
// agent's own criteria the same way a pinnedTo film does — it must hold the film's MEMBERSHIP of the agent
// that admitted it, not merely the wins/winsSource value on the entry. recomputeFound's drift branch (the
// "would this still be admitted under my new settings" re-test CAS-728 added) used to clear the agent_films
// row unconditionally once criteria stopped matching; only pinnedTo/notIn and watched/removed outranked it.
// These tests seed an agent_films row directly via CascadePersistence.setAgentFilm — the same seam CAS-726/
// 728's own tests use — then drift the agent's own cascSigOf by raising its watchMarkers past the stored
// admission_score, and check whether recomputeFound() keeps or drops the row.
import test from "node:test";
import assert from "node:assert/strict";
import { loadEngine } from "./engine.mjs";

const E = loadEngine();

const STICKY_WATCH_PREFS = {
  in_cinema: { list: true, notify: false }, premium: { list: false, notify: false },
  rent: { list: true, notify: false }, stream: { list: true, notify: false },
};
function withWatchPrefs(overrides, fn){
  const saved = E.watchPrefs;
  E.setWatchPrefs({ ...saved, ...overrides });
  try{ fn(); } finally{ E.setWatchPrefs(saved); }
}
function withNotifyState(fn){
  const savedNotify = { ...E.notify };
  try { fn(); }
  finally {
    Object.keys(E.notify).forEach(k => delete E.notify[k]);
    Object.assign(E.notify, savedNotify);
  }
}
function unseedCascade(id){
  const i = E.cascades.findIndex(c => c.id === id);
  if(i >= 0) E.cascades.splice(i, 1);
}
// A near-impossible floor (99) keeps a freshly-seeded agent from also admitting half the catalogue as
// "arrivals" the moment recomputeFound runs — the one row under test is written directly, below, regardless.
function overrideTestCascade(id, floor){
  const c = E.normCascade({ kind: "stream", status: [] });
  c.id = id; c.paused = false; c.order = 0;
  c.watchMarkers = { in_cinema: floor, premium: null, rent: floor, stream: floor };
  return c;
}
function pastCinemaUnwatchedFilm(excludeId){
  const m = E.MOVIES.find(x => !E.watched.has(x.tmdb_id) && x.tmdb_id !== excludeId
    && E.primaryStatus(x) === "rental");
  if(!m) throw new Error("no unwatched 'rental' film in the harness catalogue — this test would prove nothing");
  return m;
}

test("CAS-781 AC1: a manual Watch On keeps the film ON the agent through a re-evaluation that would otherwise drop it", () => withNotifyState(() => withWatchPrefs(STICKY_WATCH_PREFS, () => {
  const film = pastCinemaUnwatchedFilm();
  const id = film.tmdb_id;
  const c = overrideTestCascade("cas781-ac1", 99);
  E.cascades.push(c);
  const sigBefore = E.cascSigOf(c);
  try {
    E.CascadePersistence.setAgentFilm(c.id, id,
      { admission_score: 90, admission_status: "in_cinema", agent_sig: sigBefore });
    E.recomputeFound();
    assert.ok(E.notify[id].cascadeIds.includes(c.id), "setup: the film must actually be on the agent before the edit");

    const level = E.watchLevelsFor(id).find(l => !l.spent);
    assert.ok(level, "no un-spent Watch level on this film — the harness catalogue looks wrong");
    E.toggleFilmOpt(id, level.key);   // the real hand-tick, via the real wire function
    assert.equal(E.notify[id].winsSource[level.key], "manual", "setup: the tick must land as a manual value");

    c.watchMarkers = { in_cinema: 95, premium: null, rent: 95, stream: 95 };   // 95 > the stored score of 90
    assert.notEqual(E.cascSigOf(c), sigBefore, "this test's own edit must actually move cascSigOf(c)");
    E.recomputeFound();

    assert.ok(E.notify[id].cascadeIds.includes(c.id),
      "CAS-781: a manual Watch On is a human selection and must hold the film's membership of the agent too, not just its value");
    const row = E.CascadePersistence.agentFilmsFor(c.id).find(r => r.movie_id === String(id));
    assert.ok(row, "the agent_films row must survive the edit, not be cleared");
    assert.equal(row.admission_score, 90, "the retained row must keep its ORIGINAL admission_score, not a re-test");
    assert.equal(E.notify[id].wins[level.key], true, "the manual Watch On value itself must also still be set");
  } finally { unseedCascade(c.id); }
})));

test("CAS-781 AC2: an auto-armed Watch On (winsSource \"auto\") does not save the film — it still leaves the agent, as before", () => withNotifyState(() => withWatchPrefs(STICKY_WATCH_PREFS, () => {
  const film = pastCinemaUnwatchedFilm();
  const id = film.tmdb_id;
  const c = overrideTestCascade("cas781-ac2", 99);
  E.cascades.push(c);
  const sigBefore = E.cascSigOf(c);
  try {
    E.CascadePersistence.setAgentFilm(c.id, id,
      { admission_score: 90, admission_status: "in_cinema", agent_sig: sigBefore });
    E.recomputeFound();
    assert.ok(E.notify[id].cascadeIds.includes(c.id), "setup: the film must actually be on the agent before the edit");

    const level = E.watchLevelsFor(id).find(l => !l.spent);
    assert.ok(level, "no un-spent Watch level on this film — the harness catalogue looks wrong");
    // Simulate the ordinary agent-armed placement (recomputeFound's own auto-arm, not a hand-tick) — same
    // provenance shape CAS-728 AC3's drop case leaves behind, just given a value to test against here.
    const e = E.notify[id];
    e.wins = { ...e.wins, [level.key]: true };
    e.winsSource = { ...e.winsSource, [level.key]: "auto" };

    c.watchMarkers = { in_cinema: 95, premium: null, rent: 95, stream: 95 };   // 95 > the stored score of 90
    assert.notEqual(E.cascSigOf(c), sigBefore, "this test's own edit must actually move cascSigOf(c)");
    E.recomputeFound();

    // An auto-armed entry with nothing else keeping it alive (no override, no other pick) is pruned outright
    // once the film leaves — a stronger outcome than merely losing cascadeIds, but the same "it's gone" answer.
    assert.ok(!E.notify[id] || !E.notify[id].cascadeIds.includes(c.id),
      "AC2: an auto-armed value must not hold the film — only a MANUAL one does (CAS-781)");
    const row = E.CascadePersistence.agentFilmsFor(c.id).find(r => r.movie_id === String(id));
    assert.ok(!row, "the agent_films row must still be cleared for an auto-armed value, exactly as before this ticket");
  } finally { unseedCascade(c.id); }
})));

test("CAS-781 AC3: a manual Watch On does not retain a film marked watched", () => withNotifyState(() => withWatchPrefs(STICKY_WATCH_PREFS, () => {
  const film = pastCinemaUnwatchedFilm();
  const id = film.tmdb_id;
  const c = overrideTestCascade("cas781-ac3", 99);
  E.cascades.push(c);
  const sigBefore = E.cascSigOf(c);
  const wasWatched = E.watched.has(id);
  try {
    E.CascadePersistence.setAgentFilm(c.id, id,
      { admission_score: 90, admission_status: "in_cinema", agent_sig: sigBefore });
    E.recomputeFound();
    const level = E.watchLevelsFor(id).find(l => !l.spent);
    assert.ok(level, "no un-spent Watch level on this film — the harness catalogue looks wrong");
    E.toggleFilmOpt(id, level.key);
    assert.equal(E.notify[id].winsSource[level.key], "manual", "setup: the tick must land as a manual value");

    E.watched.add(id);
    E.recomputeFound();

    const row = E.CascadePersistence.agentFilmsFor(c.id).find(r => r.movie_id === String(id));
    assert.ok(!row, "CAS-781: watched still outranks a manual Watch On — the agent_films row must be cleared");
  } finally { unseedCascade(c.id); if(!wasWatched) E.watched.delete(id); }
})));
