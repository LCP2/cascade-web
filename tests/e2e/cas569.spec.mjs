// CAS-569: a Watched (or Never) verdict given ON the Watch List used to save and filter correctly in the
// model (ymFeedList dropped the film) while #yourMovies kept showing the card and its stale count — the film
// only actually left on the next full render, i.e. reopening the screen. repaintAfterOpinion() now branches to
// ymRefreshFeed() (the same partial update the search field already uses) whenever #yourMovies is open, instead
// of falling through to Find's fastPatchFindRow()/render(). Asserted by DOM count throughout, per the ticket's
// own AC8 — the model side (ymFeedList) was never broken, so a model-only assertion would have passed before
// the fix too.
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

/** The tmdb ids of the first `n` cards on the listing behind the screen that are ALREADY streaming — ticking
 * Watch it -> Stream only lands a film in the Watch List while it currently occupies that window
 * (watchIsCurrent()), same gotcha cas540/cas544 work around. */
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

/** Set a verdict (wow/liked/enjoyed/soso/disliked) on a card via its Watched chip's real popover. */
async function pickVerdict(page, id, key){
  await page.keyboard.press("Escape");
  await page.locator(`#card-${id} .ctl.watch`).click();
  await page.locator(`.cpop .cseg[data-key="${key}"]`).click();
}

/** Never (CAS-349) lives in the Notify panel's own data-wk="never" row, not the Watched popover's csegs. */
async function pickNever(page, id){
  await tickWatchIt(page, id, "never");
}

function openYourMovies(page){ return page.evaluate(() => window.openYourMovies()); }
function closeYourMovies(page){ return page.evaluate(() => window.closeYourMovies()); }

async function ymModelCount(page){
  return page.evaluate(() => ymFeedList().length);
}
async function ymDomCount(page){
  return page.locator("#ymCards > [id^='card-']").count();
}

test("CAS-569: a Watched verdict removes the card from the Watch List immediately, model and DOM together", async ({ page }) => {
  await toStreamListing(page);
  const ids = await firstCardIds(page, 3);
  for(const id of ids) await tickWatchIt(page, id, "stream");

  await openYourMovies(page);
  await expect(page.locator("#yourMovies")).toHaveClass(/open/);

  const before = await ymModelCount(page);
  expect(await ymDomCount(page)).toBe(before);
  await expect(page.locator("#ymCardCount")).toHaveText(`${before} film${before===1?"":"s"}`);
  const barBefore = await page.locator("#ymResultBar b").textContent();
  expect(barBefore).toContain(String(before));

  const target = ids[0];
  await pickVerdict(page, target, "liked");

  // Immediately — no reload, no re-opening the screen.
  expect(await ymModelCount(page)).toBe(before - 1);
  expect(await ymDomCount(page)).toBe(before - 1);
  await expect(page.locator(`#ymCards #card-${target}`)).toHaveCount(0);
  await expect(page.locator("#ymCardCount")).toHaveText(`${before - 1} film${before - 1===1?"":"s"}`);
  const barAfter = await page.locator("#ymResultBar b").textContent();
  expect(barAfter).toContain(String(before - 1));

  // AC6 — the Watch List card itself doesn't collapse/expand as a side effect.
  await expect(page.locator("#ymcard")).not.toHaveClass(/collapsed/);

  // AC4 — clearing the verdict brings the film straight back. Once a film leaves the Watch List feed, its
  // id is restored to the deck's own (hidden, covered) copy of the card — #yourMovies is a fixed, full-
  // viewport overlay with the background scroll frozen, so that copy is never reachable by a tap while the
  // screen stays open. The honest equivalent of "tapping the same one again" is closing the screen (which is
  // what makes that same chip visible again), clearing it there, and confirming the model picks it straight
  // back up — no other user action exists to clear it.
  await closeYourMovies(page);
  await pickVerdict(page, target, "liked");
  await openYourMovies(page);
  expect(await ymModelCount(page)).toBe(before);
  expect(await ymDomCount(page)).toBe(before);
  await expect(page.locator(`#ymCards #card-${target}`)).toHaveCount(1);
  await expect(page.locator("#ymCardCount")).toHaveText(`${before} film${before===1?"":"s"}`);
});

test("CAS-569: a Never verdict removes the card from the Watch List immediately too", async ({ page }) => {
  await toStreamListing(page);
  const ids = await firstCardIds(page, 2);
  for(const id of ids) await tickWatchIt(page, id, "stream");

  await openYourMovies(page);
  const before = await ymModelCount(page);

  const target = ids[0];
  await pickNever(page, target);

  expect(await ymModelCount(page)).toBe(before - 1);
  expect(await ymDomCount(page)).toBe(before - 1);
  await expect(page.locator(`#ymCards #card-${target}`)).toHaveCount(0);
  await expect(page.locator("#ymCardCount")).toHaveText(`${before - 1} film${before - 1===1?"":"s"}`);
});

test("CAS-569: answering a film mid-list does not jump the list — the surrounding cards stay on screen", async ({ page }) => {
  await toStreamListing(page);
  const ids = await firstCardIds(page, 5);
  for(const id of ids) await tickWatchIt(page, id, "stream");

  await openYourMovies(page);
  const before = await ymModelCount(page);
  expect(before).toBeGreaterThanOrEqual(5);

  // Scroll the list container so the middle film is mid-viewport, matching #yourMovies being its own scroll
  // container (not window scroll) — the fix captures/restores THIS element's scrollTop around the refresh.
  const target = ids[2];
  await page.locator(`#card-${target}`).scrollIntoViewIfNeeded();

  // yBefore is taken after the Watched panel is open, not before. Opening it already shifts #yourMovies'
  // scrollTop by itself — a pre-existing Chromium content-visibility reveal quirk (CAS-315's own comment on
  // watchPanelAnchorY covers the identical effect on Find, corrected the same way: hold from open, not from
  // before-open). That shift is not this ticket's concern; AC5 is specifically about the repaint that follows
  // answering not moving the list any further, which is what this asserts.
  await page.keyboard.press("Escape");
  await page.locator(`#card-${target} .ctl.watch`).click();
  const yBefore = await page.evaluate(() => document.getElementById("yourMovies").scrollTop);

  await page.locator('.cpop .cseg[data-key="soso"]').click();

  expect(await ymModelCount(page)).toBe(before - 1);
  const yAfter = await page.evaluate(() => document.getElementById("yourMovies").scrollTop);
  // The removed card's own height leaves the document, so an unheld scrollTop would clamp/shift; held, it's
  // unchanged (a small tolerance covers rounding, not a real jump).
  expect(Math.abs(yAfter - yBefore)).toBeLessThanOrEqual(2);
});

test("CAS-569: answering a film on Find still folds it to its stub in place — the new branch does not fire when Watch is closed", async ({ page }) => {
  await toStreamListing(page);
  const id = (await firstCardIds(page, 1))[0];

  // Watch is closed on Find — never opened this run.
  await expect(page.locator("#yourMovies")).not.toHaveClass(/open/);

  await pickVerdict(page, id, "liked");

  // Find's own fold-in-place: the row survives as a one-line stub at the SAME id, not removed from the DOM
  // (stubHTML(), CAS-108) — the behaviour this ticket must not disturb when Watch is closed.
  const row = page.locator(`#card-${id}`);
  await expect(row).toBeVisible();
  await expect(row).toHaveClass(/stub/);
  await expect(row.locator(".stubname")).toBeVisible();
});
