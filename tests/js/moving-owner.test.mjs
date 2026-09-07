// CAS-829: Moving used to attribute each row to every agent whose ledger entry ever named it
// (`agentNames`, built from `a.cascade_name`) — a list, not the single-owner answer the app's core rule
// promises and the card right below the row already resolves through filmOwnerCascade(). This drives
// movingData() directly against seeded notify/cascades/realAlerts/firstFound state (the same shape
// tests/js/invariants.test.mjs's CAS-667/670/671 Moving checks already use) to assert the row-selection
// arithmetic now goes through filmOwnerCascade() exclusively, in both branches.
import test from "node:test";
import assert from "node:assert/strict";
import { loadEngine } from "./engine.mjs";

const E = loadEngine();

function withState(fn){
  const savedNotify = { ...E.notify };
  const savedCascades = [...E.cascades];
  const savedRealAlerts = [...E.realAlerts];
  const savedFirstFound = { ...E.firstFound };
  const savedWatched = new Set(E.watched);
  const savedHadAccount = E.localStorage.getItem("cascade_had_account");
  try{ fn(); }
  finally{
    Object.keys(E.notify).forEach(k => delete E.notify[k]);
    Object.assign(E.notify, savedNotify);
    E.cascades.length = 0; E.cascades.push(...savedCascades);
    E.realAlerts.length = 0; E.realAlerts.push(...savedRealAlerts);
    Object.keys(E.firstFound).forEach(k => delete E.firstFound[k]);
    Object.assign(E.firstFound, savedFirstFound);
    E.watched.clear(); savedWatched.forEach(id => E.watched.add(id));
    if(savedHadAccount === null) E.localStorage.removeItem("cascade_had_account");
    else E.localStorage.setItem("cascade_had_account", savedHadAccount);
    E.setMovingReady(true);
  }
}
function ownerCascade(id, order, name){
  const c = E.normCascade({ kind: "stream", status: [] });
  c.id = id; c.paused = false; c.order = order; c.name = name;
  return c;
}
function pickFilms(n){
  return E.MOVIES.filter(m => !E.watched.has(m.tmdb_id)).slice(0, n);
}

test("CAS-829 AC2(a): every row movingData() returns names exactly one agent, from the film's owner", () => withState(() => {
  E.localStorage.setItem("cascade_had_account", "1");
  const owner = ownerCascade("cas829-a-owner", 0, "Owner Agent");
  E.cascades.push(owner);
  const [film] = pickFilms(1);
  E.notify[film.tmdb_id] = { cascadeIds: [owner.id] };
  E.realAlerts.length = 0;
  E.realAlerts.push({ id: 1, movie_id: film.tmdb_id, moment: "announced_stream", title: film.title,
    cascade_name: "Some Other Name", emailed_at: new Date().toISOString(), read_at: null });
  E.setMovingReady(true);

  const { newRows } = E.movingData();
  const row = newRows.find(r => r.filmId === String(film.tmdb_id));
  assert.ok(row, "AC2(a): a row must exist for the owned film");
  assert.equal(row.agentId, owner.id, "AC2(a): the row must carry the owner's id");
  assert.equal(row.agentName, owner.name, "AC2(a): the row must carry the owner's name");
}));

test("CAS-829 AC2(b): a realAlerts entry for a film with empty cascadeIds produces no row", () => withState(() => {
  E.localStorage.setItem("cascade_had_account", "1");
  const [film] = pickFilms(1);
  E.notify[film.tmdb_id] = { cascadeIds: [] };
  E.realAlerts.length = 0;
  E.realAlerts.push({ id: 1, movie_id: film.tmdb_id, moment: "announced_stream", title: film.title,
    cascade_name: "Some Agent", emailed_at: new Date().toISOString(), read_at: null });
  E.setMovingReady(true);

  const { canRows, newRows, changedRows } = E.movingData();
  const allIds = [...canRows, ...newRows, ...changedRows].map(r => r.filmId);
  assert.ok(!allIds.includes(String(film.tmdb_id)), "AC2(b): an unowned film must produce no row at all");
}));

test("CAS-829 AC2(c): a ledger entry naming a non-owner agent still produces a row naming the OWNER", () => withState(() => {
  E.localStorage.setItem("cascade_had_account", "1");
  const owner = ownerCascade("cas829-c-owner", 0, "Owner Agent");
  const other = ownerCascade("cas829-c-other", 5, "Other Agent");
  E.cascades.push(owner, other);
  const [film] = pickFilms(1);
  E.notify[film.tmdb_id] = { cascadeIds: [owner.id] };   // owner.order (0) beats other.order (5)
  E.realAlerts.length = 0;
  E.realAlerts.push({ id: 1, movie_id: film.tmdb_id, moment: "announced_stream", title: film.title,
    cascade_name: other.name, emailed_at: new Date().toISOString(), read_at: null });
  E.setMovingReady(true);

  const { newRows } = E.movingData();
  const row = newRows.find(r => r.filmId === String(film.tmdb_id));
  assert.ok(row, "AC2(c): a row must exist");
  assert.equal(row.agentId, owner.id, "AC2(c): the row must name the owner, not the ledger's own agent name");
  assert.notEqual(row.agentName, other.name, "AC2(c): the row must not name the ledger's own agent");
}));

test("CAS-829 AC2(d): the guest branch emits at most one agent per row and drops unowned films", () => withState(() => {
  E.localStorage.removeItem("cascade_had_account");   // no cascade_had_account -> guest device
  const owner = ownerCascade("cas829-d-owner", 0, "Owner Agent");
  E.cascades.push(owner);
  const [ownedFilm, unownedFilm] = pickFilms(2);
  E.notify[ownedFilm.tmdb_id] = { cascadeIds: [owner.id] };
  E.notify[unownedFilm.tmdb_id] = { cascadeIds: [] };
  E.firstFound[String(ownedFilm.tmdb_id)] = new Date().toISOString();
  E.firstFound[String(unownedFilm.tmdb_id)] = new Date().toISOString();

  const { newRows } = E.movingData();
  const ownedRow = newRows.find(r => r.filmId === String(ownedFilm.tmdb_id));
  assert.ok(ownedRow, "AC2(d): the owned film must still get a row on a guest device");
  assert.equal(ownedRow.agentId, owner.id, "AC2(d): the guest row must name the owner");
  assert.ok(!newRows.some(r => r.filmId === String(unownedFilm.tmdb_id)),
    "AC2(d): the unowned film must be dropped, even on a guest device");
}));
