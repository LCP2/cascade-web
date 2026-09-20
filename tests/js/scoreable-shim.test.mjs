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

// CAS-1040: a candidate the pipeline last confirmed in_cinema, then never re-polled (m.status still
// says "in_cinema"), is exactly what QA-260920-1 found 22 of in production — the app itself
// (deriveStatus, CAS-289/CAS-318) had already advanced every one of them to pvod once their
// ESTIMATED cinema claim outlived CINEMA_ESTIMATE_RUN_DAYS, so they were live and unscored/below
// floor while the publication test still waved them through as cinema-buzz-exempt.
function daysBeforeToday(E, n){
  const d = new Date(Date.parse(E.TODAY));
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
}

test("CAS-1040: a stale ESTIMATED in_cinema claim past its estimate cap is judged as pvod, not cinema-exempt", () => {
  const E = loadEngine();
  const stale = {
    tmdb_id: -1040, title: "Stale Estimated Cinema Claim", year: "2026",
    status: ["in_cinema"], availability_confidence: "estimated", offers: [],
    // Past CINEMA_ESTIMATE_RUN_DAYS (75, CAS-289) but still inside CINEMA_RUN_DAYS (90) — the
    // exact 15-day gap that let m.status keep reading "in_cinema" after the app moved on.
    cinema_date: daysBeforeToday(E, 80),
    wm_user_rating: null, wm_critic_score: null, wm_popularity_percentile: 90,
  };

  const result = runShim([stale], 60);
  assert.equal(result.status, 0, `shim must exit 0, got stderr: ${result.stderr}`);
  assert.ok(!JSON.parse(result.stdout).scoreable_ids.includes(-1040),
    "a stale estimated in_cinema claim with no real offer and no qScore must not stay cinema-" +
    "exempt once the app itself would already show it as pvod");
});

test("CAS-1040: the same claim is still scoreable while genuinely inside its estimate window", () => {
  const E = loadEngine();
  const fresh = {
    tmdb_id: -1041, title: "Fresh Estimated Cinema Claim", year: "2026",
    status: ["in_cinema"], availability_confidence: "estimated", offers: [],
    cinema_date: daysBeforeToday(E, 10), // well inside CINEMA_ESTIMATE_RUN_DAYS (75)
    wm_user_rating: null, wm_critic_score: null, wm_popularity_percentile: 90,
  };

  const result = runShim([fresh], 60);
  assert.equal(result.status, 0, `shim must exit 0, got stderr: ${result.stderr}`);
  assert.ok(JSON.parse(result.stdout).scoreable_ids.includes(-1041),
    "a genuinely current in_cinema claim must still be cinema-exempt from the floor");
});

// CAS-1040 regression: the fix above must only re-derive status for a claim that is CURRENTLY
// cinema. A CAS-1029/CAS-1023 candidate stub (scored-only, pre-TMDB-enrichment: no offers, no
// cinema_date, no claimedStatus, status literally []) is not a real movie record — running
// deriveStatus's offerless-window fallback over one invents an "upcoming" window and wrongly
// exempts it from the wmQScore floor via the cinema-buzz path, which is exactly the bug that made
// tests.test_cas1029_publish_backcatalogue fail once this file's fix first shipped.
test("CAS-1040: a scored-only candidate stub with no cinema claim at all is still floored on wmQScore, not treated as upcoming", () => {
  const aboveFloor = {
    tmdb_id: -1042, title: "Scored Only Above Floor", year: 2019, popularity: 50,
    status: [], wm_user_rating: 9.0, wm_critic_score: null, wm_popularity_percentile: 80,
  };
  const belowFloor = {
    tmdb_id: -1043, title: "Scored Only Below Floor", year: 2019, popularity: 10,
    status: [], wm_user_rating: 1.0, wm_critic_score: null, wm_popularity_percentile: 80,
  };

  const result = runShim([aboveFloor, belowFloor], 60);
  assert.equal(result.status, 0, `shim must exit 0, got stderr: ${result.stderr}`);
  const { scoreable_ids } = JSON.parse(result.stdout);
  assert.ok(scoreable_ids.includes(-1042), "an above-floor scored-only stub must be scoreable");
  assert.ok(!scoreable_ids.includes(-1043), "a below-floor scored-only stub must not be scoreable");
});
