#!/usr/bin/env node
// CAS-975: hourly synthetic monitoring — is the site up, does the catalogue parse, can a real
// person sign in. The nightly checks (CAS-974) cover the pipeline; this covers the other 23
// hours, where a Pages/Cloudflare/Supabase outage was previously invisible until a user
// complained.
//
// Six independent probes: site_up, movies_json, supabase_canary, signup, usage_events_insert,
// pages_head. Each is split into a `probeX()` (real network I/O) and a `checkX()` (pure
// pass/fail decision over the probe's result) — the same split monitor/health.py uses — so the
// decision logic is unit-testable without a network.
//
// Flap control: a single red probe must not page anyone. `state/uptime.json` (committed by the
// workflow) carries the running `consecutiveReds` count and the last alert time; decideAlerting()
// is the whole state machine — two consecutive reds send one alert, a third sends nothing more,
// and the first green after any red always sends a recovery so a red is never left open. Never
// more than one alert per hour (a `lastAlertAt` cooldown, belt-and-braces alongside the hourly
// cron cadence itself).
//
// The signup probe follows its own contingency clause: CAS-980 (the delete_my_account RPC) has
// not shipped yet (no such function in supabase/schema.sql at the time this was written), so
// rather than guess at a second deletion mechanism, this probe always ATTEMPTS the real
// delete_my_account RPC after creating the throwaway account, and treats "function does not
// exist" as expected-for-now: it leaves the account in place and reports the running count of
// accounts still pending removal. Once CAS-980 ships, the same code path starts removing them for
// real with no change needed here.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const STATE_FILE = path.join(ROOT, "state", "uptime.json");

const SITE_URL = (process.env.CASCADE_SITE_URL || "https://cascademovies.com").replace(/\/$/, "");
const MOVIES_JSON_URL = process.env.CASCADE_MOVIES_JSON_URL || `${SITE_URL}/movies.json`;
const PAGES_URL = process.env.CASCADE_PAGES_URL || "https://cascade-web-3x1.pages.dev/";
const MAIN_VERSION = (process.env.CASCADE_MAIN_VERSION || "").trim() || null;

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
const CANARY_EMAIL = process.env.CASCADE_CANARY_EMAIL;
const CANARY_PASSWORD = process.env.CASCADE_CANARY_PASSWORD;

const RESEND_API_KEY = process.env.RESEND_API_KEY;
const EMAIL_FROM = process.env.CASCADE_EMAIL_FROM || "Cascade <onboarding@resend.dev>";
const ALERT_TO = process.env.CASCADE_ALERT_TO;

export const CATALOGUE_MIN = 5500;
const ONE_HOUR_MS = 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 10000;

function withTimeout(opts = {}) {
  return { ...opts, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) };
}

// ---------------------------------------------------------------------------
// site_up
// ---------------------------------------------------------------------------
export function parseBuildInfoVersion(text) {
  const m = /window\.BUILD_INFO\s*=\s*(\{[\s\S]*?\})\s*;/.exec(text || "");
  if (!m) return null;
  try { return JSON.parse(m[1]).version || null; } catch { return null; }
}

export async function probeSiteUp(fetchImpl = fetch) {
  let res;
  try {
    res = await fetchImpl(SITE_URL, withTimeout());
  } catch (err) {
    return { ok: false, detail: `GET ${SITE_URL} -> ${err && err.message || err}` };
  }
  if (!res.ok) return { ok: false, detail: `GET ${SITE_URL} -> HTTP ${res.status}` };
  try {
    const biRes = await fetchImpl(`${SITE_URL}/build-info.js`, withTimeout());
    if (!biRes.ok) return { ok: true, status: res.status, buildInfoError: `build-info.js -> HTTP ${biRes.status}` };
    const version = parseBuildInfoVersion(await biRes.text());
    return { ok: true, status: res.status, version };
  } catch (err) {
    return { ok: true, status: res.status, buildInfoError: `build-info.js -> ${err && err.message || err}` };
  }
}

export function checkSiteUp(probe, expectedVersion) {
  if (!probe.ok) return { ok: false, detail: probe.detail || "site unreachable" };
  if (probe.buildInfoError) return { ok: false, detail: `build-info.js unreachable: ${probe.buildInfoError}` };
  if (!probe.version) return { ok: false, detail: "build-info.js did not carry a BUILD_INFO.version" };
  if (expectedVersion && probe.version !== expectedVersion) {
    return { ok: false, detail: `live version ${probe.version} does not match main's VERSION ${expectedVersion}` };
  }
  return { ok: true, detail: `HTTP ${probe.status}, version ${probe.version}` };
}

