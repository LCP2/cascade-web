// CAS-794: the actual `npm run test:agents` entry point. Runs the node half (tests/js/agents.test.mjs)
// then the python half (monitor/agent_tests, via `python -m monitor.agent_tests`) — both append one
// PASS/FAIL/SKIP line per check to qa-agents-report.txt at the repo root (a local artefact, see
// .gitignore) — then appends the TOTAL/COMMIT summary. Exits non-zero if either half failed, exactly
// as the old `node --test ... && python -m unittest ...` chain did.
import { spawnSync } from "node:child_process";
import { writeFileSync, appendFileSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, "..", "..");
const REPORT_PATH = path.join(REPO_ROOT, "qa-agents-report.txt");
// Node's ESM loader parses a bare `--test-reporter` value as a URL, and an absolute Windows path
// ("C:\...") reads as scheme "c:" and gets rejected — pass it relative to cwd (REPO_ROOT) instead.
const REPORTER_ARG = "./" + path.relative(REPO_ROOT, path.join(__dirname, "agents-report-reporter.mjs")).split(path.sep).join("/");
const TEST_FILE_ARG = "./" + path.relative(REPO_ROOT, path.join(__dirname, "agents.test.mjs")).split(path.sep).join("/");

writeFileSync(REPORT_PATH, "");

const env = { ...process.env, QA_AGENTS_REPORT: REPORT_PATH };

const nodeHalf = spawnSync(process.execPath, [
  "--test",
  "--test-reporter=spec", "--test-reporter-destination=stdout",
  "--test-reporter=" + REPORTER_ARG, "--test-reporter-destination=stdout",
  TEST_FILE_ARG,
], { cwd: REPO_ROOT, stdio: "inherit", env });

const pythonHalf = spawnSync("python", ["-m", "monitor.agent_tests"], {
  cwd: REPO_ROOT, stdio: "inherit", env,
});

const lines = readFileSync(REPORT_PATH, "utf8").split("\n").filter(Boolean);
const pass = lines.filter(l => l.startsWith("PASS ")).length;
const fail = lines.filter(l => l.startsWith("FAIL ")).length;
const sha = spawnSync("git", ["rev-parse", "--short", "HEAD"], { cwd: REPO_ROOT, encoding: "utf8" }).stdout.trim();

appendFileSync(REPORT_PATH, `\nTOTAL ${lines.length} PASS ${pass} FAIL ${fail}\nCOMMIT ${sha}\n`);

process.exit((nodeHalf.status || 0) !== 0 || (pythonHalf.status || 0) !== 0 ? 1 : 0);
