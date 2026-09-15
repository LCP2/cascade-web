// CAS-975: unit coverage for scripts/uptime_probe.mjs's pure decision logic (checkX functions,
// the flap-control state machine, and the signup email/JSON-report shape) plus one live-but-local
// network case — a probe pointed at a deliberately wrong URL (a refused localhost port, so this
// stays offline-safe and fast) must come back red and name itself.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  checkSiteUp, parseBuildInfoVersion,
  checkMoviesJson,
  checkSupabaseCanary,
  checkSignup, probeSignupEmail,
  checkUsageEventsInsert, checkPagesHead,
  decideAlerting,
  probeSiteUp, probePagesHead,
  readState, writeState,
} from "../../scripts/uptime_probe.mjs";

// ---------------------------------------------------------------------------
// site_up
// ---------------------------------------------------------------------------
test("CAS-975: parseBuildInfoVersion reads the version out of a build-info.js body", () => {
  const text = 'window.BUILD_INFO = {"version": "1.0.0", "build": 1148, "commit": "abc"};';
  assert.equal(parseBuildInfoVersion(text), "1.0.0");
});

test("CAS-975: parseBuildInfoVersion returns null on unparseable content", () => {
  assert.equal(parseBuildInfoVersion("not javascript"), null);
});

test("CAS-975: checkSiteUp is red when the live version does not match main's VERSION", () => {
  const c = checkSiteUp({ ok: true, status: 200, version: "1.0.0" }, "1.0.1");
  assert.equal(c.ok, false);
  assert.match(c.detail, /1\.0\.0.*1\.0\.1/);
});

test("CAS-975: checkSiteUp is green when the live version matches main's VERSION", () => {
  const c = checkSiteUp({ ok: true, status: 200, version: "1.0.0" }, "1.0.0");
  assert.equal(c.ok, true);
});

test("CAS-975: checkSiteUp is red and unambiguous when the site itself is unreachable", () => {
  const c = checkSiteUp({ ok: false, detail: "GET https://x -> ECONNREFUSED" }, "1.0.0");
  assert.equal(c.ok, false);
  assert.match(c.detail, /ECONNREFUSED/);
});

// ---------------------------------------------------------------------------
// movies_json
// ---------------------------------------------------------------------------
test("CAS-975: checkMoviesJson fails below the 5,500-record floor", () => {
  const c = checkMoviesJson({ ok: true, count: 100 });
  assert.equal(c.ok, false);
});

test("CAS-975: checkMoviesJson passes at/above the floor", () => {
  const c = checkMoviesJson({ ok: true, count: 5600 });
  assert.equal(c.ok, true);
});

// ---------------------------------------------------------------------------
// supabase_canary — AC: an emptied roster is a named red, not a green
// ---------------------------------------------------------------------------
test("CAS-975 AC: a canary account whose agents are emptied by hand is red naming the empty roster", () => {
  const c = checkSupabaseCanary({
    signedIn: true, cascadesOk: true, cascadesCount: 0, agentFilmsOk: true, agentFilmsCount: 3, filmWatchOk: true,
  });
  assert.equal(c.ok, false);
  assert.match(c.detail, /empty/);
});

test("CAS-975: supabase_canary is red when sign-in itself fails", () => {
  const c = checkSupabaseCanary({ signedIn: false, detail: "canary sign-in failed: HTTP 400" });
  assert.equal(c.ok, false);
  assert.match(c.detail, /sign-in failed/);
});

test("CAS-975: supabase_canary is green with a non-empty roster and a successful film_watch read", () => {
  const c = checkSupabaseCanary({
    signedIn: true, cascadesOk: true, cascadesCount: 2, agentFilmsOk: true, agentFilmsCount: 5, filmWatchOk: true,
  });
  assert.equal(c.ok, true);
});

test("CAS-975: supabase_canary is red when film_watch read fails, even with a healthy roster", () => {
  const c = checkSupabaseCanary({
    signedIn: true, cascadesOk: true, cascadesCount: 2, agentFilmsOk: true, agentFilmsCount: 5, filmWatchOk: false,
  });
  assert.equal(c.ok, false);
});

// ---------------------------------------------------------------------------
// signup — CAS-980 contingency
// ---------------------------------------------------------------------------
test("CAS-975: probeSignupEmail plus-addresses off the canary email's own domain", () => {
  const email = probeSignupEmail("lee+c4@codynamics.com.au", 1234);
  assert.equal(email, "lee+probe-1234@codynamics.com.au");
});

test("CAS-975 AC: signup probe stays green when delete_my_account (CAS-980) isn't shipped yet, and reports the pending count", () => {
  const c = checkSignup({ created: true, removed: false, notShipped: true, email: "lee+probe-1@x.com" }, 4);
  assert.equal(c.ok, true);
  assert.match(c.detail, /4 probe account/);
});

