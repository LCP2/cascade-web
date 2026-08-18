// CAS-570: the Watch List Edit panel's single "include films I've watched" switch became one tickbox per
// WATCH_STEPS verdict (Wow!/Watch Again/Enjoyed/So-so/Disliked). This spec covers the two acceptance
// criteria the ticket calls out for new coverage: AC3 (ticking a verdict brings back exactly the films
// with that verdict, and only that verdict) and AC7 (Never/blocked films never appear, whatever is
// ticked). The rest of the ticket (default state, summary line wording, Select all/Clear all) is a
// verbatim-patch/small-state change already exercised by the updated cas529.spec.mjs.
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

/** The tmdb ids of the first `n` full cards on the listing behind the screen. */
async function firstCardIds(page, n){
  const ids = await page.locator("#groups .card").evaluateAll(
    (els, n) => els.slice(0, n).map(el => Number(el.id.replace("card-", ""))), n);
  expect(ids.length).toBe(n);
  return ids;
}

async function tickWatchIt(page, id, wk){
  const chip = page.locator(`#card-${id} .ctl.notify`);
  if(!/(^| )open( |$)/.test(await chip.getAttribute("class") || "")) await chip.click();
  await page.locator(`#card-${id} .cpop.npop .nopt[data-wk="${wk}"]`).click();
}

// CAS-536: the feed's service filter gates on the film's REAL current window (m.status), not merely a
// tick — a tick can be set ahead of a rung the film hasn't reached yet. AC3 needs each film to actually
// reappear once its verdict is ticked, so it has to tick + rely on the film's real current window rather
// than a hardcoded "stream", same pattern cas529.spec.mjs's currentSvcKey established.
async function currentSvcKey(page, id){
  return page.evaluate((id) => {
    const m = MOVIES.find(x => x.tmdb_id === id);
    if(!m) return null;
    for(const w of m.status){
      const key = filmOptKeyForWindow(null, w);
      if(WATCH_LEVEL_KEYS.includes(key)) return key;
    }
    return null;
  }, id);
}

async function pickVerdict(page, id, key){
  await page.keyboard.press("Escape");
  await page.locator(`#card-${id} .ctl.watch`).click();
  await page.locator(`.cpop .cseg[data-key="${key}"]`).click();
}

async function pickNever(page, id){
  await tickWatchIt(page, id, "never");
}

function openYourMovies(page){ return page.evaluate(() => window.openYourMovies()); }

async function openYmEdit(page){
  await page.locator(".ymcedit").click();
  await expect(page.locator(".ympanel")).toBeVisible();
}

function verdictBox(page, label){
  return page.locator(".ymverdicts .nopt", { hasText: label });
}

test("CAS-570: ticking Watch Again brings back exactly the liked films; ticking Wow too adds only wow films (AC3)", async ({ page }) => {
  await toStreamListing(page);
  const [likedId, wowId, sosoId] = await firstCardIds(page, 3);

  const [likedSvc, wowSvc, sosoSvc] = await Promise.all(
    [likedId, wowId, sosoId].map(id => currentSvcKey(page, id)));
  test.skip([likedSvc, wowSvc, sosoSvc].includes(null), "a picked card isn't at any Watch-ladder window right now");

  await tickWatchIt(page, likedId, likedSvc);
  await pickVerdict(page, likedId, "liked");
  await tickWatchIt(page, wowId, wowSvc);
  await pickVerdict(page, wowId, "wow");
  await tickWatchIt(page, sosoId, sosoSvc);
  await pickVerdict(page, sosoId, "soso");

  await openYourMovies(page);
  await openYmEdit(page);
  // Every service on — the point of this test is the verdict filter, not the service filter, and the
  // three films picked may sit at three different real windows.
  await page.locator(".ymlinkrow .ymlink", { hasText: "Select all" }).first().click();

  // Nothing ticked yet — every watched film stays excluded, the CAS-570 default.
  for(const id of [likedId, wowId, sosoId]){
    await expect(page.locator(`#ymCards #card-${id}`)).toHaveCount(0);
  }

  await verdictBox(page, "Watch Again").click();
  await expect(verdictBox(page, "Watch Again")).toHaveClass(/on/);
  await expect(page.locator(`#ymCards #card-${likedId}`)).toBeVisible();
  await expect(page.locator(`#ymCards #card-${wowId}`)).toHaveCount(0);
  await expect(page.locator(`#ymCards #card-${sosoId}`)).toHaveCount(0);

  await verdictBox(page, "Wow!").click();
  await expect(page.locator(`#ymCards #card-${likedId}`)).toBeVisible();
  await expect(page.locator(`#ymCards #card-${wowId}`)).toBeVisible();
  await expect(page.locator(`#ymCards #card-${sosoId}`)).toHaveCount(0);

  // Unticking removes it again immediately (AC4).
  await verdictBox(page, "Wow!").click();
  await expect(page.locator(`#ymCards #card-${wowId}`)).toHaveCount(0);
});

test("CAS-570: a film marked Never never appears, whatever is ticked (AC7)", async ({ page }) => {
  await toStreamListing(page);
  const [id] = await firstCardIds(page, 1);
  await tickWatchIt(page, id, "stream");
  await pickNever(page, id);

  await openYourMovies(page);
  await openYmEdit(page);
  // Select all on the verdict row — every WATCH_STEPS verdict ticked, the widest net this feed can cast.
  await page.locator(".ymlinkrow .ymlink", { hasText: "Select all" }).last().click();
  await expect(page.locator(".ymverdicts .nopt.on")).toHaveCount(5);
  await expect(page.locator(`#ymCards #card-${id}`)).toHaveCount(0);
});
