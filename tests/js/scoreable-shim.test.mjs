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

function runShim(movies, floor){
  const payload = floor === undefined ? { movies } : { movies, floor };
  const result = spawnSync(process.execPath, [SHIM], {
    input: JSON.stringify(payload),
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

// CAS-997 AC1: the publication floor, exercised through the shim exactly as poc_pipeline.py calls
// it (WM_PUBLISH_FLOOR in the request body), against the real shipped engine — no stubbing.
test("CAS-997 AC1: a released title's qScore floor is a hard boundary — scoreable at its own qScore, not one above", () => {
  const E = loadEngine();
  const base = E.MOVIES.find(m => {
    const ps = E.primaryStatus(m);
    return ps !== "upcoming" && ps !== "in_cinema" && ps !== "opening_week" && E.wmQScore(m) >= 0;
  });
  assert.ok(base, "fixture must contain at least one released-cohort movie with a real qScore");
  const q = E.wmQScore(base);

  const atFloor = runShim([base], q);
  assert.equal(atFloor.status, 0, `shim must exit 0, got stderr: ${atFloor.stderr}`);
  assert.ok(JSON.parse(atFloor.stdout).scoreable_ids.includes(base.tmdb_id),
    `qScore ${q} must be scoreable at floor ${q}`);

  const aboveFloor = runShim([base], q + 1);
  assert.ok(!JSON.parse(aboveFloor.stdout).scoreable_ids.includes(base.tmdb_id),
    `qScore ${q} must NOT be scoreable at floor ${q + 1}`);
});

test("CAS-997 AC1: an upcoming title with no qScore is scoreable on cinema buzz alone, no floor applied", () => {
  const E = loadEngine();
  const upcoming = E.MOVIES.find(m => E.primaryStatus(m) === "upcoming" && E.wmCinemaScore(m) >= 0);
  assert.ok(upcoming, "fixture must contain at least one upcoming movie with a cinema score");

  const result = runShim([upcoming], 1000);
  assert.equal(result.status, 0, `shim must exit 0, got stderr: ${result.stderr}`);
  assert.ok(JSON.parse(result.stdout).scoreable_ids.includes(upcoming.tmdb_id),
    "an upcoming title must publish regardless of how high the floor is");
});

test("CAS-997 AC1: an in-cinema title with a cinema score is scoreable regardless of qScore or floor", () => {
  const E = loadEngine();
  const inCinema = E.MOVIES.find(m => {
    const ps = E.primaryStatus(m);
    return (ps === "in_cinema" || ps === "opening_week") && E.wmCinemaScore(m) >= 0;
  });
  assert.ok(inCinema, "fixture must contain at least one in_cinema/opening_week movie with a cinema score");

  const result = runShim([inCinema], 1000);
  assert.equal(result.status, 0, `shim must exit 0, got stderr: ${result.stderr}`);
  assert.ok(JSON.parse(result.stdout).scoreable_ids.includes(inCinema.tmdb_id),
    "a cinema-score title must publish regardless of how high the floor is");
});
