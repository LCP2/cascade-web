// CAS-517: "Put your first Cascade to work" (cascadeStartHTML, gated by `cascades.length`) used to treat
// an empty `cascades` array as proof the account has zero Cascades. That's true for a guest device — the
// local cache IS the truth — but false for a signed-in device whose CAS-516 cold-start cache hasn't been
// populated yet: `cascades` reads empty for the same reason it always did before CAS-516 existed, not
// because the account is actually empty. The card flashed for a returning member with an established
// account, on the exact device/scenario CAS-516 was built to speed up.
//
// The fix: `cascadesReady` (true immediately for a guest device; false for a device this session's LAST
// boot knew was signed in — via the "cascade_had_account" marker — until loadAccount()/reconcileCascades()
// or the guest fallback actually confirms the list). cascadeStartHTML() stays silent while it's false.
//
// Guest-mode/network-free (helpers.mjs) — the account fetch itself is faked via window.CascadeAuth, same
// pattern as cas516.spec.mjs.
import { test, expect } from "@playwright/test";
import { freshApp } from "./helpers.mjs";

const FAKE_UID = "11111111-1111-4111-8111-111111111111";
const CARD_TEXT = "Put your first Cascade to work";

function fakeSignedInEmpty({ uid }){
  window.CascadeAuth = {
    enabled: true,
    session: { user: { id: uid } },
    client: { from(){ return { select: async () => ({ data: [], error: null }) }; } },
  };
}

test("CAS-517: a returning signed-in device stays silent before loadAccount() confirms the list, even if it reads empty", async ({ page }) => {
  await freshApp(page);
  // Same device shape CAS-516 targets: last session was signed in (so this boot owes an account fetch
  // before `cascades.length` can be trusted) but the cold-start cache hasn't been seeded with anything yet.
  await page.evaluate(() => {
    localStorage.setItem("cascade_had_account", "1");
    localStorage.setItem("cascade_onboarded", "1");
  });

  // Raw reload, not freshApp()/gotoFresh() — both clear storage, which would erase the markers just set.
  await page.goto("/index.html");
  await page.waitForFunction(() => typeof flowStart === "function" && Array.isArray(MOVIES));

  await expect(page.locator("#splash")).not.toHaveClass(/open/);
  expect(await page.evaluate(() => cascades.length)).toBe(0);
  expect(await page.evaluate(() => cascadesReady)).toBe(false);
  await expect(page.locator(".cascstart")).toHaveCount(0);
  await expect(page.getByText(CARD_TEXT)).toHaveCount(0);

  // Once the account fetch actually confirms zero Cascades, the same device may show the card — it's a
  // genuinely empty account now, not an unresolved read.
  await page.evaluate(fakeSignedInEmpty, { uid: FAKE_UID });
  await page.evaluate(() => window.CascadePersistence.loadAccount());
  expect(await page.evaluate(() => cascadesReady)).toBe(true);
  await expect(page.locator(".cascstart")).toBeVisible();
  await expect(page.getByText(CARD_TEXT)).toBeVisible();
});

test("CAS-517: a guest device with zero Cascades shows the starter card immediately, no loading gate", async ({ page }) => {
  await freshApp(page);
  await page.evaluate(() => localStorage.setItem("cascade_onboarded", "1"));

  await page.goto("/index.html");
  await page.waitForFunction(() => typeof flowStart === "function" && Array.isArray(MOVIES));

  await expect(page.locator("#splash")).not.toHaveClass(/open/);
  expect(await page.evaluate(() => cascades.length)).toBe(0);
  expect(await page.evaluate(() => cascadesReady)).toBe(true);
  await expect(page.locator(".cascstart")).toBeVisible();
  await expect(page.getByText(CARD_TEXT)).toBeVisible();
});

test("CAS-517: a returning device with cached Cascades never shows the starter card, loaded or not", async ({ page }) => {
  await freshApp(page);
  const row = { id: "22222222-2222-4222-8222-222222222222", name: "Established Agent", criteria: {}, active: true };
  await page.evaluate((r) => {
    localStorage.setItem("cascade_cascades", JSON.stringify([r]));
    localStorage.setItem("cascade_had_account", "1");
    localStorage.setItem("cascade_onboarded", "1");
  }, row);

  await page.goto("/index.html");
  await page.waitForFunction(() => typeof flowStart === "function" && Array.isArray(MOVIES));

  await expect(page.locator("#splash")).not.toHaveClass(/open/);
  expect(await page.evaluate(() => cascades.length)).toBe(1);
  await expect(page.locator(".cascstart")).toHaveCount(0);
  await expect(page.getByText(CARD_TEXT)).toHaveCount(0);
});
