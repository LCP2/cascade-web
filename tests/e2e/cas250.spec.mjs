// CAS-250: How far back is a rolling window on a continuous, log-spaced track.
import { test, expect } from "@playwright/test";
import { toShortlist, shortlistCards, pickCard } from "./helpers.mjs";

async function toYearsStep(page){
  await toShortlist(page, "stream");
  const cards = await shortlistCards(page);
  await pickCard(page, cards[0].name);
  await page.evaluate(() => window.gotoStep("years", "none"));
  await expect(page.locator(".osh", { hasText: "How far back" })).toBeVisible();
}

test("CAS-250: the slider is continuous and lands between the printed marks", async ({ page }) => {
  await toYearsStep(page);
  const r = page.locator("#onbStepYears");
  await expect(r).toHaveAttribute("max", "100");
  await expect(r).toHaveAttribute("step", "1");

  // Every named window is reachable, including the ones with no printed label.
  const reach = await page.evaluate(() =>
    YEARS_NOTCHES.map(y => ({ y, ok: yearsForPos(posForYears(y)) === y })));
  for(const { y, ok } of reach) expect(ok, `${y} years is not landable`).toBe(true);

  // Drag to a value that is NOT a named mark, and it really filters there.
  await r.fill(String(await page.evaluate(() => Math.round(posForYears(17)))));
  await r.dispatchEvent("input");
  const at17 = await page.evaluate(() => ({ y: onbApply().yearsBack, n: onbCount() }));
  expect(at17.y).toBe(17);
  await expect(page.locator("#onbStepYearExplain")).toContainText(/last 17 years/i);

  // Tightening never admits more.
  await r.fill(String(await page.evaluate(() => Math.round(posForYears(2)))));
  await r.dispatchEvent("input");
  const at2 = await page.evaluate(() => ({ y: onbApply().yearsBack, n: onbCount() }));
  expect(at2.y).toBe(2);
  expect(at2.n).toBeLessThanOrEqual(at17.n);
});

test("CAS-250: the tightest window is the last twelve months, not the calendar year", async ({ page }) => {
  await toYearsStep(page);
  await page.locator(".rlabels .ysnap", { hasText: /^1$/ }).click();
  const state = await page.evaluate(() => ({
    y: onbApply().yearsBack, cut: yearsCutoff(1), today: TODAY,
    say: document.getElementById("onbStepYearExplain").textContent,
  }));
  expect(state.y).toBe(1);
  // Same day of the year, one year back — a rolling window, not 1 January.
  expect(state.cut.slice(5)).toBe(state.today.slice(5));
  expect(+state.cut.slice(0, 4)).toBe(+state.today.slice(0, 4) - 1);
  expect(state.say).toMatch(/last twelve months/i);
  await expect(page.locator("#onbStepSay")).toContainText(/last 1 year/i);
});

test("CAS-250: the notches are log-spaced, so the short windows get the room", async ({ page }) => {
  await toYearsStep(page);
  const lefts = await page.locator(".rstops.logstops i").evaluateAll(els =>
    els.map(e => parseFloat(e.style.left)));
  expect(lefts.length).toBeGreaterThan(5);
  for(let i = 1; i < lefts.length; i++) expect(lefts[i]).toBeGreaterThan(lefts[i - 1]);
  // 1→3 must take more of the track than 25→50.
  const span = await page.evaluate(() => ({
    short: posForYears(3) - posForYears(1), long: posForYears(50) - posForYears(25),
  }));
  expect(span.short).toBeGreaterThan(span.long);
});
