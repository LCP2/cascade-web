// CAS-610: CAS-467 relabelled the per-film control (and its scope pill / two filter-panel headings) from
// "Notify" to "Watch it" for display only. This ticket reverses that display decision back to "Notify" at
// all four sites — notifyChipHTML's chip label, the Find scope bar's "watch" pill, and both filter panels'
// ".npthd" headings (the deck's own funnel, filterPanelRowsHTML, and Your Movies' own funnel,
// ymFilterRowsHTML). No underlying identifier, class, id, or storage key changes.
import { test, expect } from "@playwright/test";
import { toShortlist, shortlistCards, pickCard, finishFlow, toListing, settleListing } from "./helpers.mjs";

async function toStreamListing(page){
  await toShortlist(page, "stream");
  const cards = await shortlistCards(page);
  await pickCard(page, cards[0].name);
  await finishFlow(page);
  await toListing(page);
  await settleListing(page);
}

test("CAS-610: the scope pill and the per-film chip both read Notify, not Watch it", async ({ page }) => {
  await toStreamListing(page);

  // The Find scope bar's "watch" pill.
  const scopeBtn = page.locator('#scopeBar .scopebtn', { has: page.locator('.sccar[data-scope="watch"]') });
  await expect(scopeBtn.locator(".scn")).toHaveText("Notify");

  // The per-film chip's own label (notifyChipHTML).
  const card = page.locator("#groups .card").first();
  await expect(card).toBeVisible();
  const chip = card.locator(".ctl.notify");
  await expect(chip).toContainText("Notify");
  await expect(chip).not.toContainText("Watch it");
});

// filterPanelRowsHTML() backs the deck's own per-agent Filter popup — CAS-586 already retired the .dc-filter
// button that used to open it from the deck card (replaced by the scope bar above), so the function is
// exercised directly rather than through a since-removed click path.
test("CAS-610: the deck's own filter panel (filterPanelRowsHTML) reads Notify", async ({ page }) => {
  await toStreamListing(page);
  const heading = await page.evaluate(() => {
    const div = document.createElement("div");
    div.innerHTML = filterPanelRowsHTML();
    return div.querySelector(".npthd").textContent;
  });
  expect(heading).toBe("Notify");
});

test("CAS-610: Your Movies' own filter panel (ymFilterRowsHTML) also reads Notify", async ({ page }) => {
  await toStreamListing(page);
  await page.evaluate(() => window.openYourMovies());
  await expect(page.locator("#yourMovies")).toBeVisible();

  const filterBtn = page.locator("#wlStrip .dcard.is-active .dc-filter");
  await filterBtn.click();
  const pop = page.locator(".cpop.ymfpop");
  await expect(pop).toBeVisible();
  await expect(pop.locator(".npthd")).toHaveText("Notify");
});
