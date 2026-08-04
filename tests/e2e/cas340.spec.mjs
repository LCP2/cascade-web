// CAS-340: the streaming "How far back" slider redesigned non-linear — ten fixed stops (Any, 50, 25, 15,
// 10, 5, 4, 3, 2, 1) laid out furthest-back-left to most-recent-right, with the recent end noticeably wider
// than the compressed older end, a single "From <Mon YYYY>" readout in place of the old explanatory
// paragraph, and a 10-year default for new streaming agents.
import { test, expect } from "@playwright/test";
import { toShortlist, shortlistCards, pickCard, ctaLocator } from "./helpers.mjs";

async function toYearsStep(page){
  await toShortlist(page, "stream");
  const cards = await shortlistCards(page);
  await pickCard(page, cards[0].name);
  // Mission -> Name -> Style -> Ratings -> How far back
  for(let i = 0; i < 4; i++){
    await ctaLocator(page).click();
    await page.waitForTimeout(120);
  }
  await expect(page.locator(".osh", { hasText: "How far back?" })).toBeVisible();
}

test("CAS-340: a new streaming agent opens the slider on 10 years, not Any", async ({ page }) => {
  await toYearsStep(page);
  expect(await page.evaluate(() => onbFlow.draft.yearsBack)).toBe(10);
});

test("CAS-340: the slider shows exactly ten markers, furthest-back on the left and most recent on the right", async ({ page }) => {
  await toYearsStep(page);
  const labels = await page.locator("#onbStepYearLabels .ysnap").allTextContents();
  expect(labels).toEqual(["Any", "50", "25", "15", "10", "5", "4", "3", "2", "1"]);
  const dots = await page.locator(".rstops.logstops i").count();
  expect(dots).toBe(10);
});

test("CAS-340: recent years get noticeably more width than the compressed older end", async ({ page }) => {
  await toYearsStep(page);
  const lefts = await page.locator("#onbStepYearLabels .ysnap").evaluateAll(els =>
    els.map(el => parseFloat(el.style.left)));
  // 50->25->15: the tightly-bunched numeric cluster. (Any->50 is deliberately a little wider than this
  // cluster, so "Any"'s flush-left label has room to sit without fighting "50" for the same tap target.)
  const olderGaps = [lefts[2] - lefts[1], lefts[3] - lefts[2]];
  const recentGaps = [lefts[6] - lefts[5], lefts[7] - lefts[6], lefts[8] - lefts[7], lefts[9] - lefts[8]]; // 5->4->3->2->1
  const avg = arr => arr.reduce((a, b) => a + b, 0) / arr.length;
  expect(avg(recentGaps)).toBeGreaterThan(avg(olderGaps) * 2);
});

test("CAS-340: moving the handle updates a single \"From <Mon YYYY>\" readout, and nothing else", async ({ page }) => {
  await toYearsStep(page);
  await page.locator("#onbStepYearLabels .ysnap", { hasText: "3" }).click();
  const text = (await page.locator("#onbStepYearExplain").textContent()).trim();
  expect(text).toMatch(/^From [A-Z][a-z]{2} \d{4}$/);
  expect(await page.evaluate(() => onbFlow.draft.yearsBack)).toBe(3);
});

test("CAS-340: picking \"Any\" reads as \"All years\", not a fabricated date", async ({ page }) => {
  await toYearsStep(page);
  await page.locator("#onbStepYearLabels .ysnap", { hasText: "Any" }).click();
  expect((await page.locator("#onbStepYearExplain").textContent()).trim()).toBe("All years");
});
