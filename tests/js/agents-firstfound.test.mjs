// CAS-783: a film is new to you once, ever. trackFirstFound() used to delete a film's firstFound stamp the
// moment it left `found`, so a film that later re-qualified was stamped afresh and glowed as new a second
// time. This asserts the stamp now survives a departure/return cycle, and that growth is still bounded by a
// date-based prune instead.
//
// A plain manual entry (source:"manual") is used throughout rather than a real cascade match — mine=true is
// enough on its own to land an id in `found` (recomputeFound's own auto||mine test), and since the id then
// never touches the cascades/agent_films admission ledger, admittedAtFor(id) stays null and isNewFound()
// falls straight through to the device-local firstFound path this ticket changes, with no ledger-freshness
// confound to control for.
import test from "node:test";
import assert from "node:assert/strict";
import { loadEngine } from "./engine.mjs";

const E = loadEngine();

function withState(fn){
  const savedNotify = { ...E.notify };
  const savedFirstFound = { ...E.firstFound };
  try{ fn(); }
  finally{
    Object.keys(E.notify).forEach(k => delete E.notify[k]);
    Object.assign(E.notify, savedNotify);
    Object.keys(E.firstFound).forEach(k => delete E.firstFound[k]);
    Object.assign(E.firstFound, savedFirstFound);
  }
}
function daysBeforeToday(n){
  const d = new Date(Date.parse(E.TODAY));
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
}

test("CAS-783 AC1: firstFound is stamped once, ever — it survives leaving found and is not restamped on return", () => withState(() => {
  const id = 987650001;
  const e = E.entryFor(id);
  e.source = "manual";
  E.recomputeFound();
  assert.ok(E.firstFound[id], "setup: entering found must stamp firstFound");

  // Backdate the stamp (well inside the prune horizon, well outside the New window) so a restamp-to-today
  // is detectable even when the whole test runs within one calendar day.
  const original = daysBeforeToday(20);
  E.firstFound[id] = original;

  // Leave every route onto the list: no longer manual, no cascade match, nothing else keeping the entry.
  e.source = "auto";
  E.recomputeFound();
  assert.ok(!(id in E.notify), "setup: the entry must actually be gone once it's neither auto-matched nor manual");
  assert.equal(E.firstFound[id], original, "AC1: firstFound must survive the film leaving the list");

  // Re-admitted later.
  const e2 = E.entryFor(id);
  e2.source = "manual";
  E.recomputeFound();
  assert.equal(E.firstFound[id], original, "AC1: re-admission must not restamp firstFound");
  assert.equal(E.filmIsNew(id), false, "AC1: a film re-admitted after its original window must not read as new again");
}));

test("CAS-783 AC2: a firstFound stamp older than the prune horizon is dropped; one still inside it survives", () => withState(() => {
  const staleId = 987650002;
  const freshId = 987650003;
  E.firstFound[staleId] = daysBeforeToday(E.FIRST_FOUND_PRUNE_DAYS + 1);
  E.firstFound[freshId] = daysBeforeToday(E.FIRST_FOUND_PRUNE_DAYS - 1);

  E.recomputeFound();

  assert.ok(!(staleId in E.firstFound), "AC2: a stamp older than the prune horizon must be dropped");
  assert.ok(freshId in E.firstFound, "a stamp still inside the prune horizon must not be dropped");
}));
