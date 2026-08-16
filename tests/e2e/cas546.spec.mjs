// CAS-546: the "Movie Selections" block (Unwatched/Watched/Don't-want-to-watch, with counts) that used to
// sit below the Watch List feed is gone. It had no other entry point (YM_GROUPS/ymOpen/ymToggle were only
// ever read by that one block), so removal drops the feature entirely rather than leaving a dead route.
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

test("CAS-546: the Movie Selections section no longer renders on the Watch area", async ({ page }) => {
  await toStreamListing(page);
  await openYourMovies(page);

  await expect(page.locator(".usec", { hasText: "Movie selections" })).toHaveCount(0);
  const groupLabels = await page.locator(".ucard .urow .ut").allTextContents();
  expect(groupLabels.some(t => /Unwatched/.test(t))).toBe(false);
  expect(groupLabels.some(t => /^Watched$/.test(t))).toBe(false);
  expect(groupLabels.some(t => /Don't want to watch/.test(t))).toBe(false);

  await expect(page.evaluate(() => typeof window.ymToggle)).resolves.toBe("undefined");
});
