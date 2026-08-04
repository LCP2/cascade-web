// CAS-250: How far back is a ROLLING window — "last N years" means N years behind today, not the calendar
// year. (Its continuous, log-spaced track was redesigned into ten fixed, non-linear stops by CAS-340; see
// tests/e2e/cas340.spec.mjs for the current track/spacing/direction/readout assertions.)
import { test, expect } from "@playwright/test";
import { toShortlist, shortlistCards, pickCard } from "./helpers.mjs";

async function toYearsStep(page){
  await toShortlist(page, "stream");
  const cards = await shortlistCards(page);
  await pickCard(page, cards[0].name);
  await page.evaluate(() => window.gotoStep("years", "none"));
  await expect(page.locator(".osh", { hasText: "How far back" })).toBeVisible();
}

test("CAS-250: tightening the window never admits more films", async ({ page }) => {
  await toYearsStep(page);
  await page.locator(".rlabels .ysnap", { hasText: /^10$/ }).click();
  const at10 = await page.evaluate(() => ({ y: onbApply().yearsBack, n: onbCount() }));
  expect(at10.y).toBe(10);
  await page.locator(".rlabels .ysnap", { hasText: /^2$/ }).click();
  const at2 = await page.evaluate(() => ({ y: onbApply().yearsBack, n: onbCount() }));
  expect(at2.y).toBe(2);
  expect(at2.n).toBeLessThanOrEqual(at10.n);
});

test("CAS-250: the tightest window is the last twelve months, not the calendar year", async ({ page }) => {
  await toYearsStep(page);
  await page.locator(".rlabels .ysnap", { hasText: /^1$/ }).click();
  const state = await page.evaluate(() => ({
    y: onbApply().yearsBack, cut: yearsCutoff(1), today: TODAY,
  }));
  expect(state.y).toBe(1);
  // Same day of the year, one year back — a rolling window, not 1 January.
  expect(state.cut.slice(5)).toBe(state.today.slice(5));
  expect(+state.cut.slice(0, 4)).toBe(+state.today.slice(0, 4) - 1);
  await expect(page.locator("#onbStepSay")).toContainText(/last 1 year/i);
});
