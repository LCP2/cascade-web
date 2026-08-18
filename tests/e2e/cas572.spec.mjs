// CAS-572: the Watch List card's Filter button (#ymFilterBtn) rendered blank. ICON.filter is a bare <svg>
// with only a viewBox — every other consumer sizes it in CSS (.dc-filter svg, .ag-learn svg, etc). CAS-535
// reused the icon here on a plain `.ca-btn x` button, which had no such rule, so the svg fell back to
// width:auto on a replaced element with no intrinsic size and computed to 0×0. Fix: a `.ymcacts .ca-btn svg`
// rule scoped to the Watch List's own control row, matching `.dc-filter svg`'s 14px exactly.
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

async function firstCardId(page){
  const id = await page.evaluate(() => {
    const el = document.querySelector("#groups .card");
    return el ? Number(el.id.replace("card-", "")) : null;
  });
  expect(id).not.toBeNull();
  return id;
}

async function tickWatchIt(page, id, wk){
  const chip = page.locator(`#card-${id} .ctl.notify`);
  if(!/(^| )open( |$)/.test(await chip.getAttribute("class") || "")) await chip.click();
  await page.locator(`#card-${id} .cpop.npop .nopt[data-wk="${wk}"]`).click();
}

test("CAS-572: the Watch List card's filter icon renders at the deck's own 14px size, not 0×0", async ({ page }) => {
  await toStreamListing(page);

  // html{zoom:var(--ui-scale)} (1.12) inflates boundingBox() past the authored CSS size in this harness,
  // so size ACs assert getComputedStyle() — the literal px value the CSS rule sets — not boundingBox().
  const sizeOf = sel => page.locator(sel).first().evaluate(el => {
    const cs = getComputedStyle(el);
    return { width: parseFloat(cs.width), height: parseFloat(cs.height) };
  });

  // Measure the deck's own filter icon first, on the same screen toListing() already landed on.
  const deckSvgSize = await sizeOf(".dc-filter svg");
  expect(deckSvgSize.width).toBeCloseTo(14, 0);
  expect(deckSvgSize.height).toBeCloseTo(14, 0);

  const id = await firstCardId(page);
  await tickWatchIt(page, id, "stream");
  await page.evaluate(() => window.openYourMovies());

  const ymSvg = page.locator("#ymFilterBtn svg");
  await expect(ymSvg).toBeVisible();
  const ymSvgSize = await sizeOf("#ymFilterBtn svg");
  expect(ymSvgSize.width).toBeCloseTo(14, 0);
  expect(ymSvgSize.height).toBeCloseTo(14, 0);

  // Matches the deck's own copy of the same control in both dimensions.
  expect(ymSvgSize.width).toBeCloseTo(deckSvgSize.width, 0);
  expect(ymSvgSize.height).toBeCloseTo(deckSvgSize.height, 0);
});

test("CAS-572: nothing else sharing an icon changed size — agent Learning chip and Manage Agents' Edit", async ({ page }) => {
  await toStreamListing(page);
  await page.locator("#navMenuBtn").click();
  await page.locator("#navMenu .navitem", { hasText: "Manage Agents" }).click();
  await expect(page.locator("#agentsScreen.open")).toBeVisible();

  const learnSvgSize = await page.locator(".ag-learn svg").first().evaluate(el => {
    const cs = getComputedStyle(el);
    return { width: parseFloat(cs.width), height: parseFloat(cs.height) };
  });
  expect(learnSvgSize.width).toBeCloseTo(12, 0);
  expect(learnSvgSize.height).toBeCloseTo(12, 0);

  // .ag-edit ("Edit") carries no <svg> at all — confirm the fix didn't introduce one, and that the button
  // still reads as plain text.
  const editSvgCount = await page.locator(".ag-edit svg").count();
  expect(editSvgCount).toBe(0);
  await expect(page.locator(".ag-edit").first()).toHaveText("Edit");
});

test("CAS-572: the filter button's existing behaviour — opening the watch-priority popover — is unchanged", async ({ page }) => {
  await toStreamListing(page);
  const id = await firstCardId(page);
  await tickWatchIt(page, id, "stream");
  await page.evaluate(() => window.openYourMovies());

  const btn = page.locator("#ymFilterBtn");
  await expect(btn).toHaveAttribute("aria-expanded", "false");
  await btn.click();
  await expect(btn).toHaveAttribute("aria-expanded", "true");
  await expect(page.locator(".cpop.ymfpop")).toBeVisible();

  await btn.click();
  await expect(btn).toHaveAttribute("aria-expanded", "false");
  await expect(page.locator(".cpop.ymfpop")).toHaveCount(0);
});
