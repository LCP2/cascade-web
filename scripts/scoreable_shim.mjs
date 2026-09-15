#!/usr/bin/env node
// CAS-986: the two-tier catalogue's publication test. Reads candidate movie dicts on stdin, asks
// the shipped engine which ones can carry a Cascade score today via isScoreable() — the same rule
// scripts/wm_scoreable_manifest.mjs already encodes for CAS-922 — and writes their tmdb_ids on
// stdout. One process for the whole batch, never per title, the same discipline
// monitor/admit_shim.mjs (CAS-825) already established: writing a second copy of this rule in
// Python is the defect CAS-986 exists to avoid, so this file is a thin pipe, not a reimplementation.
//
// Request shape:  { "movies": [ <movie dict>, ... ] }
// Response shape: { "scoreable_ids": [ <tmdb_id>, ... ] }
import { loadEngine } from "../tests/js/engine.mjs";
import { isScoreable } from "./wm_scoreable_manifest.mjs";

async function readStdin(){
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

async function main(){
  const raw = await readStdin();
  const req = raw.trim() ? JSON.parse(raw) : {};
  const E = loadEngine();
  const movies = req.movies || [];
  const scoreable_ids = movies.filter(m => isScoreable(E, m)).map(m => m.tmdb_id);
  process.stdout.write(JSON.stringify({ scoreable_ids }));
}

main().catch(err => {
  console.error(err && err.stack ? err.stack : String(err));
  process.exit(1);
});
