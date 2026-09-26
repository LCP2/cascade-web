// CAS-1073: App Review sign-in — a single allowlisted review address (appreview@codynamics.com.au)
// exchanges a fixed password (the reviewer code, never in this repo) instead of an emailed OTP, on the
// exact same account-modal code screen everyone else uses. Every other email is unaffected.
//
// Reaches the account modal directly via window.openAccountAuth() — the same global the real "Not
// signed in" account row calls (app_template.html) — on a configured-but-signed-out fake-Supabase
// build, rather than walking full onboarding just to click that row. No network: window.supabase is a
// local fake (no esm.sh import, no live project), matching every other auth spec in this suite
// (CAS-1070.spec.mjs, smoke.spec.mjs).
import { test, expect } from "@playwright/test";

const REVIEW_EMAIL = "appreview@codynamics.com.au";
const NORMAL_EMAIL = "e2e-cas1073@example.com";

// Records every auth call the module makes, so a test can assert exactly which path ran.
const CAS1073_FAKE_SUPABASE_GLOBAL = `
  function chain(){
    return new Proxy(() => {}, {
      get: (_t, prop) => prop === "then" ? (resolve) => resolve({ data: [], error: null }) : () => chain(),
      apply: () => chain(),
    });
  }
  window.__cas1073Calls = [];
  window.supabase = { createClient(){
    return {
      auth: {
        getSession: async () => ({ data: { session: null } }),
        onAuthStateChange: () => ({ data: { subscription: { unsubscribe(){} } } }),
        signInWithOtp: async (args) => { window.__cas1073Calls.push({ method: "signInWithOtp", args }); return { data: {}, error: null }; },
        verifyOtp: async (args) => { window.__cas1073Calls.push({ method: "verifyOtp", args }); return { data: {}, error: null }; },
        signInWithPassword: async (args) => { window.__cas1073Calls.push({ method: "signInWithPassword", args }); return { data: {}, error: null }; },
        signOut: async () => ({ error: null }),
      },
      from: () => chain(),
    };
  } };
`;

async function bootSignedOut(page){
  await page.route("**/config.js", route => route.fulfill({
    contentType: "application/javascript",
    body: `window.CASCADE_CONFIG = { SUPABASE_URL: "https://fake-project.supabase.test", SUPABASE_ANON_KEY: "fake-anon-key-not-a-real-secret" };`,
  }));
  await page.route("**/supabase-js.js", route => route.fulfill({
    contentType: "application/javascript",
    body: CAS1073_FAKE_SUPABASE_GLOBAL,
  }));
  await page.goto("/index.html");
  await page.evaluate(() => { try{ localStorage.clear(); }catch(e){} });
  await page.goto("/index.html");
  await page.waitForFunction(() => typeof flowStart === "function" && Array.isArray(MOVIES));
  await page.waitForFunction(() => window.CascadeAuth && window.CascadeAuth.status === "signed-out");
}

/** Opens the account modal straight onto its signed-out (email) screen — the same global the real
 * "Not signed in" account row calls. */
async function openAuthModal(page){
  await page.evaluate(() => window.openAccountAuth());
  await expect(page.locator("#authModal.open")).toBeVisible();
  await expect(page.locator("#authSignedOut")).toBeVisible();
}

/** CAS-1073 AC3: the given visible screen must show no password wording, no attribute leaking
 * "password", and must not render `email` anywhere as UI text. */
async function assertScreenSafe(page, screenSelector, email){
  const screen = page.locator(screenSelector);
  const text = (await screen.innerText()).toLowerCase();
  expect(text).not.toMatch(/password/i);
  expect(text).not.toContain(email.toLowerCase());
  const attrLeaks = await screen.evaluate(el => {
    const bad = [];
    for(const node of el.querySelectorAll("*")){
      for(const attr of ["placeholder", "aria-label", "title"]){
        const v = node.getAttribute(attr);
        if(v && /password/i.test(v)) bad.push(`${attr}=${v}`);
      }
    }
    return bad;
  });
  expect(attrLeaks).toEqual([]);
}

test("CAS-1073 AC1/AC3: the review address signs in via signInWithPassword, never OTP, and leaks nothing", async ({ page }) => {
  await bootSignedOut(page);
  await openAuthModal(page);
  await assertScreenSafe(page, "#authSignedOut", REVIEW_EMAIL);
  expect(await page.locator("#authCode").getAttribute("type")).not.toBe("password");

  await page.locator("#authEmail").fill(REVIEW_EMAIL);
  await page.locator("#authContinue").click();
  await expect(page.locator("#authVerify")).toBeVisible();
  // AC1: the email step alone must not have called signInWithOtp.
  expect(await page.evaluate(() => window.__cas1073Calls)).toEqual([]);
  await assertScreenSafe(page, "#authVerify", REVIEW_EMAIL);
  expect(await page.locator("#authCode").getAttribute("type")).not.toBe("password");

  await page.locator("#authCode").fill("654321");
  await page.locator("#authVerifyBtn").click();
  await expect(page.locator("#authModal.open")).toBeHidden();

  const calls = await page.evaluate(() => window.__cas1073Calls);
  expect(calls).toEqual([
    { method: "signInWithPassword", args: { email: REVIEW_EMAIL, password: "654321" } },
  ]);
});

test("CAS-1073 AC2/AC3: any other address still uses signInWithOtp then verifyOtp, never signInWithPassword", async ({ page }) => {
  await bootSignedOut(page);
  await openAuthModal(page);
  await assertScreenSafe(page, "#authSignedOut", NORMAL_EMAIL);

  await page.locator("#authEmail").fill(NORMAL_EMAIL);
  await page.locator("#authContinue").click();
  await expect(page.locator("#authVerify")).toBeVisible();
  await assertScreenSafe(page, "#authVerify", NORMAL_EMAIL);

  await page.locator("#authCode").fill("123456");
  await page.locator("#authVerifyBtn").click();
  await expect(page.locator("#authModal.open")).toBeHidden();

  const calls = await page.evaluate(() => window.__cas1073Calls);
  expect(calls).toEqual([
    { method: "signInWithOtp", args: { email: NORMAL_EMAIL, options: { shouldCreateUser: true } } },
    { method: "verifyOtp", args: { email: NORMAL_EMAIL, token: "123456", type: "email" } },
  ]);
});