// ---------------------------------------------------------------------------
// movies_json
// ---------------------------------------------------------------------------
export async function probeMoviesJson(fetchImpl = fetch) {
  let res;
  try {
    res = await fetchImpl(MOVIES_JSON_URL, withTimeout());
  } catch (err) {
    return { ok: false, detail: `GET ${MOVIES_JSON_URL} -> ${err && err.message || err}` };
  }
  if (!res.ok) return { ok: false, detail: `GET ${MOVIES_JSON_URL} -> HTTP ${res.status}` };
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch (err) {
    return { ok: false, detail: `movies.json did not parse: ${err.message}` };
  }
  const movies = Array.isArray(data) ? data : data.movies;
  if (!Array.isArray(movies)) return { ok: false, detail: "movies.json parsed but carried no movies array" };
  return { ok: true, count: movies.length };
}

export function checkMoviesJson(probe) {
  if (!probe.ok) return { ok: false, detail: probe.detail || "movies.json unreachable" };
  if (probe.count < CATALOGUE_MIN) {
    return { ok: false, detail: `${probe.count} record(s) — below the ${CATALOGUE_MIN}-record floor` };
  }
  return { ok: true, detail: `${probe.count} record(s), parses.` };
}

// ---------------------------------------------------------------------------
// supabase_canary — sign in, agents (cascades) + agent_films non-empty, film_watch read succeeds
// ---------------------------------------------------------------------------
async function supabaseFetch(fetchImpl, pathAndQuery, { method = "GET", token, body, prefer } = {}) {
  const headers = { apikey: SUPABASE_ANON_KEY, "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (prefer) headers.Prefer = prefer;
  const res = await fetchImpl(`${SUPABASE_URL.replace(/\/$/, "")}${pathAndQuery}`,
    withTimeout({ method, headers, body: body !== undefined ? JSON.stringify(body) : undefined }));
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON body, leave null */ }
  return { status: res.status, ok: res.ok, json };
}

export async function probeSupabaseCanary(fetchImpl = fetch) {
  if (!(SUPABASE_URL && SUPABASE_ANON_KEY && CANARY_EMAIL && CANARY_PASSWORD)) {
    return { signedIn: false, detail: "SUPABASE_URL/SUPABASE_ANON_KEY/CASCADE_CANARY_EMAIL/CASCADE_CANARY_PASSWORD not all set" };
  }
  const signin = await supabaseFetch(fetchImpl, "/auth/v1/token?grant_type=password",
    { method: "POST", body: { email: CANARY_EMAIL, password: CANARY_PASSWORD } });
  const token = signin.json?.access_token;
  if (!signin.ok || !token) {
    return { signedIn: false, detail: `canary sign-in failed: HTTP ${signin.status}` };
  }
  const cascades = await supabaseFetch(fetchImpl, "/rest/v1/cascades?select=id", { token });
  const agentFilms = await supabaseFetch(fetchImpl, "/rest/v1/agent_films?select=movie_id&limit=1", { token });
  const filmWatch = await supabaseFetch(fetchImpl, "/rest/v1/film_watch?select=movie_id&limit=1", { token });
  await supabaseFetch(fetchImpl, "/auth/v1/logout", { method: "POST", token }).catch(() => {});
  return {
    signedIn: true,
    cascadesOk: cascades.ok, cascadesCount: Array.isArray(cascades.json) ? cascades.json.length : null,
    agentFilmsOk: agentFilms.ok, agentFilmsCount: Array.isArray(agentFilms.json) ? agentFilms.json.length : null,
    filmWatchOk: filmWatch.ok,
  };
}

export function checkSupabaseCanary(probe) {
  if (!probe.signedIn) return { ok: false, detail: probe.detail || "canary sign-in failed" };
  if (!probe.cascadesOk) return { ok: false, detail: "canary account's agent roster read failed" };
  if (!probe.cascadesCount) return { ok: false, detail: "canary account's agent roster came back empty" };
  if (!probe.agentFilmsOk) return { ok: false, detail: "canary account's agent_films read failed" };
  if (!probe.agentFilmsCount) return { ok: false, detail: "canary account's agent_films came back empty" };
  if (!probe.filmWatchOk) return { ok: false, detail: "canary account's film_watch read failed" };
  return {
    ok: true,
    detail: `${probe.cascadesCount} agent(s), ${probe.agentFilmsCount} admitted film(s), film_watch read OK.`,
  };
}

