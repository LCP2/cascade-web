// CAS-410: a cinema-lane agent's Upcoming section reads soonest-to-open first, furthest-out last, whatever
// its sort key — including "cinema" ("Newest cinema"), the one sort CAS-470's global Upcoming-ascending
// fix didn't reach because it's a PRE_RELEASE_SORTS literal-order key like Title. See sortForKey in
// app_template.html. In Cinema keeps CAS-394/CAS-430's oldest-first read; streaming agents are unaffected.
import { test, expect } from "@playwright/test";
import { toShortlist, pickCard, finishFlow, toListing, settleListing, freshApp } from "./helpers.mjs";

/** cinema_date for every card currently rendered in a given listing group, in DOM order. */
async function cinemaDatesInGroup(page, group){
  const ids = await page.locator(`#groups .group[data-g="${group}"] .card`).evaluateAll(
    cards => cards.map(c => c.id.replace(/^card-/, ""))
  );
  return page.evaluate(ids => ids.map(id => {
    const m = MOVIES.find(x => String(x.tmdb_id) === id);
    return m ? (m.cinema_date || null) : null;
  }), ids);
}

/** True if every non-null value in `dates` is non-decreasing, and every null sits after every non-null. */
function isAscendingThenNulls(dates){
  const firstNullIdx = dates.indexOf(null);
  if(firstNullIdx !== -1 && dates.slice(firstNullIdx).some(d => d !== null)) return false;
  const dated = dates.filter(d => d !== null);
  for(let i = 1; i < dated.length; i++){
    if(dated[i] < dated[i-1]) return false;
  }
  return true;
}

test("CAS-410: a cinema agent's Upcoming reads soonest-first under the \"Newest cinema\" sort too", async ({ page }) => {
  await toShortlist(page, "cinema");
  await pickCard(page, "Blockbusters");
  await finishFlow(page);
  await toListing(page);

  // Before this fix, key==="cinema" fell through sortForKey's PRE_RELEASE_SORTS branch straight to
  // sortMoviesBy("cinema"), which is a plain descending compare — furthest-out first, the exact bug.
  await page.locator("#sort").selectOption("cinema");
  await expect(page.locator("#sort")).toHaveValue("cinema");
  await settleListing(page);

  const upcoming = await cinemaDatesInGroup(page, "upcoming");
  expect(upcoming.filter(d => d !== null).length).toBeGreaterThan(1);
  expect(isAscendingThenNulls(upcoming)).toBe(true);

  // CAS-394/CAS-430: In Cinema still leads, oldest cinema_date first, regardless of sort.
  const inCinema = await cinemaDatesInGroup(page, "in_cinema");
  if(inCinema.length > 1){
    const dated = inCinema.filter(d => d !== null);
    for(let i = 1; i < dated.length; i++) expect(dated[i] >= dated[i-1]).toBe(true);
  }
});

test("CAS-410: sortForKey only redirects Upcoming's \"cinema\" sort to ascending for a cinema agent", async ({ page }) => {
  // A streaming agent's default criteria don't include the pre-release Upcoming window at all (nothing on
  // a streaming service is unreleased), and CAS-566 removed the old unscoped "All" doorway that CAS-470's
  // own spec used to get a non-cinema listing with real Upcoming matches to assert an order on — so there
  // is no reliable UI path left to exercise this non-goal against real catalogue data. sortForKey is a
  // plain top-level function in the classic script (see helpers.mjs's note on MOVIES/flowStart being bare
  // globals, not window properties), so it's called directly instead — the exact unit the fix touches.
  await freshApp(page);

  const cinemaAgentPicksAscending = await page.evaluate(
    () => sortForKey("upcoming", "cinema", true) === byTimelineAsc
  );
  expect(cinemaAgentPicksAscending).toBe(true);

  // Non-cinema agents are out of this ticket's scope: key==="cinema" still falls through to sortMoviesBy's
  // plain descending compare, same as before this fix — furthest-out (newest) cinema_date sorts first.
  const nonCinemaOrder = await page.evaluate(() => {
    const cmp = sortForKey("upcoming", "cinema", false);
    return cmp({ cinema_date: "2026-09-17" }, { cinema_date: "2026-11-19" });
  });
  expect(nonCinemaOrder).toBeGreaterThan(0);
});
