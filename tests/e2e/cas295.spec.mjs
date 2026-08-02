// CAS-295: a cinema agent's listing runs Upcoming -> Opening -> Cinema.
import { test, expect } from "@playwright/test";
import { toShortlist, shortlistCards, pickCard, finishFlow, toListing, sectionCounts } from "./helpers.mjs";

async function agentListing(page, kind){
  await toShortlist(page, kind);
  const cards = await shortlistCards(page);
  await pickCard(page, cards[0].name);
  await finishFlow(page);
  await toListing(page);
}

test("CAS-295: a cinema agent's sections come out in the ticket's order", async ({ page }) => {
  await agentListing(page, "cinema");
  const windows = (await sectionCounts(page)).map(s => s.window);
  const want = ["upcoming", "opening_week", "in_cinema"].filter(w => windows.includes(w));
  test.skip(want.length < 2, "this cinema agent has fewer than two cinema sections today");
  const got = windows.filter(w => want.includes(w));
  expect(got, `sections came out as ${JSON.stringify(windows)}`).toEqual(want);
});

test("CAS-295: Upcoming leads, rather than trailing", async ({ page }) => {
  await agentListing(page, "cinema");
  const windows = (await sectionCounts(page)).map(s => s.window);
  test.skip(!windows.includes("upcoming"), "no Upcoming section today");
  test.skip(windows.length < 2, "only one section today");
  expect(windows[0], `the first section is ${windows[0]}`).toBe("upcoming");
});

test("CAS-295: a streaming agent is unaffected and still ends with Upcoming", async ({ page }) => {
  await agentListing(page, "stream");
  const windows = (await sectionCounts(page)).map(s => s.window);
  test.skip(!windows.includes("upcoming"), "no Upcoming section on this streaming agent today");
  test.skip(windows.length < 2, "only one section today");
  expect(windows[windows.length - 1], `sections came out as ${JSON.stringify(windows)}`).toBe("upcoming");
});

test("CAS-295: the two lanes really do use different orders", async ({ page }) => {
  await agentListing(page, "cinema");
  const same = await page.evaluate(() => {
    const cinema = { kind: "cinema" }, stream = { kind: "stream" };
    return {
      cinemaFirst: orderFor(cinema)[0],
      streamFirst: orderFor(stream)[0],
      streamLast: orderFor(stream)[orderFor(stream).length - 1],
      differ: orderFor(cinema) !== orderFor(stream),
    };
  });
  expect(same.cinemaFirst).toBe("upcoming");
  expect(same.streamFirst).not.toBe("upcoming");
  expect(same.streamLast).toBe("upcoming");
  expect(same.differ).toBe(true);
});

test("CAS-295: both orders still cover all six windows — none was dropped in the reshuffle", async ({ page }) => {
  await agentListing(page, "cinema");
  const ok = await page.evaluate(() => {
    const sorted = a => [...a].sort().join(",");
    return sorted(CINEMA_LISTING_ORDER) === sorted(CASCADE) && sorted(LISTING_ORDER) === sorted(CASCADE);
  });
  expect(ok, "a window went missing from one of the two orders").toBe(true);
});

test("CAS-295: the jump rail follows the new order", async ({ page }) => {
  await agentListing(page, "cinema");
  const chips = await page.locator("#jumpBar .jchip").evaluateAll(b => b.map(x => x.dataset.jump));
  test.skip(chips.length < 2, "the jump rail is hidden with fewer than two sections");
  const windows = (await sectionCounts(page)).map(s => s.window);
  expect(chips, "the rail and the listing disagree about order").toEqual(windows);
});
