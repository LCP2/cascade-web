// CAS-301: the card's offer-timeline strip flags a whole card "estimated" whenever the home-window guess
// (pvod/rental/stream) isn't backed by a live listing — but for a film currently in cinemas, that flag is
// about whether it's STILL playing, not about the cinema date itself (stageDate never marks "cinema" as
// est). The old CSS greyed the Cinema pill along with the rest of the card; it must keep the cinema token.
//
// CAS-318: built from "Totally Custom" (the wide-open recipe cas289/data-integrity's "widest cinema recipe"
// also uses), not the first shortlist card. The skip guard below checks the WHOLE catalogue for a qualifying
// film, so the DOM search has to look at a listing that can hold every showable film too — CAS-314's 14-day
// estimate cap shrank the pool of qualifying films enough that a narrower, taste-scored preset (Blockbusters,
// the old cards[0]) can miss the one candidate left on a given day even though it truly exists and is shown
// elsewhere.
import { test, expect } from "@playwright/test";
import { toShortlist, pickCard, finishFlow, toListing } from "./helpers.mjs";

test("CAS-301: an in-cinema card's Cinema pill stays cinema-yellow even when the card is flagged estimated", async ({ page }) => {
  await toShortlist(page, "cinema");
  await pickCard(page, "Totally Custom");
  await finishFlow(page);
  await toListing(page);

  const hasEstimatedInCinemaCard = await page.evaluate(() =>
    MOVIES.some(m => isEstimated(m) && primaryStatus(m) === "in_cinema"));
  test.skip(!hasEstimatedInCinemaCard, "no estimated in-cinema film in today's catalogue");

  const pill = await page.evaluate(() => {
    const card = [...document.querySelectorAll("#groups .card")].find(c => {
      const id = Number((c.id || "").replace("card-", ""));
      const m = MOVIES.find(x => x.tmdb_id === id);
      return m && isEstimated(m) && primaryStatus(m) === "in_cinema";
    });
    if(!card) return null;
    const el = card.querySelector(".win.w-cin-cinema.on .wpill");
    if(!el) return null;
    const cs = getComputedStyle(el);
    return { bg: cs.backgroundColor, color: cs.color, borderStyle: cs.borderStyle };
  });

  expect(pill).not.toBeNull();
  expect(pill.bg).toBe("rgba(240, 163, 54, 0.18)");
  expect(pill.color).toBe("rgb(255, 206, 143)");
  expect(pill.borderStyle).toBe("solid");
});
