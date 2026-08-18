// CAS-567: Watch List had two faults compared to Find's own header bar (.cascbar). First, #yourMovies's
// .uwrap carried the same calc(22px + env(safe-area-inset-top)) clearance written for .uscreens that cover
// the header at top:0 — but #yourMovies already sits below the header at top:var(--hdrh), so that padding
// double-counted the notch inset and left ~44px of dead space above the card. Second, .ymcard itself (a
// 354px rounded card inset 18px either side) was the sticky element, so film cards scrolled through the
// margin either side of it and the strip above it while it was pinned — .cascbar never has this problem
// because it is a full-bleed, opaque, edge-to-edge bar.
//
// The fix: #yourMovies .uwrap{padding-top:0} kills the double-counted inset, and a new opaque full-width
// wrapper (#ymSticky/.ymsticky) takes over position:sticky (and CAS-543's compositing-layer promotion)
// from .ymcard, which becomes a normal position:static card living inside it.
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

function openYourMovies(page){ return page.evaluate(() => window.openYourMovies()); }

/** Same included_streaming filter as cas540/cas543/cas544 — Watch it -> Stream only lands a film in the
 * Watch List while it currently occupies that window (watchIsCurrent()). */
async function firstCardIds(page, n){
  const ids = await page.evaluate(n => {
    const onScreen = Array.from(document.querySelectorAll("#groups .card")).map(el => Number(el.id.replace("card-", "")));
    return onScreen.filter(id => {
      const m = MOVIES.find(x => x.tmdb_id === id);
      return m && m.status.includes("included_streaming");
    }).slice(0, n);
  }, n);
  expect(ids.length).toBe(n);
  return ids;
}

async function tickWatchIt(page, id, wk){
  const chip = page.locator(`#card-${id} .ctl.notify`);
  if(!/(^| )open( |$)/.test(await chip.getAttribute("class") || "")) await chip.click();
  await page.locator(`#card-${id} .cpop.npop .nopt[data-wk="${wk}"]`).click();
}

async function scrollYourMovies(page, top){
  await page.evaluate(top => { document.getElementById("yourMovies").scrollTop = top; }, top);
}

test("CAS-567: the Watch List band sits within 4px of the header, like Find's .cascbar", async ({ page }) => {
  await toStreamListing(page);
  const ids = await firstCardIds(page, 1);
  await tickWatchIt(page, ids[0], "stream");
  await openYourMovies(page);

  // boundingBox() returns {x,y,width,height}, not top/bottom — derive both edges from y (+height for bottom).
  const headerBox = await page.locator("header").boundingBox();
  const bandBox = await page.locator("#ymSticky").boundingBox();
  const gap = bandBox.y - (headerBox.y + headerBox.height);
  expect(gap).toBeLessThanOrEqual(4);
  expect(gap).toBeGreaterThanOrEqual(0);
});

test("CAS-567: the band is a full-bleed, opaque, edge-to-edge wrapper — both expanded and collapsed", async ({ page }) => {
  await toStreamListing(page);
  const ids = await firstCardIds(page, 3);
  for(const id of ids) await tickWatchIt(page, id, "stream");
  await openYourMovies(page);

  const band = page.locator("#ymSticky");
  const viewport = page.viewportSize();

  const expandedBox = await band.boundingBox();
  expect(expandedBox.x).toBeCloseTo(0, 0);
  expect(expandedBox.width).toBeCloseTo(viewport.width, 0);
  const expandedBg = await band.evaluate(el => getComputedStyle(el).backgroundColor);
  expect(expandedBg).not.toBe("rgba(0, 0, 0, 0)");

  await scrollYourMovies(page, 300);
  await expect(band).toHaveClass(/collapsed/);
  const collapsedBox = await band.boundingBox();
  expect(collapsedBox.x).toBeCloseTo(0, 0);
  expect(collapsedBox.width).toBeCloseTo(viewport.width, 0);
  const collapsedBg = await band.evaluate(el => getComputedStyle(el).backgroundColor);
  expect(collapsedBg).not.toBe("rgba(0, 0, 0, 0)");

  // The card inside keeps its own inset shape — the fix moves full-bleed to the band, not the card.
  const cardBox = await page.locator("#ymcard").boundingBox();
  expect(cardBox.x).toBeGreaterThan(expandedBox.x);
});

test("CAS-567: the collapsed band's horizontal footprint fully covers the film list beneath it", async ({ page }) => {
  // The pre-fix bug wasn't that cards scrolled to a y-position behind the sticky element — that's normal,
  // scroll-behind-a-sticky-header behaviour, and z-index/paint order (untestable via geometry alone) is
  // what keeps it hidden. The actual, geometrically-checkable bug was .ymcard's own inset shape: an 18px
  // margin either side (and a 16px gap above) that the OLD sticky element itself didn't cover, so cards
  // scrolling underneath were visible IN that margin. The fix is that #ymSticky, unlike the old .ymcard,
  // spans the full scrollport width — so nothing the film list renders can fall outside it horizontally.
  await toStreamListing(page);
  const ids = await firstCardIds(page, 5);
  for(const id of ids) await tickWatchIt(page, id, "stream");
  await openYourMovies(page);

  await scrollYourMovies(page, 400);
  const band = page.locator("#ymSticky");
  await expect(band).toHaveClass(/collapsed/);
  const bandBox = await band.boundingBox();

  const cardBoxes = await page.locator("#ymCards .card").evaluateAll(
    els => els.map(el => { const r = el.getBoundingClientRect(); return { left: r.left, right: r.right }; })
  );
  expect(cardBoxes.length).toBeGreaterThan(0);
  for(const { left, right } of cardBoxes){
    expect(left).toBeGreaterThanOrEqual(bandBox.x - 1);
    expect(right).toBeLessThanOrEqual(bandBox.x + bandBox.width + 1);
  }
});

test("CAS-567: tapping the collapsed pill expands it; scrolling to the top re-expands with no stuck jump", async ({ page }) => {
  await toStreamListing(page);
  const ids = await firstCardIds(page, 2);
  for(const id of ids) await tickWatchIt(page, id, "stream");
  await openYourMovies(page);

  const band = page.locator("#ymSticky");
  const card = page.locator("#ymcard");

  await scrollYourMovies(page, 300);
  await expect(band).toHaveClass(/collapsed/);
  await expect(card).toHaveClass(/collapsed/);

  await card.click();
  await expect(band).not.toHaveClass(/collapsed/);
  await expect(card).not.toHaveClass(/collapsed/);
  await expect(card.locator(".ymcacts")).toBeVisible();

  await scrollYourMovies(page, 300);
  await expect(band).toHaveClass(/collapsed/);
  await scrollYourMovies(page, 0);
  await expect(band).not.toHaveClass(/collapsed/);
  await expect(card).not.toHaveClass(/collapsed/);

  const box = await band.boundingBox();
  expect(box.height).toBeGreaterThan(0);
});

test("CAS-567: #agentsScreen keeps its own .uwrap top padding — this ticket does not touch it", async ({ page }) => {
  await toStreamListing(page);
  await page.locator("#navMenuBtn").click();
  await page.locator("#navMenu .navitem", { hasText: "Manage Agents" }).click();
  await expect(page.locator("#agentsScreen.open")).toBeVisible();

  const padTop = await page.locator("#agentsScreen .uwrap").evaluate(el => getComputedStyle(el).paddingTop);
  // unchanged from the generic .uwrap rule — 22px plus whatever the harness's safe-area-inset-top resolves to.
  expect(parseFloat(padTop)).toBeGreaterThanOrEqual(22);
});
