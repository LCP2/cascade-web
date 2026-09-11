// CAS-922: checks state/wm_backfill_scoreable.txt (the manifest scripts/wm_scoreable_manifest.mjs
// generates) against the built MOVIES — the header's own count must match the id lines, every id must
// really satisfy the rule, and no film the rule selects may be missing from the file.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadEngine } from "./engine.mjs";
import { isScoreable, scoreableIds } from "../../scripts/wm_scoreable_manifest.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const MANIFEST_PATH = path.join(ROOT, "state", "wm_backfill_scoreable.txt");

function readManifest(){
  const lines = fs.readFileSync(MANIFEST_PATH, "utf8").split("\n").map(l => l.trim()).filter(Boolean);
  const [header, ...idLines] = lines;
  return { header, ids: idLines.map(Number) };
}

test("CAS-922 AC2: the manifest's header count equals its number of id lines", () => {
  const { header, ids } = readManifest();
  const match = header.match(/^#\s+\S+\s+-\s+(\d+)\s+films/);
  assert.ok(match, `header must give a films count: "${header}"`);
  assert.equal(ids.length, Number(match[1]), "AC2: header count must match the number of id lines");
});

test("CAS-922 AC3: the manifest is exactly the set of unfetched films the scoreable rule selects", () => {
  const E = loadEngine();
  const { ids } = readManifest();
  const byId = new Map(E.MOVIES.map(m => [m.tmdb_id, m]));

  for(const id of ids){
    const m = byId.get(id);
    assert.ok(m, `manifest id ${id} must exist in the built MOVIES`);
    assert.ok(!m.wm_fields_fetched_at, `manifest id ${id} must not already carry wm_fields_fetched_at`);
    assert.ok(isScoreable(E, m), `manifest id ${id} must satisfy the scoreable rule`);
  }

  assert.deepEqual(new Set(ids), new Set(scoreableIds(E)),
    "AC3: the file must contain exactly the films the rule selects today, no more, no fewer");
});
