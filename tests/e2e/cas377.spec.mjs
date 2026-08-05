// CAS-377: the top-menu "My services" row used to open the older standalone Preferences modal (#prefs) —
// setup meter, green status tags, "Never alert me about" and "Experiment" sections and all. It now opens
// the same My-services step onboarding and the Briefing use (CAS-341 / CAS-343 / CAS-369), bare: just the
// title, Done button, the "Only show films on my services" toggle, and the provider chips.
import { test, expect } from "@playwright/test";
import { toShortlist, shortlistCards, pickCard, finishFlow, toListing, ctaLocator } from "./helpers.mjs";

async function toMenuServices(page){
  await toShortlist(page, "stream");
  const cards = await shortlistCards(page);
  await pickCard(page, cards[0].name);
  await finishFlow(page);
  await toListing(page);
  await page.locator("#navMenuBtn").click();
  await page.locator("#navMenu .navitem", { hasText: "My services" }).click();
}

test("CAS-377: My services opens the shared step, not the old modal", async ({ page }) => {
  await toMenuServices(page);
  await expect(page.locator("#onbStep")).toHaveClass(/open/);
  expect(await page.evaluate(() => onbStepKey)).toBe("services");
  await expect(page.locator("#prefs")).not.toHaveClass(/open/);
  await expect(page.locator("#onbStep .osh", { hasText: /My services/i })).toBeVisible();
});

test("CAS-377: no setup/progress step and no green status tags", async ({ page }) => {
  await toMenuServices(page);
  await expect(page.locator("#onbStep .osprog")).toHaveCount(0);
  await expect(page.locator("#onbStep .setup")).toHaveCount(0);
  await expect(page.locator("#onbStep .setupitem")).toHaveCount(0);
});

test("CAS-377: no \"Never alert me about\" section and no \"Experiment\" section", async ({ page }) => {
  await toMenuServices(page);
  await expect(page.locator("#onbStep", { hasText: /Never alert me about/i })).toHaveCount(0);
  await expect(page.locator("#onbStep", { hasText: /Experiment/i })).toHaveCount(0);
  await expect(page.locator("#onbStep #uxSwitch")).toHaveCount(0);
});

test("CAS-377: keeps the title, the Done button, and the \"Only show films on my services\" toggle", async ({ page }) => {
  await toMenuServices(page);
  await expect(page.locator("#onbStep .osh", { hasText: /My services/i })).toBeVisible();
  await expect(ctaLocator(page)).toHaveText(/Done/);
  await expect(page.locator("#onbSvcOnly")).toBeVisible();
});

test("CAS-377: streaming chips match the onboarding My-services page — alphabetised, Apple TV+ naming, +N more", async ({ page }) => {
  await toMenuServices(page);
  const names = await page.locator("#onbStepSvcs .chip.svc").allTextContents();
  expect(names).toContain("Apple TV+");
  expect(names).not.toContain("Apple TV");
  await page.locator("#onbStepSvcs .chip.svcmore").click();
  const withMore = await page.locator("#onbStepSvcs .chip.svc").allTextContents();
  const tail = withMore.slice(names.length);
  expect(tail.length).toBeGreaterThan(0);
  expect(tail).toEqual([...tail].sort((a, b) => a.localeCompare(b)));
});

test("CAS-377: toggling a service persists to prefs, same as before", async ({ page }) => {
  await toMenuServices(page);
  const netflix = page.locator("#onbStepSvcs .chip.svc", { hasText: "Netflix" });
  await expect(netflix).not.toHaveClass(/on/);
  await netflix.click();
  await expect(netflix).toHaveClass(/on/);
  expect(await page.evaluate(() => prefs.sub.has("Netflix"))).toBe(true);
  // Done still reads Done (not reverted to Continue) after a live repaint.
  await expect(ctaLocator(page)).toHaveText(/Done/);
});

test("CAS-377: Done closes the page and returns to the listing", async ({ page }) => {
  await toMenuServices(page);
  await ctaLocator(page).click();
  await expect(page.locator("#onbStep")).not.toHaveClass(/open/);
});
