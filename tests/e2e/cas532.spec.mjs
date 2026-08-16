// CAS-532: new top-level Preferences page — Language (moved from the retired Taste Baseline) and Where &
// when you'll watch (rebuilt from the Cinema agent's old per-agent screen, List/Follow renamed Track/Alert)
// are now the ONE place both are set, for every agent, no per-agent override. Genre/How far back/Age rating
// drop out of the app entirely — a new agent gets fixed system defaults (all genres, last 20 years, M and
// up) instead. The Account submenu loses its "Taste baseline" and "My streaming services" rows.
import { test, expect } from "@playwright/test";
import { toShortlist, pickCard, finishFlow, toListing } from "./helpers.mjs";

async function openPreferences(page){
  await page.locator("#navMenuBtn").click();
  await page.locator("#navMenu .navitem", { hasText: "Preferences" }).click();
  await expect(page.locator("#preferencesScreen")).toHaveClass(/open/);
}

async function buildAgent(page, kind, presetName){
  await toShortlist(page, kind);
  await pickCard(page, presetName);
  await finishFlow(page);
  await toListing(page);
}

test("CAS-532: Preferences sits in the top menu between Service analysis and Lists", async ({ page }) => {
  await buildAgent(page, "cinema", "Blockbusters");
  await page.locator("#navMenuBtn").click();
  const labels = await page.locator("#navMenu .navitem").allTextContents();
  const svcIdx = labels.findIndex(t => t.includes("Service analysis"));
  const prefIdx = labels.findIndex(t => t.includes("Preferences"));
  const listsIdx = labels.findIndex(t => t.includes("Lists"));
  expect(svcIdx).toBeGreaterThanOrEqual(0);
  expect(prefIdx).toBe(svcIdx + 1);
  expect(listsIdx).toBe(prefIdx + 1);

  await page.locator("#navMenu .navitem", { hasText: "Preferences" }).click();
  await expect(page.locator("#navMenu")).not.toHaveClass(/open/);
  await expect(page.locator("#preferencesScreen")).toHaveClass(/open/);
  await expect(page.locator("#preferencesScreen .osh")).toHaveText("Preferences");
});

test("CAS-532: Language reuses the account chip picker — English on by default, a tap persists", async ({ page }) => {
  await buildAgent(page, "cinema", "Blockbusters");
  await openPreferences(page);

  const chips = page.locator("#preferencesScreen .chip");
  const english = chips.filter({ hasText: "English" });
  const french = chips.filter({ hasText: "French" });
  await expect(english).toHaveClass(/on/);
  await expect(french).not.toHaveClass(/on/);

  await french.click();
  await expect(french).toHaveClass(/on/);
  await expect(page.evaluate(() => tasteBase.langs)).resolves.toContain("fr");

  // Persists across a close/reopen — it is real account-level state, not screen-local.
  await page.locator("#preferencesScreen .osback").click();
  await expect(page.locator("#preferencesScreen")).not.toHaveClass(/open/);
  await openPreferences(page);
  await expect(page.locator("#preferencesScreen .chip", { hasText: "French" })).toHaveClass(/on/);
});

test("CAS-532: Where & when shows all five windows with Track/Alert, never the old List/Follow", async ({ page }) => {
  await buildAgent(page, "cinema", "Blockbusters");
  await openPreferences(page);

  const lanes = page.locator("#preferencesScreen .wwlane");
  await expect(lanes).toHaveCount(5);
  const names = await lanes.locator(".wwn").allTextContents();
  expect(names).toEqual(["Upcoming", "In cinema", "Premium", "Standard Rent", "Streaming"]);

  // Every lane carries both switches now — the old cinema-only notifyOnly restriction (Alert with no Track)
  // is gone from this global screen.
  for(let i = 0; i < 5; i++){
    await expect(lanes.nth(i).locator(".agwt")).toHaveCount(2);
  }
  const bodyText = await page.locator("#preferencesScreen").textContent();
  expect(bodyText).toContain("Track");
  expect(bodyText).toContain("Alert");
  expect(bodyText).not.toMatch(/\bList\b/);
  expect(bodyText).not.toMatch(/\bFollow\b/);
});

test("CAS-532: turning off a window here re-scopes an agent that already exists — no per-agent screen does it", async ({ page }) => {
  await buildAgent(page, "cinema", "Blockbusters");

  const before = await page.evaluate(() => cascades[0].status);
  expect(before).toContain("in_cinema");

  await openPreferences(page);
  const inCinema = page.locator("#preferencesScreen .wwlane", { has: page.locator(".wwn", { hasText: "In cinema" }) });
  await inCinema.locator(".agwt", { hasText: "Track" }).click();

  const after = await page.evaluate(() => cascades[0].status);
  expect(after).not.toContain("in_cinema");
  expect(after).toContain("upcoming");   // untouched window keeps its own state
});

test("CAS-532: a new cinema agent gets the fixed system defaults, with no Genre/Rating/How-far-back UI anywhere", async ({ page }) => {
  await buildAgent(page, "cinema", "Blockbusters");

  const c = await page.evaluate(() => cascades[0]);
  expect(c.genre).toEqual([]);                       // all genres
  expect(c.age).toEqual(["M", "MA 15+", "R 18+"]);    // M and up (Blockbusters leaves age open)
  expect(c.yearsBack).toBe(20);

  await page.locator("#agentsBtn").click();
  await page.locator(".agrow .ag-edit").first().click();
  await expect(page.locator(".osh.eahn")).toBeVisible();
  await expect(page.locator(".eacard.sty")).toHaveCount(0);
  await expect(page.locator(".easec")).toHaveCount(0);
  await expect(page.locator(".eaptr")).toContainText("Where & when you'll watch now lives in Preferences");
  await expect(page.locator(".eaptr")).toContainText("So does Language");
});

test("CAS-532: Account's Taste baseline and My streaming services rows are gone; My Services stays", async ({ page }) => {
  await buildAgent(page, "cinema", "Blockbusters");
  await page.locator("#navMenuBtn").click();
  await page.locator("#navMenu .navitem", { hasText: "Account" }).click();
  await expect(page.locator("#accountScreen")).toHaveClass(/open/);

  const body = await page.locator("#accountScreen").textContent();
  expect(body).not.toContain("Taste baseline");
  expect(body).not.toContain("My streaming services");

  await page.locator("#accountScreen .osback").click();
  await page.locator("#navMenuBtn").click();
  await expect(page.locator("#navMenu .navitem", { hasText: "My services" })).toBeVisible();
});
