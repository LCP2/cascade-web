#!/usr/bin/env node
// CAS-608: parity check between poc_pipeline.py's _offerless_window and app_template.html's own
// offerlessWindow — a thin pipe into the shipped engine, the same discipline scoreable_shim.mjs
// already established, so the Python test asserting agreement never has to reimplement the JS side.
//
// Request shape:  { "fixtures": [ { "cinema_date": <iso date or null>, "today": <iso date> }, ... ] }
// Response shape: { "windows": [ <"upcoming"|"in_cinema"|"released">, ... ] }
import { loadEngine } from "../tests/js/engine.mjs";

async function readStdin(){
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

async function main(){
  const raw = await readStdin();
  const req = raw.trim() ? JSON.parse(raw) : {};
  const E = loadEngine();
  const fixtures = req.fixtures || [];
  const windows = fixtures.map(f => E.offerlessWindow(f.cinema_date, f.today));
  process.stdout.write(JSON.stringify({ windows }));
}

main().catch(err => {
  console.error(err && err.stack ? err.stack : String(err));
  process.exit(1);
});
