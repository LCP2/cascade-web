#!/usr/bin/env node
// CAS-922: builds state/wm_backfill_scoreable.txt — every film that would produce a Cascade score
// TODAY (via qScore/cinemaScore) and has not yet had its Watchmode fields fetched. Feeds
// scripts/cas850_watchmode_backfill.py's --ids-from, the same manifest-path contract CAS-889 built.
//
// Deliberately calls qScore/cinemaScore, never cascadeScore: CAS-919 moves cascadeScore onto the
// Watchmode fields, and once that lands this rule would start selecting the wrong films if it
// dispatched through cascadeScore instead. The rule mirrors cascadeScore's own primaryStatus branch
// so today's score coverage — not tomorrow's — is what decides who gets fetched.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadEngine } from "../tests/js/engine.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "state", "wm_backfill_scoreable.txt");

export function isScoreable(E, m){
  const ps = E.primaryStatus(m);
  if(ps === "upcoming") return E.cinemaScore(m) >= 0;
  if(ps === "in_cinema" || ps === "opening_week") return E.cinemaScore(m) >= 0 || E.qScore(m) >= 0;
  return E.qScore(m) >= 0;
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
