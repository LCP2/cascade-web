// CAS-545: cardHTML is one shared component (Find's listing and the Watch List feed both call it), but
// #yourMoviesBody is a standard .uwrap dialog padded 16px each side for prose content, while Find's own
// .list only insets 5px each side (see cardHTML's callers: fillListChunked for #groups .list,
// ymFillCards for #ymCards). Left unmatched, the identical card rendered ~22px narrower in the Watch
// List than in Find — enough to flex-wrap the ratings row (.mrow.r-scores is flex-wrap) and
// ellipsis-truncate the streaming/services line (.savetxt). The fix cancels .uwrap's padding on
// .ymcards and reapplies .list's own 5px so both contexts give the card the same width at any device
// width — this spec proves that by measuring the SAME film's card in both places.
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

test("CAS-545: the shared card renders at the same width in Find and in the Watch List", async ({ page }) => {
  await toStreamListing(page);

  const id = await page.evaluate(() => {
    const onScreen = Array.from(document.querySelectorAll("#groups .card")).map(el => Number(el.id.replace("card-", "")));
    return onScreen.find(id => {
      const m = MOVIES.find(x => x.tmdb_id === id);
      return m && m.status.includes("included_streaming");
    });
  });
  expect(id).toBeTruthy();

  // Watch it -> Streaming, the same tick cas544/cas540 use to land a film in the Watch List feed.
  const chip = page.locator(`#card-${id} .ctl.notify`);
  if(!/(^| )open( |$)/.test(await chip.getAttribute("class") || "")) await chip.click();
  await page.locator(`#card-${id} .cpop.npop .nopt[data-wk="stream"]`).click();

  // Measure the Find copy BEFORE opening Your Movies: ymAvoidCardIdCollisions() strips this id off the
  // deck's (Find's) copy of the card the whole time Your Movies is open, so it stops being #card-<id> then.
  const findCard = page.locator(`#groups #card-${id}`);
  const findWidth = await findCard.evaluate(el => el.getBoundingClientRect().width);
  const findScoresWidth = await findCard.locator(".r-scores").evaluate(el => el.getBoundingClientRect().width);

  await page.locator("#moviesBtn").click();
  await expect(page.locator("#yourMovies")).toHaveClass(/open/);
  const ymCard = page.locator(`#yourMoviesBody #card-${id}`);
  await expect(ymCard).toBeVisible();
  const watchListWidth = await ymCard.evaluate(el => el.getBoundingClientRect().width);

  expect(watchListWidth).toBeCloseTo(findWidth, 1);

  // The ratings row itself gets the same available width in both contexts too — not just the outer card —
  // since a matched card width with a mismatched inner row would still wrap/truncate.
  const ymScoresWidth = await ymCard.locator(".r-scores").evaluate(el => el.getBoundingClientRect().width);
  expect(ymScoresWidth).toBeCloseTo(findScoresWidth, 1);
});
