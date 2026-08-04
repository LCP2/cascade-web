// CAS-343: the Edit Agent / New Cascade "Streaming services" row used to hand off to the older standalone
// Preferences modal. It now opens the same My-services step onboarding uses, so behaviour and styling match.
import { test, expect } from "@playwright/test";
import { toShortlist, shortlistCards, pickCard, finishFlow, toListing, ctaLocator } from "./helpers.mjs";

async function toEditServices(page){
  await toShortlist(page, "stream");
  const cards = await shortlistCards(page);
  await pickCard(page, cards[0].name);
  await finishFlow(page);
  await toListing(page);
  await page.evaluate(() => window.editCascade());
  await page.locator("#onbStepInner .osdoor", { hasText: "Streaming services" }).click();
}

test("CAS-343: the Streaming services row opens the shared My services step, not the old modal", async ({ page }) => {
  await toEditServices(page);
  expect(await page.evaluate(() => onbStepKey)).toBe("services");
  await expect(page.locator(".osh", { hasText: /My services/i })).toBeVisible();
  await expect(page.locator("#prefs")).not.toHaveClass(/open/);
});

test("CAS-343: reached from the Briefing hub, the chips are still alphabetised", async ({ page }) => {
  await toEditServices(page);
  const names = await page.locator("#onbStepSvcs .chip.svc").allTextContents();
  const sorted = [...names].sort((a, b) => a.localeCompare(b));
  expect(names).toEqual(sorted);
});

test("CAS-343: Done on the services spoke returns to the Briefing hub", async ({ page }) => {
  await toEditServices(page);
  await ctaLocator(page).click();
  expect(await page.evaluate(() => onbStepKey)).toBe("briefing");
  await expect(page.locator("#onbStepInner .osdoor").first()).toBeVisible();
});