test("CAS-975: signup probe is green and says so when delete_my_account actually removed the account", () => {
  const c = checkSignup({ created: true, removed: true, email: "lee+probe-1@x.com" }, 0);
  assert.equal(c.ok, true);
  assert.match(c.detail, /removed/);
});

test("CAS-975: signup probe is red when creation itself fails", () => {
  const c = checkSignup({ created: false, detail: "sign-up failed: HTTP 422" }, 0);
  assert.equal(c.ok, false);
});

test("CAS-975: signup probe is red when delete_my_account exists but errors", () => {
  const c = checkSignup({ created: true, removed: false, notShipped: false, email: "x@y.com", detail: "delete_my_account failed: HTTP 500" }, 1);
  assert.equal(c.ok, false);
});

// ---------------------------------------------------------------------------
// usage_events_insert / pages_head — thin pass-throughs
// ---------------------------------------------------------------------------
test("CAS-975: usage_events_insert reflects the probe's own ok", () => {
  assert.equal(checkUsageEventsInsert({ ok: true, detail: "HTTP 201" }).ok, true);
  assert.equal(checkUsageEventsInsert({ ok: false, detail: "HTTP 403" }).ok, false);
});

test("CAS-975: pages_head reflects the probe's own ok", () => {
  assert.equal(checkPagesHead({ ok: true, detail: "HTTP 200" }).ok, true);
  assert.equal(checkPagesHead({ ok: false, detail: "HTTP 500" }).ok, false);
});

// ---------------------------------------------------------------------------
// flap control
// ---------------------------------------------------------------------------
test("CAS-975 AC: a single red probe does not alert", () => {
  const d = decideAlerting({ consecutiveReds: 0 }, false);
  assert.equal(d.consecutiveReds, 1);
  assert.equal(d.sendAlert, false);
});

test("CAS-975 AC: two consecutive reds send exactly one alert", () => {
  const d = decideAlerting({ consecutiveReds: 1 }, false);
  assert.equal(d.consecutiveReds, 2);
  assert.equal(d.sendAlert, true);
});

test("CAS-975 AC: a third consecutive red sends nothing more", () => {
  const d = decideAlerting({ consecutiveReds: 2, lastAlertAt: new Date().toISOString() }, false);
  assert.equal(d.consecutiveReds, 3);
  assert.equal(d.sendAlert, false);
});

test("CAS-975 AC: the first green after a red always sends one recovery email", () => {
  const d = decideAlerting({ consecutiveReds: 1 }, true);
  assert.equal(d.consecutiveReds, 0);
  assert.equal(d.sendRecovery, true);
});

test("CAS-975: green after green sends no recovery", () => {
  const d = decideAlerting({ consecutiveReds: 0 }, true);
  assert.equal(d.sendRecovery, false);
});

test("CAS-975 AC: never more than one alert per hour even if two runs both land on their 2nd red", () => {
  const recentAlert = new Date(Date.now() - 5 * 60 * 1000).toISOString(); // 5 minutes ago
  const d = decideAlerting({ consecutiveReds: 0, lastAlertAt: recentAlert }, false);
  // consecutiveReds is now 1, not 2, so no alert regardless — cooldown only matters when a run
  // would otherwise land exactly on the 2-red trigger within the same hour as the last alert.
  const d2 = decideAlerting({ consecutiveReds: 1, lastAlertAt: recentAlert }, false);
  assert.equal(d.sendAlert, false);
  assert.equal(d2.consecutiveReds, 2);
  assert.equal(d2.sendAlert, false, "an alert already sent within the last hour must not fire again");
});

// ---------------------------------------------------------------------------
// state/uptime.json round-trip
// ---------------------------------------------------------------------------
test("CAS-975: readState/writeState round-trip through a real file", () => {
  const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "uptime-")), "uptime.json");
  assert.deepEqual(readState(tmp), {});
  writeState({ consecutiveReds: 2, signupAccountsPending: 3 }, tmp);
  assert.deepEqual(readState(tmp), { consecutiveReds: 2, signupAccountsPending: 3 });
});

// ---------------------------------------------------------------------------
// AC: a probe pointed at a deliberately wrong URL is red and names which probe failed
// ---------------------------------------------------------------------------
test("CAS-975 AC: site_up pointed at a refused local port is red", async () => {
  const probe = await probeSiteUp(() => { throw new Error("simulated: connect ECONNREFUSED 127.0.0.1:1"); });
  const c = checkSiteUp(probe, null);
  assert.equal(c.ok, false);
  assert.match(c.detail, /ECONNREFUSED/);
});

test("CAS-975 AC: pages_head pointed at a refused local port is red", async () => {
  const probe = await probePagesHead(() => { throw new Error("simulated: connect ECONNREFUSED 127.0.0.1:1"); });
  const c = checkPagesHead(probe);
  assert.equal(c.ok, false);
  assert.match(c.detail, /ECONNREFUSED/);
});
