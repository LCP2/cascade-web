// CAS-754: on the Watch screen's Streaming tab, the Upcoming section moves from last to FIRST (same
// journey order, CASCADE, the Cinema tab already reads per CAS-750), and the jump-chip rail follows it —
// no separate chip change needed, renderJumpBar walks the groups the DOM already holds. Premium and
// Rental are unchanged and still lead with LISTING_ORDER (Upcoming last).
//
// Synthetic films pinned to the same real onboarded agent (so listedBy() admits them without depending on
// catalogue-derived taste matching, same technique cas753.spec.mjs uses) and armed on the tab's own Watch
// On level by hand (winsSource "manual", same technique cas751/752/753.spec.mjs use).
import { test, expect } from "@playwright/test";
import { toShortlist, finishFlow, toListing, settleListing } from "./helpers.mjs";

const FILM_UPCOMING_STREAM = 900754001;
const FILM_CINEMA_STREAM = 900754002;
const FILM_RENTAL_STREAM = 900754003;
const FILM_STREAM_STREAM = 900754004;
const FILM_UPCOMING_PREMIUM = 900754005;
const FILM_OPENING_PREMIUM = 900754006;
const FILM_UPCOMING_RENT = 900754007;
const FILM_RENTAL_RENT = 900754008;
const ALL_FILMS = [
  FILM_UPCOMING_STREAM, FILM_CINEMA_STREAM, FILM_RENTAL_STREAM, FILM_STREAM_STREAM,
  FILM_UPCOMING_PREMIUM, FILM_OPENING_PREMIUM, FILM_UPCOMING_RENT, FILM_RENTAL_RENT,
];

async function toWatchScreen(page){
  await toShortlist(page, "stream");
  await finishFlow(page);
  await toListing(page);
  return page.evaluate(() => cascades[0].id);
}

async function seedFilm(page, { cascadeId, id, title, status, level }){
  await page.evaluate(({ cascadeId, id, title, status, level }) => {
    MOVIES.push({ tmdb_id: id, title, status: [status], offers: [] });
    const e = entryFor(id);
    e.pinnedTo = [cascadeId];
    e.wins = { [level]: true };
    e.winsSource = { [level]: "manual" };
  }, { cascadeId, id, title, status, level });
}

async function toTab(page, key){
  await page.evaluate(k => setWatchTab(k), key);
  await settleListing(page);
}

const jumpChipKeys = page => page.locator("#jumpBar .jchip").evaluateAll(chips => chips.map(c => c.dataset.jump));
const groupKeys = page => page.locator("#groups .group").evaluateAll(gs => gs.map(g => g.dataset.g));

test.afterEach(async ({ page }) => {
  await page.evaluate(ids => {
    ids.forEach(id => {
      const i = MOVIES.findIndex(m => m.tmdb_id === id);
      if(i >= 0) MOVIES.splice(i, 1);
      delete notify[id];
    });
  }, ALL_FILMS);
});

test("CAS-754 AC1: the Streaming tab leads with Upcoming, jump chips follow (Upcoming leftmost)", async ({ page }) => {
  const cascadeId = await toWatchScreen(page);
  await seedFilm(page, { cascadeId, id: FILM_UPCOMING_STREAM, title: "CAS-754 — Upcoming", status: "upcoming", level: "stream" });
  await seedFilm(page, { cascadeId, id: FILM_CINEMA_STREAM, title: "CAS-754 — Cinema", status: "in_cinema", level: "stream" });
  await seedFilm(page, { cascadeId, id: FILM_RENTAL_STREAM, title: "CAS-754 — Rental", status: "rental", level: "stream" });
  await seedFilm(page, { cascadeId, id: FILM_STREAM_STREAM, title: "CAS-754 — Stream", status: "included_streaming", level: "stream" });
  await page.evaluate(() => render());
  await toTab(page, "stream");

  expect((await groupKeys(page))[0]).toBe("upcoming");
  // Relative order of the remaining chips is unchanged: Cinema before Rent before Stream.
  expect(await jumpChipKeys(page)).toEqual(["upcoming", "in_cinema", "rental", "included_streaming"]);
});

test("CAS-754 AC2a: the Premium tab still leads with LISTING_ORDER — Upcoming stays last", async ({ page }) => {
  const cascadeId = await toWatchScreen(page);
  await seedFilm(page, { cascadeId, id: FILM_UPCOMING_PREMIUM, title: "CAS-754 — Upcoming (premium)", status: "upcoming", level: "premium" });
  await seedFilm(page, { cascadeId, id: FILM_OPENING_PREMIUM, title: "CAS-754 — Opening (premium)", status: "opening_week", level: "premium" });
  await page.evaluate(() => render());
  await toTab(page, "premium");

  expect(await groupKeys(page)).toEqual(["opening_week", "upcoming"]);
});

test("CAS-754 AC2b: the Rental tab still leads with LISTING_ORDER — Upcoming stays last", async ({ page }) => {
  const cascadeId = await toWatchScreen(page);
  await seedFilm(page, { cascadeId, id: FILM_UPCOMING_RENT, title: "CAS-754 — Upcoming (rent)", status: "upcoming", level: "rent" });
  await seedFilm(page, { cascadeId, id: FILM_RENTAL_RENT, title: "CAS-754 — Rental (rent)", status: "rental", level: "rent" });
  await page.evaluate(() => render());
  await toTab(page, "rent");

  expect(await groupKeys(page)).toEqual(["rental", "upcoming"]);
});
