// CAS-344: the "Which service covers what your agents found" coverage view gets its own Service analysis
// page, reached from a header icon (its permanent home is the CAS-345 top menu once that ships), and is no
// longer duplicated inside the My streaming services modal.
import { test, expect } from "@playwright/test";
import { toShortlist, shortlistCards, pickCard, finishFlow, toListing } from "./helpers.mjs";

async function toListingWithAgent(page){
  await toShortlist(page, "stream");
  const cards = await shortlistCards(page);
  await pickCard(page, cards[0].name);
  await finishFlow(page);
  await toListing(page);
}

test("CAS-344: the header icon opens the Service analysis page", async ({ page }) => {
  await toListingWithAgent(page);
  await expect(page.locator("#svcAnalysis")).not.toHaveClass(/open/);
  await page.locator("#svcAnalysisBtn").click();
  await expect(page.locator("#svcAnalysis")).toHaveClass(/open/);
  await expect(page.locator("#svcAnalysis .osh", { hasText: "Service analysis" })).toBeVisible();
});

test("CAS-344: the coverage rows are ordered by coverage descending and match the real data", async ({ page }) => {
  await toListingWithAgent(page);
  await page.locator("#svcAnalysisBtn").click();
  const ranked = await page.evaluate(() => serviceAdvice().ranked);
  const rows = page.locator("#svcAnalysis .adv");
  await expect(rows).toHaveCount(ranked.length);
  if(ranked.length){
    const counts = ranked.map(e => e.films.length);
    const sorted = [...counts].sort((a, b) => b - a);
    expect(counts).toEqual(sorted);
    // First row carries the leader marker; the coverage footnote about real AU offer data is present.
    await expect(rows.first().locator(".advsvc")).toContainText("🥇");
    await expect(page.locator("#svcAnalysis .advfoot")).toContainText("real AU offer data");
  }
});

test("CAS-344: back returns to the listing, and the coverage block is gone from My streaming services", async ({ page }) => {
  await toListingWithAgent(page);
  await page.locator("#svcAnalysisBtn").click();
  await expect(page.locator("#svcAnalysis")).toHaveClass(/open/);
  await page.locator("#svcAnalysis .osback").click();
  await expect(page.locator("#svcAnalysis")).not.toHaveClass(/open/);

  await page.evaluate(() => window.openPrefs());
  await expect(page.locator("#prefs")).toHaveClass(/open/);
  await expect(page.locator("#prefs #svcAdvice")).toHaveCount(0);
  await expect(page.locator("#prefs", { hasText: "Which service covers" })).toHaveCount(0);
});
