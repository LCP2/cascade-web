// CAS-369: the "My streaming services" step's primary section is a fixed 10-provider set in a fixed
// order, not "whichever this catalogue happens to rank highest" — and the old "Apple TV" chip reads
// "Apple TV+" everywhere it appears. See tests/e2e/cas341.spec.mjs for the rental-section coverage and
// the general "tail stays alphabetical" behaviour this builds on.
import { test, expect } from "@playwright/test";
import { toShortlist, shortlistCards, pickCard } from "./helpers.mjs";

const PRIMARY = ["Amazon Prime Video", "Apple TV+", "BINGE", "Disney Plus", "Foxtel Now", "HBO Max",
  "Netflix", "Paramount Plus", "SBS On Demand", "Stan"];

async function toServices(page){
  await toShortlist(page, "stream");
  const cards = await shortlistCards(page);
  await pickCard(page, cards[0].name);
  await page.evaluate(() => window.gotoStep("services", "none"));
  await expect(page.locator(".osh", { hasText: /My services/i })).toBeVisible();
}

test("CAS-369: the streaming section always shows exactly the 10-provider primary set, in order", async ({ page }) => {
  await toServices(page);
  const names = await page.locator("#onbStepSvcs .chip.svc").allTextContents();
  expect(names).toEqual(PRIMARY);
});

test("CAS-369: the old \"Apple TV\" chip now reads \"Apple TV+\"", async ({ page }) => {
  await toServices(page);
  const names = await page.locator("#onbStepSvcs .chip.svc").allTextContents();
  expect(names).not.toContain("Apple TV");
  expect(names).toContain("Apple TV+");
});

test("CAS-369: \"+ more\" appends the rest alphabetically, without disturbing the primary set", async ({ page }) => {
  await toServices(page);
  await page.locator("#onbStepSvcs .chip.svcmore").click();
  const names = await page.locator("#onbStepSvcs .chip.svc").allTextContents();
  expect(names.slice(0, PRIMARY.length)).toEqual(PRIMARY);
  const tail = names.slice(PRIMARY.length);
  expect(tail.length).toBeGreaterThan(0);
  const sortedTail = [...tail].sort((a, b) => a.localeCompare(b));
  expect(tail).toEqual(sortedTail);
  tail.forEach(n => expect(PRIMARY).not.toContain(n));
});

test("CAS-369: selecting a primary chip still toggles the underlying preference", async ({ page }) => {
  await toServices(page);
  const netflix = page.locator("#onbStepSvcs .chip.svc", { hasText: "Netflix" });
  await expect(netflix).not.toHaveClass(/on/);
  await netflix.click();
  await expect(netflix).toHaveClass(/on/);
  expect(await page.evaluate(() => prefs.sub.has("Netflix"))).toBe(true);
});
