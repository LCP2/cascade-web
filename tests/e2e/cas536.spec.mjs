// CAS-536: regression against CAS-529 — "Where you can watch it" was reading raw Watch-it ticks (filmOptOn)
// as a stand-in for "available via this service right now", when a tick can legitimately be set ahead of
// time on a future rung the film hasn't reached yet (CAS-473 lets you pre-select "In Cinema" on a still-
// Upcoming film) and ticking one rung auto-ticks every enabled rung FROM there DOWN to Streaming (CAS-349's
// cascade, so notifications don't stop early). Net effect: Cinema showed films that were only Upcoming, and
// Streaming showed Cinema/Rent films whose tick had only cascaded onto it. The fix (filmCurrentlyAt in
// app_template.html) additionally requires the film to actually be sitting in the ticked window (m.status).
import { test, expect } from "@playwright/test";
import { toShortlist, shortlistCards, pickCard, finishFlow, toListing, settleListing } from "./helpers.mjs";

async function toCinemaListing(page){
  await toShortlist(page, "cinema");
  const cards = await shortlistCards(page);
  await pickCard(page, cards[0].name);
  await finishFlow(page);
  await toListing(page);
  await settleListing(page);
}

/** First card in a given listing group ("upcoming"/"in_cinema"/...), or null if the group is empty. */
async function firstCardInGroup(page, group){
  const card = page.locator(`#groups .group[data-g="${group}"] .card`).first();
  if(await card.count() === 0) return null;
  return Number((await card.getAttribute("id")).replace("card-", ""));
}

async function tickWatchIt(page, id, wk){
  const chip = page.locator(`#card-${id} .ctl.notify`);
  if(!/(^| )open( |$)/.test(await chip.getAttribute("class") || "")) await chip.click();
  await page.locator(`#card-${id} .cpop.npop .nopt[data-wk="${wk}"]`).click();
}

function openYourMovies(page){ return page.evaluate(() => window.openYourMovies()); }

async function openYmEdit(page){
  await page.locator(".ymcedit").click();
  await expect(page.locator(".ympanel")).toBeVisible();
}

async function selectOnlyService(page, label){
  for(const l of ["Cinema","Streaming","Rent","Buy"]){
    const chip = page.locator(".ymchip", { hasText: l });
    const isOn = /(^| )on( |$)/.test(await chip.getAttribute("class") || "");
    if((l===label) !== isOn) await chip.click();
  }
}

test("CAS-536: Cinema filter excludes a film only pre-ticked ahead of time — it isn't in cinemas yet", async ({ page }) => {
  await toCinemaListing(page);
  const id = await firstCardInGroup(page, "upcoming");
  test.skip(id === null, "no Upcoming film in this cascade's listing");

  // CAS-473 explicitly allows this: pre-selecting "In Cinema" on a film that hasn't reached a cinema yet.
  await tickWatchIt(page, id, "in_cinema");

  await openYourMovies(page);
  await openYmEdit(page);
  await selectOnlyService(page, "Cinema");
  await expect(page.locator(`#ymCards #card-${id}`)).toHaveCount(0);
  await expect(page.locator(".unone", { hasText: "No films match" })).toBeVisible();
});

test("CAS-536: Streaming filter excludes a Cinema-ticked film even though the tick cascaded onto Streaming", async ({ page }) => {
  await toCinemaListing(page);
  const id = await firstCardInGroup(page, "in_cinema");
  test.skip(id === null, "no In-Cinema film in this cascade's listing");

  // CAS-349: ticking "In Cinema" auto-ticks every enabled rung below it too, including Streaming — that
  // cascade is intentional for notify purposes, but shouldn't make this film's real current window a lie.
  await tickWatchIt(page, id, "in_cinema");

  await openYourMovies(page);
  await openYmEdit(page);

  await selectOnlyService(page, "Cinema");
  await expect(page.locator(`#ymCards #card-${id}`)).toBeVisible();   // it really is in cinemas — this one's correct

  await selectOnlyService(page, "Streaming");
  await expect(page.locator(`#ymCards #card-${id}`)).toHaveCount(0);
  await expect(page.locator(".unone", { hasText: "No films match" })).toBeVisible();

  await selectOnlyService(page, "Rent");
  await expect(page.locator(`#ymCards #card-${id}`)).toHaveCount(0);
});
