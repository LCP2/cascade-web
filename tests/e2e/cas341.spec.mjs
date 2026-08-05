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

// CAS-369 fixed the streaming lead row to a specific 10-provider primary set (HBO Max included), so
// HBO Max no longer needs the "more" tail to be reached — see tests/e2e/cas369.spec.mjs for that
// coverage, and for the tail-stays-alphabetical assertion the "more" click used to prove here.

test("CAS-341: the rental lead row is alphabetical", async ({ page }) => {
  await toServices(page);
  const names = await page.locator("#onbStepStores .chip.svc").allTextContents();
  const sorted = [...names].sort((a, b) => a.localeCompare(b));
  expect(names).toEqual(sorted);
});
