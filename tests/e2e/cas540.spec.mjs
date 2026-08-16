// CAS-540: the Watch List card (CAS-535) now collapses to a pill under scroll, the same mechanism
// #cascbar already uses (CAS-512/519/526) — own anchor element, scroll-triggered collapsed-state toggle,
// no-transition-on-live-scroll handling. The real difference is the scroll container: #cascbar sticks
// under the page's own window scroll, but Your Movies (#yourMovies) is a .uscreen with its own
// overflow-y:auto, so the anchor/listener/observer are scoped to that element instead of window.
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

/** The tmdb ids of the first `n` cards on the listing behind the screen that are ALREADY streaming — ticking
 * Watch it -> Stream only lands a film in the Watch List while it currently occupies that window
 * (watchIsCurrent()), so picking arbitrary cards (as opposed to ones already `included_streaming`) can tick a
 * real film that never shows up here, which is a test-setup bug rather than a feature one. */
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

test("CAS-540: the Watch List card collapses to a pill on scroll and expands back at the top", async ({ page }) => {
  await toStreamListing(page);
  const ids = await firstCardIds(page, 3);
  for(const id of ids) await tickWatchIt(page, id, "stream");

  await openYourMovies(page);
  const card = page.locator("#ymcard");
  await expect(card).toBeVisible();
  await expect(card).not.toHaveClass(/collapsed/);
  await expect(card.locator(".ymcsub")).toBeVisible();

  await scrollYourMovies(page, 300);
  await expect(card).toHaveClass(/collapsed/);
  // The action row (Edit/Search/Filter/Sort) and sub-line drop out of the pill, matching .cascbar.collapsed's
  // own "keep the name, drop everything else" shape — the title/count stay so the pill still means something.
  await expect(card.locator(".ymcacts")).not.toBeVisible();
  await expect(card.locator(".ymctitle")).toBeVisible();
  await expect(card.locator(".ymccount")).toBeVisible();

  await scrollYourMovies(page, 0);
  await expect(card).not.toHaveClass(/collapsed/);
  await expect(card.locator(".ymcacts")).toBeVisible();
});

test("CAS-540: tapping the collapsed pill expands it back, the same gesture as tapping the deck's own open card", async ({ page }) => {
  await toStreamListing(page);
  const ids = await firstCardIds(page, 2);
  for(const id of ids) await tickWatchIt(page, id, "stream");

  await openYourMovies(page);
  const card = page.locator("#ymcard");

  await scrollYourMovies(page, 300);
  await expect(card).toHaveClass(/collapsed/);

  await card.click();
  await expect(card).not.toHaveClass(/collapsed/);
  await expect(card.locator(".ymcacts")).toBeVisible();
});
