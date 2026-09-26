// CAS-1070: App Store requires a privacy policy link reachable inside the app, and a support link.
// Covers two surfaces: the About screen (Menu → About) and the account sign-up email step on #membScreen
// (shown when membNeedsEmail() is true — a configured, signed-out build).
import { test, expect } from "@playwright/test";
import { toShortlist, finishFlow, toListing } from "./helpers.mjs";

const PRIVACY_URL = "https://www.codynamics.com.au/privacy";
const SUPPORT_URL = "https://www.codynamics.com.au/support";

test("About screen (Menu → About) links to Privacy policy and Support (CAS-1070 AC1)", async ({ page }) => {
  await toShortlist(page, "cinema");
  await finishFlow(page);
  await toListing(page);

  await page.locator("#navMenuBtn").click();
  await page.locator("#navMenu .navitem", { hasText: "About" }).click();
  await expect(page.locator("#aboutScreen.open")).toBeVisible();

  const privacy = page.locator("#aboutScreen a", { hasText: "Privacy policy" });
  await expect(privacy).toBeVisible();
  await expect(privacy).toHaveAttribute("href", PRIVACY_URL);

  const support = page.locator("#aboutScreen a", { hasText: "Support" });
  await expect(support).toBeVisible();
  await expect(support).toHaveAttribute("href", SUPPORT_URL);
});

// Reuses the CAS-913/smoke.spec.mjs technique for a configured-but-signed-out device: a REAL (fake)
// Supabase config from page load, not freshApp's guest-mode 404, so membNeedsEmail() is true and
// #membScreen's email step actually renders. Reached directly via ?step=membership (same preview entry
// CAS-1069's own standalone-preview test uses) rather than walking the full onboarding flow, since this
// only needs the email step's own markup, not a completed roster.
const CAS1070_FAKE_SUPABASE_GLOBAL = `
  function chain(){
    return new Proxy(() => {}, {
      get: (_t, prop) => prop === "then" ? (resolve) => resolve({ data: [], error: null }) : () => chain(),
      apply: () => chain(),
    });
  }
  window.supabase = { createClient(){
    return {
      auth: {
        getSession: async () => ({ data: { session: null } }),
        onAuthStateChange: () => ({ data: { subscription: { unsubscribe(){} } } }),
        signInWithOtp: async () => ({ data: {}, error: null }),
        verifyOtp: async () => ({ data: {}, error: null }),
        signOut: async () => ({ error: null }),
      },
      from: () => chain(),
    };
  } };
`;

test("membScreen email step links to Privacy policy when membNeedsEmail() is true (CAS-1070 AC2)", async ({ page }) => {
  await page.route("**/config.js", route => route.fulfill({
    contentType: "application/javascript",
    body: `window.CASCADE_CONFIG = { SUPABASE_URL: "https://fake-project.supabase.test", SUPABASE_ANON_KEY: "fake-anon-key-not-a-real-secret" };`,
  }));
  await page.route("**/supabase-js.js", route => route.fulfill({
    contentType: "application/javascript",
    body: CAS1070_FAKE_SUPABASE_GLOBAL,
  }));
  await page.goto("/index.html?step=membership");
  await page.evaluate(() => { try{ localStorage.clear(); }catch(e){} });
  await page.goto("/index.html?step=membership");
  await page.waitForFunction(() => typeof flowStart === "function" && Array.isArray(MOVIES));

  await expect(page.locator("#membScreen.open")).toBeVisible();
  await expect(page.locator("#membEmail")).toBeVisible();

  const privacy = page.locator("#membBody a", { hasText: "Privacy policy" });
  await expect(privacy).toBeVisible();
  await expect(privacy).toHaveAttribute("href", PRIVACY_URL);
});
