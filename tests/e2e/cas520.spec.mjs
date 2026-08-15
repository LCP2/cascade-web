// CAS-520: a returning signed-in device that hasn't heard back from its account fetch yet (cascadesReady
// false, CAS-517) used to leave the deck reading "All, then New Agent" with nothing to say more might be
// coming — indistinguishable from an account that genuinely has no other agents. The switcher itself was
// never gated on the catalogue (MOVIES ships baked in, deckBuild() only ever reads `cascades`), so AC1 was
// already true in spirit; what wasn't true is that the deck said anything honest about the wait. The fix:
// the last deck slot shows a "Loading your agents…" placeholder instead of "New Agent" while cascadesReady
// is false and no agents have arrived yet, and deckSync's rebuild signature now folds cascadesReady in so
// the swap back to "New Agent" fires even when the account resolves to a genuinely empty list (cascades.length
// stays 0 either side of that transition, so cascSig() alone never changes).
//
// Guest-mode/network-free (helpers.mjs) — the account fetch is faked via window.CascadeAuth + a direct
// window.CascadePersistence.loadAccount() call, same pattern as cas517.spec.mjs.
import { test, expect } from "@playwright/test";
import { freshApp } from "./helpers.mjs";

const FAKE_UID = "33333333-3333-4333-8333-333333333333";
const LOADING_TEXT = "Loading your agents…";

function fakeSignedIn({ uid, rows }){
  window.CascadeAuth = {
    enabled: true,
    session: { user: { id: uid } },
    client: { from(){ return { select: async () => ({ data: rows, error: null }) }; } },
  };
}

test("CAS-520: the deck shows a loading placeholder, not New Agent, while a returning device waits on its account fetch", async ({ page }) => {
  await freshApp(page);
  await page.evaluate(() => {
    localStorage.setItem("cascade_had_account", "1");
    localStorage.setItem("cascade_onboarded", "1");
  });

  await page.goto("/index.html");
  await page.waitForFunction(() => typeof flowStart === "function" && Array.isArray(MOVIES));

  // Cold: All is already there (never gated on the account or the catalogue) — the OTHER agents aren't,
  // and the deck says so instead of looking like there simply are none.
  expect(await page.evaluate(() => cascadesReady)).toBe(false);
  await expect(page.locator(".dcard.all")).toBeVisible();
  await expect(page.locator(".dcard.new")).toHaveCount(0);
  await expect(page.locator(".dcard.loading")).toBeVisible();
  await expect(page.getByText(LOADING_TEXT)).toBeVisible();
  // All itself is interactive immediately — nothing about the pending account fetch blocks it.
  expect(await page.evaluate(() => document.querySelector(".dcard.all").getAttribute("aria-label"))).toContain("All");

  // The account resolves with a real agent — the placeholder is swapped for the real card AND New Agent.
  const row = { id: "44444444-4444-4444-8444-444444444444", name: "Real Agent", criteria: {}, active: true };
  await page.evaluate(fakeSignedIn, { uid: FAKE_UID, rows: [row] });
  await page.evaluate(() => window.CascadePersistence.loadAccount());

  await expect(page.locator(".dcard.loading")).toHaveCount(0);
  await expect(page.getByText(LOADING_TEXT)).toHaveCount(0);
  await expect(page.locator(".dcard.new")).toBeVisible();
  await expect(page.getByText("Real Agent")).toBeVisible();
});

test("CAS-520: the placeholder also clears for a genuinely empty account (cascades.length stays 0 either side)", async ({ page }) => {
  await freshApp(page);
  await page.evaluate(() => {
    localStorage.setItem("cascade_had_account", "1");
    localStorage.setItem("cascade_onboarded", "1");
  });

  await page.goto("/index.html");
  await page.waitForFunction(() => typeof flowStart === "function" && Array.isArray(MOVIES));
  await expect(page.locator(".dcard.loading")).toBeVisible();

  await page.evaluate(fakeSignedIn, { uid: FAKE_UID, rows: [] });
  await page.evaluate(() => window.CascadePersistence.loadAccount());

  expect(await page.evaluate(() => cascades.length)).toBe(0);
  expect(await page.evaluate(() => cascadesReady)).toBe(true);
  await expect(page.locator(".dcard.loading")).toHaveCount(0);
  await expect(page.locator(".dcard.new")).toBeVisible();
});

test("CAS-520: a guest device with no account never shows the loading placeholder", async ({ page }) => {
  await freshApp(page);
  await page.evaluate(() => localStorage.setItem("cascade_onboarded", "1"));

  await page.goto("/index.html");
  await page.waitForFunction(() => typeof flowStart === "function" && Array.isArray(MOVIES));

  expect(await page.evaluate(() => cascadesReady)).toBe(true);
  await expect(page.locator(".dcard.loading")).toHaveCount(0);
  await expect(page.locator(".dcard.new")).toBeVisible();
});
