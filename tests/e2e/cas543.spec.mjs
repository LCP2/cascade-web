// CAS-543 (Lee, live playtest, screenshots CAS-543-sg1/sg3): "when you swap to watch the top area
// disappears" — the Watch List header card (CAS-535) vanished entirely mid-session, leaving blank space
// above the first film card instead of either the full card or CAS-540's collapsed pill.
//
// Trigger, established by comparing CAS-540's own comment ("mirrors #cascbar's own mechanism") against
// what #cascbar actually needed: CAS-519's fix for #cascbar was two things — syncCascCollapse()'s JS
// (no-transition-on-live-scroll, a forced reflow) AND a CSS compositing-layer promotion on .cascbar itself
// (transform:translateZ(0)), because WebKit drops a position:sticky element's stuck position for the rest
// of a scroll gesture if the element changes size — exactly what .collapsed does — while that gesture
// crosses the sticky threshold. CAS-540 copied the JS half onto .ymcard/syncYmCollapse() but never copied
// the CSS half, so scrolling the Watch List past the collapse line on a real device could lose the card's
// pin: the browser still reserves its stuck-position space at the scrollport top (this is why the gap
// appears) while the card itself scrolls away, unpinned, in normal flow.
//
// This can't be driven from Chromium (the engine this suite runs under, CAS-552) — the loss only happens
// inside WebKit's own sticky-position implementation. This spec instead pins the two things that are
// checkable outside WebKit: the compositing-layer promotion is actually present on .ymcard (so a future
// edit can't silently drop it again), and the "never absent, no blank space" invariant holds across the
// full collapse/expand cycle a scroll gesture drives.
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

/** Same included_streaming filter as cas540.spec.mjs/cas544.spec.mjs — Watch it -> Stream only lands a
 * film in the Watch List while it currently occupies that window (watchIsCurrent()). */
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

/** Non-zero size and actually painted — the exact thing CAS-543 broke, whichever shape (full card or
 * CAS-540's pill) it should currently be in. */
async function assertCardPresent(page, card){
  await expect(card).toBeVisible();
  const box = await card.boundingBox();
  expect(box, "the Watch List header must never be absent — CAS-543").not.toBeNull();
  expect(box.height).toBeGreaterThan(0);
  expect(box.width).toBeGreaterThan(0);
}

test("CAS-543: .ymcard carries the same compositing-layer promotion CAS-519 gave .cascbar", async ({ page }) => {
  await toStreamListing(page);
  const ids = await firstCardIds(page, 1);
  await tickWatchIt(page, ids[0], "stream");
  await openYourMovies(page);

  const transform = await page.locator("#ymcard").evaluate(el => getComputedStyle(el).transform);
  // translateZ(0) computes to a 4x4 matrix3d, never the identity "none" — that's the whole point of the
  // promotion (it forces its own compositing layer). Assert it's actually a matrix, not merely non-empty.
  expect(transform).not.toBe("none");
  expect(transform.startsWith("matrix")).toBe(true);
});

test("CAS-543: the Watch List header is never absent through a full collapse/expand scroll cycle", async ({ page }) => {
  await toStreamListing(page);
  const ids = await firstCardIds(page, 3);
  for(const id of ids) await tickWatchIt(page, id, "stream");

  await openYourMovies(page);
  const card = page.locator("#ymcard");
  await assertCardPresent(page, card);
  await expect(card).not.toHaveClass(/collapsed/);

  // Cross the collapse threshold — the exact moment CAS-519's WebKit bug fires on a live gesture.
  await scrollYourMovies(page, 300);
  await expect(card).toHaveClass(/collapsed/);
  await assertCardPresent(page, card);

  // Scroll further while already collapsed — a second resize-adjacent point, not just the crossing itself.
  await scrollYourMovies(page, 500);
  await assertCardPresent(page, card);

  // Back to the top — must re-expand, not just reappear collapsed.
  await scrollYourMovies(page, 0);
  await expect(card).not.toHaveClass(/collapsed/);
  await assertCardPresent(page, card);
  await expect(card.locator(".ymcacts")).toBeVisible();
});
