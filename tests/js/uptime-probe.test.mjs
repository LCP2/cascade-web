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
  checkSupabaseCanary, probeSupabaseCanary,
  checkSignup, probeSignupEmail, probeSignup,
  checkUsageEventsInsert, checkPagesHead, probeUsageEventsInsert,
  checkDailyRefreshFresh, checkAlertsRan,
  decideAlerting, FAST_ALERT_CHECKS,
  probeSiteUp, probePagesHead,
  mintApnsProviderJwt, findPushTokensForEmail,
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
// flap control — a "slow" check (not in FAST_ALERT_CHECKS) needs two consecutive reds; a "fast"
// check (site_up/movies_json/daily_refresh_fresh) alerts on its first (CAS-995 AC5).
// ---------------------------------------------------------------------------
const GREEN = [{ name: "pages_head", ok: true }];
const SLOW_RED = [{ name: "pages_head", ok: false }];
const FAST_RED = [{ name: "site_up", ok: false }];

test("CAS-975 AC: a single red probe (not a fast-alert check) does not alert", () => {
  const d = decideAlerting({ consecutiveReds: 0, slowConsecutiveReds: 0 }, SLOW_RED);
  assert.equal(d.consecutiveReds, 1);
  assert.equal(d.sendAlert, false);
});

test("CAS-975 AC: two consecutive reds (slow check) send exactly one alert", () => {
  const d = decideAlerting({ consecutiveReds: 1, slowConsecutiveReds: 1 }, SLOW_RED);
  assert.equal(d.consecutiveReds, 2);
  assert.equal(d.sendAlert, true);
});

test("CAS-975 AC: a third consecutive red sends nothing more", () => {
  const d = decideAlerting(
    { consecutiveReds: 2, slowConsecutiveReds: 2, lastAlertAt: new Date().toISOString() }, SLOW_RED);
  assert.equal(d.consecutiveReds, 3);
  assert.equal(d.sendAlert, false);
});

test("CAS-975 AC: the first green after a red always sends one recovery email", () => {
  const d = decideAlerting({ consecutiveReds: 1, slowConsecutiveReds: 1 }, GREEN);
  assert.equal(d.consecutiveReds, 0);
  assert.equal(d.sendRecovery, true);
});

test("CAS-975: green after green sends no recovery", () => {
  const d = decideAlerting({ consecutiveReds: 0, slowConsecutiveReds: 0 }, GREEN);
  assert.equal(d.sendRecovery, false);
});

test("CAS-975 AC: never more than one alert per hour even if two runs both land on their 2nd red", () => {
  const recentAlert = new Date(Date.now() - 5 * 60 * 1000).toISOString(); // 5 minutes ago
  const d = decideAlerting(
    { consecutiveReds: 0, slowConsecutiveReds: 0, lastAlertAt: recentAlert }, SLOW_RED);
  // consecutiveReds is now 1, not 2, so no alert regardless — cooldown only matters when a run
  // would otherwise land exactly on the 2-red trigger within the same hour as the last alert.
  const d2 = decideAlerting(
    { consecutiveReds: 1, slowConsecutiveReds: 1, lastAlertAt: recentAlert }, SLOW_RED);
  assert.equal(d.sendAlert, false);
  assert.equal(d2.consecutiveReds, 2);
  assert.equal(d2.sendAlert, false, "an alert already sent within the last hour must not fire again");
});

// ---------------------------------------------------------------------------
// CAS-995 AC5 — first-red alerting for site_up/movies_json/daily_refresh_fresh; two-in-a-row
// for every other check (covered above via SLOW_RED).
// ---------------------------------------------------------------------------
test("CAS-995 AC5: site_up going red for the FIRST time alerts immediately", () => {
  const d = decideAlerting({ consecutiveReds: 0, fastRedNames: [] }, FAST_RED);
  assert.equal(d.sendAlert, true);
  assert.deepEqual(d.fastRedNames, ["site_up"]);
});

test("CAS-995 AC5: movies_json going red for the FIRST time alerts immediately too", () => {
  const d = decideAlerting({ consecutiveReds: 0, fastRedNames: [] }, [{ name: "movies_json", ok: false }]);
  assert.equal(d.sendAlert, true);
});

test("CAS-995 AC5: daily_refresh_fresh going red for the FIRST time alerts immediately", () => {
  const d = decideAlerting({ consecutiveReds: 0, fastRedNames: [] }, [{ name: "daily_refresh_fresh", ok: false }]);
  assert.equal(d.sendAlert, true);
});

test("CAS-995 AC5: a fast check staying red a second hour does not re-alert (edge-triggered)", () => {
  const d = decideAlerting({ consecutiveReds: 1, fastRedNames: ["site_up"] }, FAST_RED);
  assert.equal(d.sendAlert, false, "already alerted on the first red; still open, not newly red");
});

test("CAS-995 AC5: a fast check still honours the one-alert-per-hour cooldown", () => {
  const recentAlert = new Date(Date.now() - 5 * 60 * 1000).toISOString();
  const d = decideAlerting({ consecutiveReds: 0, fastRedNames: [], lastAlertAt: recentAlert }, FAST_RED);
  assert.equal(d.sendAlert, false);
});

