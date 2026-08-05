// CAS-317: email+password sign-up/login replaces the old magic-link flow, because a link has to be
// delivered and clicked and this ticket exists specifically so fictitious test emails can sign in.
//
// This suite must never touch the real production Supabase project that config.js now genuinely ships
// (that's CAS-317's own Part 1) — so it fakes BOTH config.js and the esm.sh supabase-js import with an
// in-memory client, entirely local to the page. helpers.freshApp() blocks config.js for every other spec;
// this file opts back in with its own routes, registered before freshApp's block can apply.
import { test, expect } from "@playwright/test";
import { freshApp, gotoFresh, shortlistCards, pickCard, finishFlow, toListing } from "./helpers.mjs";

const FAKE_SUPABASE_URL = "https://fake-project.supabase.test";
const FAKE_ANON_KEY = "fake-anon-key-not-a-real-secret";

// A minimal in-page stand-in for supabase-js: enough of auth.* for the app's own auth module, plus a
// `.from()` that swallows whatever the persistence layer (CascadePersistence) throws at it so signing in
// doesn't crash on real table queries against a project that doesn't exist.
const FAKE_SUPABASE_MODULE = `
  let session = null;
  const listeners = [];
  const users = new Map();
  const fire = (event) => listeners.slice().forEach(fn => fn(event, session));
  function chain(){
    return new Proxy(() => {}, {
      get: (_t, prop) => prop === "then" ? (resolve) => resolve({ data: [], error: null }) : () => chain(),
      apply: () => chain(),
    });
  }
  export function createClient(){
    return {
      auth: {
        getSession: async () => ({ data: { session } }),
        onAuthStateChange: (cb) => { listeners.push(cb); return { data: { subscription: { unsubscribe(){} } } }; },
        signUp: async ({ email, password }) => {
          if(users.has(email)) return { data: {}, error: { message: "User already registered" } };
          users.set(email, password);
          session = { user: { id: email, email }, access_token: "fake" };
          fire("SIGNED_IN");
          return { data: { session, user: session.user }, error: null };
        },
        signInWithPassword: async ({ email, password }) => {
          if(users.get(email) !== password) return { data: {}, error: { message: "Invalid login credentials" } };
          session = { user: { id: email, email }, access_token: "fake" };
          fire("SIGNED_IN");
          return { data: { session, user: session.user }, error: null };
        },
        signOut: async () => { session = null; fire("SIGNED_OUT"); return { error: null }; },
      },
      from: () => chain(),
    };
  }
`;

/** gotoFresh(), but with a real (fake) account config wired up — freshApp() itself always blocks
 * config.js, and a route registered after another for the same pattern wins, so that block would
 * shadow whatever we register here first. Must use gotoFresh(), not freshApp(). */
async function configuredApp(page){
  await page.route("**/config.js", route => route.fulfill({
    contentType: "application/javascript",
    body: `window.CASCADE_CONFIG = { SUPABASE_URL: "${FAKE_SUPABASE_URL}", SUPABASE_ANON_KEY: "${FAKE_ANON_KEY}" };`,
  }));
  await page.route("https://esm.sh/@supabase/supabase-js@2", route => route.fulfill({
    contentType: "application/javascript",
    body: FAKE_SUPABASE_MODULE,
  }));
  await gotoFresh(page);
  // 'signed-out' (not just .enabled) means the module got all the way through import(), createClient()
  // and the initial getSession() check, so the auth panels are already painted before we touch anything.
  await page.waitForFunction(() => window.CascadeAuth && window.CascadeAuth.status === "signed-out");
}

/** Open the auth modal from the splash's own "Log in" door — only valid before any sign-in, since a
 * successful sign-in navigates off the splash for good (afterSignIn() marks the app as onboarded). */
async function openAuth(page){
  await page.locator("#splashLogin").click();
  await expect(page.locator("#authModal")).toHaveClass(/open/);
}

/** A brand-new account has no Cascades, so afterSignIn() drops it straight into onboarding (same flow
 * a guest gets) instead of the listing — and the top menu (hence Account, hence signing out) only exists
 * on the listing. Drive the shortest real path through onboarding to get there, same as every other spec
 * that needs the listing (see cas345.spec.mjs's toListingWithAgent). */
async function toListingFromOnboarding(page){
  await expect(page.locator(".priobtn").first()).toBeVisible();
  await page.locator(".priobtn.cin").click();
  await expect(page.locator(".scard").first()).toBeVisible();
  const cards = await shortlistCards(page);
  await pickCard(page, cards[0].name);
  await finishFlow(page);
  await toListing(page);
}

/** Reopen the auth modal from the real top-menu Account row (CAS-345) — the only reachable entry point
 * once the splash is behind you. */
async function reopenAuth(page){
  await page.locator("#navMenuBtn").click();
  await page.locator("#navMenu .navitem", { hasText: "Account" }).click();
  await expect(page.locator("#accountScreen")).toHaveClass(/open/);
  await page.locator("#accountBody .urow", { hasText: /Signed in|Not signed in/ }).click();
  await expect(page.locator("#authModal")).toHaveClass(/open/);
}