// ---------------------------------------------------------------------------
// signup — create a throwaway +probe-<timestamp> account, confirm it, try the real CAS-980
// deletion path, tolerate it not existing yet.
// ---------------------------------------------------------------------------
export function probeSignupEmail(canaryEmail = CANARY_EMAIL, now = Date.now()) {
  const [local, domain] = canaryEmail.split("@");
  const base = local.split("+")[0];
  return `${base}+probe-${now}@${domain}`;
}

function randomPassword() {
  return `Probe-${Date.now()}-${Math.random().toString(36).slice(2)}!`;
}

export async function probeSignup(fetchImpl = fetch) {
  if (!(SUPABASE_URL && SUPABASE_ANON_KEY && CANARY_EMAIL)) {
    return { created: false, detail: "SUPABASE_URL/SUPABASE_ANON_KEY/CASCADE_CANARY_EMAIL not all set" };
  }
  const email = probeSignupEmail();
  const password = randomPassword();
  const signup = await supabaseFetch(fetchImpl, "/auth/v1/signup", { method: "POST", body: { email, password } });
  const userId = signup.json?.id || signup.json?.user?.id || null;
  if (!signup.ok || !userId) {
    return { created: false, detail: `sign-up failed: HTTP ${signup.status}` };
  }

  // A confirmation-required project won't hand back a session here; try a password grant next —
  // if that also carries no session, there is nothing left this probe can do but leave the
  // account exactly where CAS-980's own contingency clause says to.
  let token = signup.json?.access_token || null;
  if (!token) {
    const signin = await supabaseFetch(fetchImpl, "/auth/v1/token?grant_type=password",
      { method: "POST", body: { email, password } });
    token = signin.json?.access_token || null;
  }

  if (!token) return { created: true, removed: false, notShipped: true, email };

  const del = await supabaseFetch(fetchImpl, "/rest/v1/rpc/delete_my_account", { method: "POST", token, body: {} });
  const bodyStr = JSON.stringify(del.json || {});
  const notShipped = del.status === 404 || /Could not find function|PGRST202/i.test(bodyStr);
  const removed = del.ok && !notShipped;
  return {
    created: true, removed, notShipped, email,
    detail: (!removed && !notShipped) ? `delete_my_account failed: HTTP ${del.status}` : null,
  };
}

export function checkSignup(probe, pendingAfter) {
  if (!probe.created) return { ok: false, detail: probe.detail || "sign-up probe failed" };
  if (probe.removed) return { ok: true, detail: `created and removed ${probe.email} via delete_my_account.` };
  if (probe.notShipped) {
    return {
      ok: true,
      detail: `created ${probe.email}; delete_my_account (CAS-980) not live yet, left in place — `
        + `${pendingAfter} probe account(s) pending removal.`,
    };
  }
  return { ok: false, detail: `created ${probe.email} but could not remove it: ${probe.detail}` };
}

// ---------------------------------------------------------------------------
// usage_events_insert — one row, as anon
// ---------------------------------------------------------------------------
export async function probeUsageEventsInsert(fetchImpl = fetch) {
  if (!(SUPABASE_URL && SUPABASE_ANON_KEY)) {
    return { ok: false, detail: "SUPABASE_URL/SUPABASE_ANON_KEY not set" };
  }
  const res = await supabaseFetch(fetchImpl, "/rest/v1/usage_events", {
    method: "POST", prefer: "return=minimal",
    body: { client_key: "cascade-uptime-probe", type: "uptime_probe", data: { source: "scripts/uptime_probe.mjs" } },
  });
  return { ok: res.ok, detail: `HTTP ${res.status}` };
}

export function checkUsageEventsInsert(probe) {
  return { ok: !!probe.ok, detail: probe.detail };
}

// ---------------------------------------------------------------------------
// pages_head
// ---------------------------------------------------------------------------
export async function probePagesHead(fetchImpl = fetch) {
  try {
    const res = await fetchImpl(PAGES_URL, withTimeout({ method: "HEAD" }));
    return { ok: res.ok, detail: `HEAD ${PAGES_URL} -> HTTP ${res.status}` };
  } catch (err) {
    return { ok: false, detail: `HEAD ${PAGES_URL} -> ${err && err.message || err}` };
  }
}

export function checkPagesHead(probe) {
  return { ok: !!probe.ok, detail: probe.detail };
}

// ---------------------------------------------------------------------------
// flap control — two consecutive reds alert once; a third alerts nothing more; the first green
// after any red always closes it out with a recovery. Never more than one alert per hour.
// ---------------------------------------------------------------------------
export function decideAlerting(prevState, allOk, nowMs = Date.now()) {
  const prevReds = (prevState && prevState.consecutiveReds) || 0;
  if (allOk) {
    return { consecutiveReds: 0, sendAlert: false, sendRecovery: prevReds > 0 };
  }
  const consecutiveReds = prevReds + 1;
  const lastAlertAt = prevState && prevState.lastAlertAt ? Date.parse(prevState.lastAlertAt) : null;
  const withinCooldown = lastAlertAt != null && (nowMs - lastAlertAt) < ONE_HOUR_MS;
  const sendAlert = consecutiveReds === 2 && !withinCooldown;
  return { consecutiveReds, sendAlert, sendRecovery: false };
}

