// CAS-544: dedicated regression coverage for the Watch List card's scroll-collapse (CAS-540), starting from
// the actual path a playtester takes — the app opens on Find (the deck/#cascbar home view), and only reaches
// the Watch List card by tapping the Watch chip into Your Movies. CAS-540's own spec (cas540.spec.mjs) drives
// straight to Your Movies via window.openYourMovies(); this one clicks #moviesBtn from Find instead, so a
// regression in the Find->Watch handoff itself (not just the card's own collapse logic) would also be caught.
// There is no Watch List card in Find itself — it lives only in Your Movies (#yourMovies) — so this spec
// doesn't assert anything about a pill forming on the Find screen; see the CAS-544 ticket comment for why.
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

/** Same included_streaming filter as cas540.spec.mjs — an arbitrary card can tick Watch it -> Stream without
 * ever landing in the Watch List, since watchIsCurrent() requires the film to currently occupy that window. */
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

test("CAS-544: the Watch List card collapses to a pill on scroll after reaching it from Find via the Watch chip", async ({ page }) => {
  await toStreamListing(page);
  // Land on Find (the deck/#groups home view) before doing anything else — #agentsBtn is the default active chip.
  await expect(page.locator("#agentsBtn")).toHaveClass(/active/);

  const ids = await firstCardIds(page, 3);
  for(const id of ids) await tickWatchIt(page, id, "stream");

  // Reach Your Movies the way a person does: tap the Watch chip, not a direct API call.
  await page.locator("#moviesBtn").click();
  await expect(page.locator("#yourMovies")).toHaveClass(/open/);

  const card = page.locator("#ymcard");
  await expect(card).toBeVisible();
  await expect(card).not.toHaveClass(/collapsed/);

  await page.evaluate(() => { document.getElementById("yourMovies").scrollTop = 300; });
  await expect(card).toHaveClass(/collapsed/);
  await expect(card.locator(".ymcacts")).not.toBeVisible();
  await expect(card.locator(".ymctitle")).toBeVisible();
  await expect(card.locator(".ymccount")).toBeVisible();

  await page.evaluate(() => { document.getElementById("yourMovies").scrollTop = 0; });
  await expect(card).not.toHaveClass(/collapsed/);

  // Closing Your Movies returns to Find with its own #cascbar collapse mechanism untouched by this ticket.
  await page.evaluate(() => window.closeYourMovies());
  await expect(page.locator("#yourMovies")).not.toHaveClass(/open/);
  await expect(page.locator("#agentsBtn")).toHaveClass(/active/);
});
