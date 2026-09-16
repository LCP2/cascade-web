// CAS-992: scripts/scoreable_shim.mjs must never let one malformed candidate (e.g. missing
// `status`, the shape merge_backcatalogue_candidates was producing before this fix) fail the
// whole batch call — that took down every nightly refresh's scoreability pass. A record that
// throws inside isScoreable() is treated as not scoreable; everything else in the batch still
// gets a real answer.
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { loadEngine } from "./engine.mjs";
import { isScoreable } from "../../scripts/wm_scoreable_manifest.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const SHIM = path.join(ROOT, "scripts", "scoreable_shim.mjs");

function runShim(movies){
  const result = spawnSync(process.execPath, [SHIM], {
    input: JSON.stringify({ movies }),
    encoding: "utf8",
  });
  return result;
}

test("CAS-992 AC3: a batch with one status-less record plus one real scoreable record exits 0 and still returns the real id", () => {
  const E = loadEngine();
  const real = E.MOVIES.find(m => isScoreable(E, m));
  assert.ok(real, "fixture must contain at least one real scoreable movie");

  const malformed = { tmdb_id: -1, title: "No status", year: 2020, popularity: 1 };
  const result = runShim([malformed, real]);

  assert.equal(result.status, 0, `shim must exit 0, got stderr: ${result.stderr}`);
  const { scoreable_ids } = JSON.parse(result.stdout);
  assert.ok(scoreable_ids.includes(real.tmdb_id), "the real record's id must still come through");
  assert.ok(!scoreable_ids.includes(-1), "the malformed record must never be treated as scoreable");
});

test("CAS-992: a record that throws inside isScoreable() is counted on stderr, not stdout", () => {
  const malformed = { tmdb_id: -1, title: "No status", year: 2020, popularity: 1 };
  const result = runShim([malformed]);

  assert.equal(result.status, 0);
  assert.deepEqual(JSON.parse(result.stdout), { scoreable_ids: [] });
  assert.match(result.stderr, /1 record\(s\) threw/);
});