async function sendResendEmail(fetchImpl, subject, text) {
  if (!(RESEND_API_KEY && ALERT_TO)) {
    console.log("[uptime] RESEND_API_KEY/CASCADE_ALERT_TO not set — skipping alert email.");
    return;
  }
  try {
    await fetchImpl("https://api.resend.com/emails", withTimeout({
      method: "POST",
      headers: { Authorization: `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: EMAIL_FROM, to: [ALERT_TO], subject, text }),
    }));
  } catch (err) {
    console.error(`::error::Resend send failed: ${err && err.message || err}`);
  }
}

// ---------------------------------------------------------------------------
// state/uptime.json
// ---------------------------------------------------------------------------
export function readState(file = STATE_FILE) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return {}; }
}

export function writeState(state, file = STATE_FILE) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(state, null, 2) + "\n");
}

// ---------------------------------------------------------------------------
// run everything
// ---------------------------------------------------------------------------
async function timeProbe(name, fn) {
  const t0 = Date.now();
  let result;
  try { result = await fn(); } catch (err) { result = { ok: false, detail: `threw: ${err && err.message || err}` }; }
  return { name, ok: !!result.ok, ms: Date.now() - t0, detail: result.detail || "" };
}

export async function runAllProbes(fetchImpl = fetch, prevState = {}) {
  const results = [];
  results.push(await timeProbe("site_up", async () => checkSiteUp(await probeSiteUp(fetchImpl), MAIN_VERSION)));
  results.push(await timeProbe("movies_json", async () => checkMoviesJson(await probeMoviesJson(fetchImpl))));
  results.push(await timeProbe("supabase_canary", async () => checkSupabaseCanary(await probeSupabaseCanary(fetchImpl))));

  let signupPendingAfter = prevState.signupAccountsPending || 0;
  results.push(await timeProbe("signup", async () => {
    const probe = await probeSignup(fetchImpl);
    if (probe.created && !probe.removed) signupPendingAfter += 1;
    return checkSignup(probe, signupPendingAfter);
  }));

  results.push(await timeProbe("usage_events_insert", async () => checkUsageEventsInsert(await probeUsageEventsInsert(fetchImpl))));
  results.push(await timeProbe("pages_head", async () => checkPagesHead(await probePagesHead(fetchImpl))));

  return { results, signupPendingAfter };
}

async function main() {
  const jsonMode = process.argv.includes("--json");
  const prevState = readState();
  const { results, signupPendingAfter } = await runAllProbes(fetch, prevState);
  const allOk = results.every(r => r.ok);
  const decision = decideAlerting(prevState, allOk);

  for (const r of results) {
    if (jsonMode) console.log(JSON.stringify({ name: r.name, ok: r.ok, ms: r.ms, detail: r.detail }));
    else console.log(`[uptime] ${r.name}: ${r.ok ? "OK" : "RED"} (${r.ms}ms) — ${r.detail}`);
  }

  if (decision.sendAlert) {
    const failed = results.filter(r => !r.ok).map(r => r.name).join(", ");
    await sendResendEmail(fetch, "[Cascade ALERT] hourly uptime check red",
      `Two consecutive hourly uptime checks have failed.\nFailing probe(s): ${failed}\n\n`
      + results.map(r => `${r.name}: ${r.ok ? "OK" : "RED"} — ${r.detail}`).join("\n"));
  }
  if (decision.sendRecovery) {
    await sendResendEmail(fetch, "[Cascade RECOVERY] hourly uptime check green",
      `The hourly uptime check is green again after ${(prevState.consecutiveReds || 0)} red run(s).\n\n`
      + results.map(r => `${r.name}: OK — ${r.detail}`).join("\n"));
  }

  writeState({
    lastRun: new Date().toISOString(),
    consecutiveReds: decision.consecutiveReds,
    lastAlertAt: decision.sendAlert ? new Date().toISOString() : (prevState.lastAlertAt || null),
    signupAccountsPending: signupPendingAfter,
    checks: results,
  });

  if (!allOk) {
    console.log(`[uptime] FAILED: ${results.filter(r => !r.ok).map(r => r.name).join(", ")}`);
    process.exitCode = 1;
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main();
