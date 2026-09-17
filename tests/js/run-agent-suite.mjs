// CAS-794: the actual `npm run test:agents` entry point. Runs the node half (tests/js/agents.test.mjs)
// then the python half (monitor/agent_tests, via `python -m monitor.agent_tests`) — both append one
// PASS/FAIL/SKIP line per check to qa-agents-report.txt at the repo root (a local artefact, see
// .gitignore) — then appends the TOTAL/COMMIT summary. Exits non-zero if either half failed, exactly
// as the old `node --test ... && python -m unittest ...` chain did.
//
// CAS-1009: a few checks drive real production code (K1's build_html, the pipeline-resilience/
// data-quality suites K3 runs, J5's real monitor.__main__.main CLI) that write to fixed repo paths
// as a side effect of doing their real job — build-info.js, state/run_stats.json and
// state/user_held_ids.json. None of those checks' own fixtures point at those paths, so there is
// nothing there for a per-test try/finally to restore. Snapshotting the three here, once, around
// the whole run and restoring them byte-for-byte afterwards (binary, same reasoning as K1's own
// restore — see its comment) is the one place that can guarantee `git status` comes back clean
// whichever check(s) end up touching them, this run or a future one.
import { spawnSync } from "node:child_process";
import { writeFileSync, appendFileSync, readFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, "..", "..");
const REPORT_PATH = path.join(REPO_ROOT, "qa-agents-report.txt");
// Node's ESM loader parses a bare `--test-reporter` value as a URL, and an absolute Windows path
// ("C:\...") reads as scheme "c:" and gets rejected — pass it relative to cwd (REPO_ROOT) instead.
const REPORTER_ARG = "./" + path.relative(REPO_ROOT, path.join(__dirname, "agents-report-reporter.mjs")).split(path.sep).join("/");
const TEST_FILE_ARG = "./" + path.relative(REPO_ROOT, path.join(__dirname, "agents.test.mjs")).split(path.sep).join("/");

const GUARDED_PATHS = ["build-info.js", "state/run_stats.json", "state/user_held_ids.json"]
  .map(p => path.join(REPO_ROOT, ...p.split("/")));

function snapshot(paths){
  return paths.map(p => existsSync(p) ? readFileSync(p) : null);
}
function restore(paths, snapshots){
  paths.forEach((p, i) => {
    const before = snapshots[i];
    if(before === null){
      if(existsSync(p)) rmSync(p);
    }else{
      mkdirSync(path.dirname(p), { recursive: true });
      writeFileSync(p, before);
    }
  });
}

writeFileSync(REPORT_PATH, "");

const env = { ...process.env, QA_AGENTS_REPORT: REPORT_PATH };
const guardedSnapshots = snapshot(GUARDED_PATHS);

let nodeHalf, pythonHalf;
try{
  nodeHalf = spawnSync(process.execPath, [
    "--test",
    "--test-reporter=spec", "--test-reporter-destination=stdout",
    "--test-reporter=" + REPORTER_ARG, "--test-reporter-destination=stdout",
    TEST_FILE_ARG,
  ], { cwd: REPO_ROOT, stdio: "inherit", env });

  pythonHalf = spawnSync("python", ["-m", "monitor.agent_tests"], {
    cwd: REPO_ROOT, stdio: "inherit", env,
  });
} finally {
  restore(GUARDED_PATHS, guardedSnapshots);
}

const lines = readFileSync(REPORT_PATH, "utf8").split("\n").filter(Boolean);
const pass = lines.filter(l => l.startsWith("PASS ")).length;
const fail = lines.filter(l => l.startsWith("FAIL ")).length;
const sha = spawnSync("git", ["rev-parse", "--short", "HEAD"], { cwd: REPO_ROOT, encoding: "utf8" }).stdout.trim();

appendFileSync(REPORT_PATH, `\nTOTAL ${lines.length} PASS ${pass} FAIL ${fail}\nCOMMIT ${sha}\n`);

process.exit((nodeHalf.status || 0) !== 0 || (pythonHalf.status || 0) !== 0 ? 1 : 0);