function newEmail(){
  return `cas317-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
}

test("CAS-317: signed-out panel offers email + password, not the old magic-link copy", async ({ page }) => {
  await configuredApp(page);
  await openAuth(page);
  const panel = page.locator("#authSignedOut");
  await expect(panel).toBeVisible();
  await expect(panel.locator("#authEmail")).toBeVisible();
  await expect(panel.locator("#authPassword")).toBeVisible();
  await expect(panel.locator("#authLogin")).toBeVisible();
  await expect(panel.locator("#authSignup")).toBeVisible();
  await expect(panel).not.toContainText(/one-tap link/i);
});

test("CAS-317: a new made-up email + password signs in immediately, no confirmation step", async ({ page }) => {
  await configuredApp(page);
  await openAuth(page);
  const email = newEmail();
  await page.locator("#authEmail").fill(email);
  await page.locator("#authPassword").fill("correct-horse-1");
  await page.locator("#authSignup").click();
  // No email-confirmation step: the modal closes itself on SIGNED_IN, straight from the signup click.
  await expect(page.locator("#authModal")).not.toHaveClass(/open/);
  expect(await page.evaluate(() => window.CascadeAuth.status)).toBe("signed-in");
  expect(await page.evaluate(() => window.CascadeAuth.user?.email)).toBe(email);
});

test("CAS-317: signing out returns to guest, and logging back in with the same credentials works", async ({ page }) => {
  await configuredApp(page);
  await openAuth(page);
  const email = newEmail(), password = "correct-horse-2";
  await page.locator("#authEmail").fill(email);
  await page.locator("#authPassword").fill(password);
  await page.locator("#authSignup").click();
  await expect(page.locator("#authModal")).not.toHaveClass(/open/);
  await toListingFromOnboarding(page);

  await reopenAuth(page);
  await expect(page.locator("#authSignedIn")).toBeVisible();
  await page.locator("#authSignOut").click();
  expect(await page.evaluate(() => window.CascadeAuth.status)).toBe("signed-out");

  // authSignOut's own handler closes the modal (same as a successful sign-in does) — reopen for login.
  await reopenAuth(page);
  await expect(page.locator("#authSignedOut")).toBeVisible();
  await page.locator("#authEmail").fill(email);
  await page.locator("#authPassword").fill(password);
  await page.locator("#authLogin").click();
  await expect(page.locator("#authModal")).not.toHaveClass(/open/);
  expect(await page.evaluate(() => window.CascadeAuth.status)).toBe("signed-in");
});

test("CAS-317: two different made-up emails are two separate accounts", async ({ page }) => {
  await configuredApp(page);
  const emailA = newEmail(), emailB = newEmail();

  await openAuth(page);
  await page.locator("#authEmail").fill(emailA);
  await page.locator("#authPassword").fill("pw-account-a");
  await page.locator("#authSignup").click();
  await expect(page.locator("#authModal")).not.toHaveClass(/open/);
  expect(await page.evaluate(() => window.CascadeAuth.user?.email)).toBe(emailA);
  await toListingFromOnboarding(page);

  await reopenAuth(page);
  await page.locator("#authSignOut").click();

  // authSignOut's own handler closes the modal (same as a successful sign-in does) — reopen for signup B.
  await reopenAuth(page);
  await page.locator("#authEmail").fill(emailB);
  await page.locator("#authPassword").fill("pw-account-b");
  await page.locator("#authSignup").click();
  await expect(page.locator("#authModal")).not.toHaveClass(/open/);
  expect(await page.evaluate(() => window.CascadeAuth.user?.email)).toBe(emailB);
});

test("CAS-317: a wrong password is rejected with a message, and never signs in", async ({ page }) => {
  await configuredApp(page);
  const email = newEmail();
  await openAuth(page);
  await page.locator("#authEmail").fill(email);
  await page.locator("#authPassword").fill("the-real-password");
  await page.locator("#authSignup").click();
  await expect(page.locator("#authModal")).not.toHaveClass(/open/);
  await toListingFromOnboarding(page);
  await reopenAuth(page);
  await page.locator("#authSignOut").click();

  // authSignOut's own handler closes the modal (same as a successful sign-in does) — reopen to try again.
  await reopenAuth(page);
  await page.locator("#authEmail").fill(email);
  await page.locator("#authPassword").fill("not-the-real-password");
  await page.locator("#authLogin").click();
  await expect(page.locator("#authMsg")).toContainText(/could not sign in/i);
  await expect(page.locator("#authModal")).toHaveClass(/open/);
  expect(await page.evaluate(() => window.CascadeAuth.status)).toBe("signed-out");
});

test("CAS-317: guest mode still works when config is absent", async ({ page }) => {
  await freshApp(page);   // the blanket config.js block — no account config
  await page.waitForFunction(() => window.CascadeAuth && window.CascadeAuth.status === "guest");
  expect(await page.evaluate(() => window.CascadeAuth.enabled)).toBe(false);
  await openAuth(page);
  await expect(page.locator("#authGuest")).toBeVisible();
  await expect(page.locator("#authSignedOut")).not.toBeVisible();
});
