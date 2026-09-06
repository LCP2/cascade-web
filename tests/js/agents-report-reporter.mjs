// CAS-794: node:test reporter for `npm run test:agents` (never used by `npm run qa`). Appends one
// PASS/FAIL/SKIP line per check to the file named by QA_AGENTS_REPORT — see run-agent-suite.mjs,
// which sets that env var, runs this alongside the human-readable `spec` reporter, and totals the
// lines this writes together with the python half's once both have run.
import { appendFileSync } from "node:fs";

const REPORT_PATH = process.env.QA_AGENTS_REPORT;

// The suite names each check in the test name itself, "<id>: <description>" (CAS-789's own
// placeholder tests already follow this — "CAS-789: placeholder" — and future checks use a short
// id like "G1" or "K7" in the same slot); take whatever precedes the first colon as the id.
function checkId(name) {
  const i = name.indexOf(":");
  return i === -1 ? name : name.slice(0, i).trim();
}

function oneLine(text) {
  const first = String(text ?? "").split("\n")[0].trim();
  return first || "failed";
}

export default async function* (source) {
  for await (const event of source) {
    // node:test also emits pass/fail events for describe() suites, not just leaf tests; this
    // suite is flat today, but skip non-"test" events so a future describe() block can't double
    // up on the per-check line count AC1 requires.
    if (event.data?.details?.type !== "test") continue;
    if (event.type !== "test:pass" && event.type !== "test:fail") continue;

    const { name, skip } = event.data;
    const id = checkId(name);
    let line;
    if (event.type === "test:fail") {
      line = `FAIL ${id} - ${oneLine(event.data.details.error?.message)}`;
    } else if (skip) {
      line = `SKIP ${id} - ${typeof skip === "string" ? skip : "skipped"}`;
    } else {
      line = `PASS ${id}`;
    }
    appendFileSync(REPORT_PATH, line + "\n");
  }
}
