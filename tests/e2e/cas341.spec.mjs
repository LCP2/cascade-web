// CAS-341: onboarding "My services" — HBO (Max) is a selectable service, and both the lead row and the
// "more" tail are alphabetical, so a name is where you'd look for it instead of buried by catalogue rank.
import { test, expect } from "@playwright/test";
import { toShortlist, shortlistCards, pickCard } from "./helpers.mjs";

async function toServices(page){
  await toShortlist(page, "stream");
  const cards = await shortlistCards(page);
  await pickCard(page, cards[0].name);
  await page.evaluate(() => window.gotoStep("services", "none"));
  await expect(page.locator(".osh", { hasText: /My services/i })).toBeVisible();
}

test("CAS-341: the streaming lead row is alphabetical", async ({ page }) => {
  await toServices(page);
  const names = await page.locator("#onbStepSvcs .chip.svc").allTextContents();
  const sorted = [...names].sort((a, b) => a.localeCompare(b));
  expect(names).toEqual(sorted);
});

test("CAS-341: the streaming \"more\" tail is alphabetical too, and HBO Max is in it", async ({ page }) => {
  await toServices(page);
  await page.locator("#onbStepSvcs .chip.svcmore").click();
  const names = await page.locator("#onbStepSvcs .chip.svc").allTextContents();
  const sorted = [...names].sort((a, b) => a.localeCompare(b));
  expect(names).toEqual(sorted);
  expect(names).toContain("HBO Max");
});

test("CAS-341: the rental lead row is alphabetical", async ({ page }) => {
  await toServices(page);
  const names = await page.locator("#onbStepStores .chip.svc").allTextContents();
  const sorted = [...names].sort((a, b) => a.localeCompare(b));
  expect(names).toEqual(sorted);
});
