// CAS-789: scaffold for the agent-behaviour suite (run on request via `npm run test:agents`,
// never as part of `npm run qa` — see QA-AGENTS.md). Follow-up tickets fill this file with the
// actual behaviour checks; this placeholder only proves the export surface those checks need is
// really there.
import test from "node:test";
import assert from "node:assert/strict";
import { loadEngine } from "./engine.mjs";

const E = loadEngine();

const REQUIRED_EXPORTS = [
  "recomputeFound", "notify", "entryFor", "cascades", "cascSigOf", "agentFloor",
  "windowEnabled", "windowUsable", "WATCH_LEVEL_KEYS", "firstFound", "admitDrift",
  "filmIsNew", "isNewFound", "admittedAtFor", "watched", "blocked", "movingData",
  "movingWindowRows", "setWatchMarker", "restoreWatchMarker", "msnTrackAreaHTML",
  "msnValueLine", "toggleFilmOpt", "pinFilmToCascadeAndRepaint", "filmWatchSource",
  "filmNotifyState", "listingGroups", "listedBy", "watchesFilm", "agentChipHTML",
  "notifyChipHTML", "agentMetricsCompute", "cascadeScore", "primaryStatus",
  "CascadePersistence", "localStorage",
];

test("CAS-789: placeholder", () => {
  assert.ok(true);
});

test("CAS-789: every required export resolves from tests/js/engine.mjs", () => {
  const missing = REQUIRED_EXPORTS.filter(name => !(name in E) || E[name] === undefined);
  assert.deepEqual(missing, [], `missing engine export(s): ${missing.join(", ")}`);
});