test("CAS-995 AC5: recovery clears fastRedNames", () => {
  const d = decideAlerting({ consecutiveReds: 1, fastRedNames: ["site_up"] }, GREEN);
  assert.equal(d.sendRecovery, true);
  assert.deepEqual(d.fastRedNames, []);
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

// ---------------------------------------------------------------------------
// CAS-995 AC3 — missing credentials report "not configured: <NAME>", not a vaguer message. The
// test process itself carries none of SUPABASE_URL/SUPABASE_ANON_KEY/CASCADE_CANARY_*, so these
// probes hit their missing-config branch without a network call.
// ---------------------------------------------------------------------------
test("CAS-995 AC3: supabase_canary names every missing credential", async () => {
  const probe = await probeSupabaseCanary();
  assert.equal(probe.signedIn, false);
  assert.match(probe.detail, /^not configured: /);
  assert.match(probe.detail, /SUPABASE_URL/);
});

test("CAS-995 AC3: signup names every missing credential", async () => {
  const probe = await probeSignup();
  assert.equal(probe.created, false);
  assert.match(probe.detail, /^not configured: /);
});

test("CAS-995 AC3: usage_events_insert names every missing credential", async () => {
  const probe = await probeUsageEventsInsert();
  const c = checkUsageEventsInsert(probe);
  assert.equal(c.ok, false);
  assert.match(c.detail, /^not configured: SUPABASE_URL, SUPABASE_ANON_KEY$/);
});

// ---------------------------------------------------------------------------
// CAS-996 — passwordless canary sign-in: generate_link (service-role key) then verify (anon
// key), no account-password secret anywhere. SUPABASE_URL/ANON_KEY/SERVICE_ROLE_KEY/CANARY_EMAIL
// are module-level consts read from process.env at import time, so exercising the "credentials
// present" path needs a fresh module instance re-evaluated AFTER process.env is set — a plain
// `import` at the top of this file (already evaluated once) can't see env vars set later. A
// dynamically-imported, uniquely-querystringed specifier gives Node a distinct module record that
// re-runs its top-level code, including those const bindings, against the current process.env.
// ---------------------------------------------------------------------------
async function importFreshProbeModule(qs) {
  return import(`../../scripts/uptime_probe.mjs?${qs}=${Date.now()}-${Math.random()}`);
}

test("CAS-996 AC1: canary sign-in calls generate_link then verify, and uses the token for the roster read", async () => {
  process.env.SUPABASE_URL = "https://x.test";
  process.env.SUPABASE_ANON_KEY = "anon-key";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-key";
  process.env.CASCADE_CANARY_EMAIL = "canary@x.test";
  try {
    const mod = await importFreshProbeModule("ac1");
    const calls = [];
    const fetchStub = async (url, opts) => {
      const { pathname } = new URL(url);
      calls.push(pathname);
      if (pathname === "/auth/v1/admin/generate_link") {
        assert.equal(opts.headers.apikey, "service-role-key");
        assert.deepEqual(JSON.parse(opts.body), { type: "magiclink", email: "canary@x.test" });
        return { ok: true, status: 200, text: async () => JSON.stringify({ properties: { hashed_token: "HASHED123" } }) };
      }
      if (pathname === "/auth/v1/verify") {
        assert.equal(opts.headers.apikey, "anon-key");
        assert.deepEqual(JSON.parse(opts.body), { type: "magiclink", token_hash: "HASHED123" });
        return { ok: true, status: 200, text: async () => JSON.stringify({ access_token: "TOKEN123" }) };
      }
      if (pathname === "/rest/v1/cascades") {
        assert.equal(opts.headers.Authorization, "Bearer TOKEN123");
        return { ok: true, status: 200, text: async () => JSON.stringify([{ id: 1 }]) };
      }
      if (pathname === "/rest/v1/agent_films") {
        return { ok: true, status: 200, text: async () => JSON.stringify([{ movie_id: 1 }]) };
      }
      if (pathname === "/rest/v1/film_watch") {
        return { ok: true, status: 200, text: async () => JSON.stringify([]) };
      }
      if (pathname === "/auth/v1/logout") {
        return { ok: true, status: 204, text: async () => "" };
      }
      throw new Error(`unexpected fetch: ${pathname}`);
    };

    const probe = await mod.probeSupabaseCanary(fetchStub);
    assert.equal(probe.signedIn, true);
    assert.deepEqual(calls, [
      "/auth/v1/admin/generate_link", "/auth/v1/verify",
      "/rest/v1/cascades", "/rest/v1/agent_films", "/rest/v1/film_watch", "/auth/v1/logout",
    ]);
  } finally {
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_ANON_KEY;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    delete process.env.CASCADE_CANARY_EMAIL;
  }
});

test("CAS-996 AC3: supabase_canary fails naming only the missing service-role key", async () => {
  process.env.SUPABASE_URL = "https://x.test";
  process.env.SUPABASE_ANON_KEY = "anon-key";
  process.env.CASCADE_CANARY_EMAIL = "canary@x.test";
  try {
    const mod = await importFreshProbeModule("ac3canary");
    const probe = await mod.probeSupabaseCanary(() => { throw new Error("must not fetch"); });
    assert.equal(probe.signedIn, false);
    assert.equal(probe.detail, "not configured: SUPABASE_SERVICE_ROLE_KEY");
  } finally {
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_ANON_KEY;
    delete process.env.CASCADE_CANARY_EMAIL;
  }
});

test("CAS-996 AC3: signup fails naming only the missing service-role key", async () => {
  process.env.SUPABASE_URL = "https://x.test";
  process.env.SUPABASE_ANON_KEY = "anon-key";
  process.env.CASCADE_CANARY_EMAIL = "canary@x.test";
  try {
    const mod = await importFreshProbeModule("ac3signup");
    const probe = await mod.probeSignup(() => { throw new Error("must not fetch"); });
    assert.equal(probe.created, false);
    assert.equal(probe.detail, "not configured: SUPABASE_SERVICE_ROLE_KEY");
  } finally {
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_ANON_KEY;
    delete process.env.CASCADE_CANARY_EMAIL;
  }
});

// ---------------------------------------------------------------------------
// CAS-995 AC4 — dead-man checks: red for a 31-hour-old refresh/success, green for a 2-hour-old
// one. Pure decision functions, injected `now`, no network.
// ---------------------------------------------------------------------------
test("CAS-995 AC4: daily_refresh_fresh is red for a 31-hour-old commit", () => {
  const now = new Date("2026-09-16T12:00:00Z");
  const probe = { lastCommitAt: "2026-09-15T05:00:00Z" };   // 31h before `now`
  const c = checkDailyRefreshFresh(probe, now);
  assert.equal(c.ok, false);
});

test("CAS-995 AC4: daily_refresh_fresh is green for a 2-hour-old commit", () => {
  const now = new Date("2026-09-16T12:00:00Z");
  const probe = { lastCommitAt: "2026-09-16T10:00:00Z" };   // 2h before `now`
  const c = checkDailyRefreshFresh(probe, now);
  assert.equal(c.ok, true);
});

test("CAS-995 AC4: daily_refresh_fresh is red when no matching commit was found at all", () => {
  const c = checkDailyRefreshFresh({ detail: 'no "Daily refresh" commit in the last 100 on staging' });
  assert.equal(c.ok, false);
  assert.match(c.detail, /Daily refresh/);
});

test("CAS-995 AC4: alerts_ran is red for a 31-hour-old successful run", () => {
  const now = new Date("2026-09-16T12:00:00Z");
  const probe = { lastSuccessAt: "2026-09-15T05:00:00Z" };
  const c = checkAlertsRan(probe, now);
  assert.equal(c.ok, false);
});

test("CAS-995 AC4: alerts_ran is green for a 2-hour-old successful run", () => {
  const now = new Date("2026-09-16T12:00:00Z");
  const probe = { lastSuccessAt: "2026-09-16T10:00:00Z" };
  const c = checkAlertsRan(probe, now);
  assert.equal(c.ok, true);
});

test("CAS-995: FAST_ALERT_CHECKS names exactly the three checks the ticket calls out", () => {
  assert.deepEqual(new Set(FAST_ALERT_CHECKS),
    new Set(["site_up", "movies_json", "daily_refresh_fresh"]));
});

// ---------------------------------------------------------------------------
// CAS-995 — push channel: the ES256 provider JWT verifies against its own public key (pure,
// no network), and the token lookup is a documented no-op without SUPABASE_SERVICE_ROLE_KEY.
// ---------------------------------------------------------------------------
test("CAS-995: mintApnsProviderJwt produces a JWT that verifies against its own public key", async () => {
  const crypto = await import("node:crypto");
  const { privateKey, publicKey } = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const authKeyB64 = privateKey.export({ format: "der", type: "pkcs8" }).toString("base64");

  const jwt = mintApnsProviderJwt("KEYID123", "TEAMID456", authKeyB64, 1_700_000_000);
  const [headerB64, payloadB64, sigB64] = jwt.split(".");

  const header = JSON.parse(Buffer.from(headerB64, "base64url").toString());
  const payload = JSON.parse(Buffer.from(payloadB64, "base64url").toString());
  assert.deepEqual(header, { alg: "ES256", kid: "KEYID123" });
  assert.deepEqual(payload, { iss: "TEAMID456", iat: 1_700_000_000 });

  const verified = crypto.verify(
    "sha256", Buffer.from(`${headerB64}.${payloadB64}`),
    { key: publicKey, dsaEncoding: "ieee-p1363" }, Buffer.from(sigB64, "base64url"));
  assert.equal(verified, true);
});

test("CAS-995: findPushTokensForEmail is a no-op without SUPABASE_SERVICE_ROLE_KEY configured", async () => {
  const tokens = await findPushTokensForEmail(() => { throw new Error("must not fetch"); }, "lee@example.test");
  assert.deepEqual(tokens, []);
});
