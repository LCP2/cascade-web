// CAS-535: "Your Movies" gets a compact "Watch List" header card (rose), mirroring the deck's own small
// Agent card (icon chip, title, film count, action-icon row). The services/cascades/rewatch controls that
// used to render always-expanded now live behind the card's own Edit button — see the sibling updates to
// cas529.spec.mjs. This spec covers the card's own new surface: the summary line, and the Search/Filter/Sort
// icon row wired to a live text filter, a watch-priority popover and a real sort order, all scoped to the
// feed rather than the deck's own per-cascade state.
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

/** Tick a Watch-it level (data-wk) on a specific card via the real chip + popover row, like a person would. */
async function tickWatchIt(page, id, wk){
  const chip = page.locator(`#card-${id} .ctl.notify`);
  if(!/(^| )open( |$)/.test(await chip.getAttribute("class") || "")) await chip.click();
  await page.locator(`#card-${id} .cpop.npop .nopt[data-wk="${wk}"]`).click();
}

function openYourMovies(page){ return page.evaluate(() => window.openYourMovies()); }

/** The tmdb ids of the first `n` full cards on the listing behind the screen. */
async function firstCardIds(page, n){
  const ids = await page.locator("#groups .card").evaluateAll(
    (els, n) => els.slice(0, n).map(el => Number(el.id.replace("card-", ""))), n);
  expect(ids.length).toBe(n);
  return ids;
}

test("CAS-535: the compact Watch List card shows the icon/title/count/summary and collapses its filter controls behind Edit", async ({ page }) => {
  await toStreamListing(page);
  await openYourMovies(page);

  const card = page.locator(".ymcard");
  await expect(card).toBeVisible();
  await expect(card.locator(".ymctitle")).toHaveText("Watch List");
  await expect(card.locator(".ymccount")).toHaveText(/^\d+ films?$/);
  // Default state: Streaming only, every cascade ticked, rewatch off (CAS-529's own defaults).
  await expect(card.locator(".ymcsub")).toHaveText(/Streaming.*of.*cascade.*not incl\. watched/);

  await expect(page.locator(".ympanel")).toHaveCount(0);
  await card.locator(".ymcedit").click();
  await expect(page.locator(".ympanel")).toBeVisible();
  await expect(card.locator(".ymcedit")).toHaveClass(/on/);

  await card.locator(".ymcedit").click();   // second tap collapses it again
  await expect(page.locator(".ympanel")).toHaveCount(0);
});

test("CAS-535: the Search icon reveals a live text filter scoped to the watch list feed", async ({ page }) => {
  await toStreamListing(page);
  const [idA, idB] = await firstCardIds(page, 2);
  await tickWatchIt(page, idA, "stream");
  await tickWatchIt(page, idB, "stream");

  await openYourMovies(page);
  await expect(page.locator(`#ymCards #card-${idA}`)).toBeVisible();
  await expect(page.locator(`#ymCards #card-${idB}`)).toBeVisible();

  const titleA = await page.evaluate(id => MOVIES.find(m => m.tmdb_id === id).title, idA);

  await expect(page.locator("#ymSearchInput")).toHaveCount(0);
  await page.locator('.ymcacts button[aria-label="Search your watch list"]').click();
  const input = page.locator("#ymSearchInput");
  await expect(input).toBeVisible();
  await expect(input).toBeFocused();

  await input.fill(titleA);
  await expect(page.locator(`#ymCards #card-${idA}`)).toBeVisible();
  await expect(page.locator(`#ymCards #card-${idB}`)).toHaveCount(0);
  await expect(page.locator("#ymCardCount")).toHaveText("1 film");

  // Closing search clears the term and brings the rest of the feed straight back.
  await page.locator(".ymcsearch .searchclear").click();
  await expect(page.locator("#ymSearchInput")).toHaveCount(0);
  await expect(page.locator(`#ymCards #card-${idB}`)).toBeVisible();
});

test("CAS-535: the Filter icon narrows the feed by watch priority, independent of the Where-you-can-watch-it chips", async ({ page }) => {
  await toStreamListing(page);
  const [idA, idB] = await firstCardIds(page, 2);
  await tickWatchIt(page, idA, "stream");
  await tickWatchIt(page, idB, "stream");
  await tickWatchIt(page, idB, "rent");   // idB alone also carries the Standard Rent tier

  await openYourMovies(page);
  await expect(page.locator(`#ymCards #card-${idA}`)).toBeVisible();
  await expect(page.locator(`#ymCards #card-${idB}`)).toBeVisible();

  const filterBtn = page.locator("#ymFilterBtn");
  await filterBtn.click();
  const pop = page.locator(".cpop.ymfpop");
  await expect(pop).toBeVisible();
  await expect(filterBtn).toHaveAttribute("aria-expanded", "true");
  await expect(pop.locator(".nopt", { hasText: "Standard Rent" })).toBeVisible();
  await expect(pop.locator(".nopt", { hasText: "Undecided" })).toBeVisible();

  await pop.locator('.nopt[data-tier="rent"]').click();
  await expect(page.locator(`#ymCards #card-${idA}`)).toHaveCount(0);
  await expect(page.locator(`#ymCards #card-${idB}`)).toBeVisible();

  // A second tap on the same tier clears it, restoring both films.
  await page.locator(".cpop.ymfpop").locator('.nopt[data-tier="rent"]').click();
  await expect(page.locator(`#ymCards #card-${idA}`)).toBeVisible();
});

test("CAS-535: the Sort control reorders the feed using the same sort keys as the deck's own listing", async ({ page }) => {
  await toStreamListing(page);
  const ids = await firstCardIds(page, 3);
  for(const id of ids) await tickWatchIt(page, id, "stream");

  await openYourMovies(page);
  for(const id of ids) await expect(page.locator(`#ymCards #card-${id}`)).toBeVisible();

  await page.locator("#ymSortCtl select").selectOption("title");

  const domOrder = await page.locator("#ymCards [id^='card-']").evaluateAll(
    els => els.map(el => Number(el.id.replace("card-", ""))));
  const titleById = await page.evaluate(
    ids => Object.fromEntries(ids.map(id => [id, MOVIES.find(m => m.tmdb_id === id).title])), ids);
  const expected = [...ids].sort((a, b) => titleById[a].localeCompare(titleById[b]));
  expect(domOrder).toEqual(expected);
});
