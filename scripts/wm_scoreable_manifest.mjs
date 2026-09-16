#!/usr/bin/env node
// CAS-922: builds state/wm_backfill_scoreable.txt — every film that would produce a Cascade score
// TODAY (via qScore/cinemaScore) and has not yet had its Watchmode fields fetched. Feeds
// scripts/cas850_watchmode_backfill.py's --ids-from, the same manifest-path contract CAS-889 built.
//
// Deliberately calls wmCinemaScore/wmQScore, never cascadeScore: CAS-919 moved cascadeScore onto
// the Watchmode fields, so dispatching through cascadeScore here would blend buzz and quality into
// one number and lose the OR this rule needs. The rule mirrors cascadeScore's own primaryStatus
// branch so today's score coverage — not tomorrow's — is what decides who gets fetched.
// CAS-986: qScore/cinemaScore were themselves retired by CAS-919/CAS-907 (renamed to wmQScore/
// wmCinemaScore) — this rule went uncaught because tests/js/wm-scoreable-manifest.test.mjs's AC3
// always failed earlier, on the committed manifest's own staleness, before ever reaching a real
// isScoreable() call. Confirmed by direct invocation: both calls threw "is not a function".
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadEngine } from "../tests/js/engine.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "state", "wm_backfill_scoreable.txt");

// CAS-997: `floor` is the Cascade-score publication floor (default 0 — every existing caller
// except scripts/scoreable_shim.mjs's publication test wants the old, unfloored rule; the CAS-922
// manifest above must keep asking "would this score at all today", not "would this publish").
// `upcoming` never takes a floor — a genuinely upcoming title is admitted on cinema buzz alone,
// which has no quality signal yet to floor. The cinema statuses (in_cinema/opening_week) still
// pass on cinema buzz alone too; the floor only gates their OR'd wmQScore alternative.
export function isScoreable(E, m, floor = 0){
  const ps = E.primaryStatus(m);
  if(ps === "upcoming") return E.wmCinemaScore(m) >= 0;
  if(ps === "in_cinema" || ps === "opening_week") return E.wmCinemaScore(m) >= 0 || E.wmQScore(m) >= floor;
  return E.wmQScore(m) >= floor;
}

/** -> [tmdb_id, ...], most popular first, over every film not yet Watchmode-fetched that satisfies isScoreable. */
export function scoreableIds(E){
  return E.MOVIES
    .filter(m => !m.wm_fields_fetched_at && isScoreable(E, m))
    .sort((a, b) => (b.popularity || 0) - (a.popularity || 0))
    .map(m => m.tmdb_id);
}

export function manifestText(ids, date = new Date().toISOString().slice(0, 10)){
  return `# ${date} - ${ids.length} films scoreable today, not yet Watchmode-fetched, popularity descending\n`
    + ids.map(id => `${id}\n`).join("");
}

function run(){
  const E = loadEngine();
  const ids = scoreableIds(E);
  fs.writeFileSync(OUT, manifestText(ids));
  console.log(`${ids.length} films written to ${path.relative(ROOT, OUT)}`);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if(isMain) run();
