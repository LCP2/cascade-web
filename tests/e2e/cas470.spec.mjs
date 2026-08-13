// CAS-470: the Upcoming section now reads soonest-release first, furthest-out last — a deliberate
// reversal of CAS-177 (which had it read the other way). In Cinema keeps its own order (newest arrival
// first) unchanged; see byTimeline/byTimelineAsc and sortForKey in app_template.html.
import { test, expect } from "@playwright/test";
import { toShortlist, pickCard, finishFlow, toListing, settleListing } from "./helpers.mjs";

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
  if(firstNullIdx !== -1 && dates.slice(firstNullIdx).some(d => d !== null)) return false; // a dated title after a null
  const dated = dates.filter(d => d !== null);
  for(let i = 1; i < dated.length; i++){
    if(dated[i] < dated[i-1]) return false;
  }
  return true;
}

test("CAS-470: the Upcoming section's default order is soonest-release first, furthest-out last", async ({ page }) => {
  await toShortlist(page, "cinema");
  await pickCard(page, "Blockbusters");
  await finishFlow(page);
  await toListing(page);

  // Switch to All — the un-scoped view (no active Cascade), which is where the shared byTimeline/
  // byTimelineAsc split actually gets exercised: a cinema-kind agent already reused byTimelineAsc for
  // "availability" via its own `cinema` flag (CAS-430), so it doesn't tell the general default order apart
  // from CAS-470's fix. All has no such flag, so it is the real test of the section's own default.
  await page.locator(".dcard.all").click();
  await settleListing(page);

  // "Availability" is the app's documented default order (CAS-148) — select it explicitly rather than
  // relying on a freshly-created agent's own sort field, which a separate, pre-existing quirk in
  // commitDraft() seeds as the legacy "imdb" value rather than "availability" (out of this ticket's scope).
  await page.locator("#sort").selectOption("availability");
  await expect(page.locator('#sort')).toHaveValue("availability");

  const upcoming = await cinemaDatesInGroup(page, "upcoming");
  expect(upcoming.length).toBeGreaterThan(1);
  expect(upcoming.filter(d => d !== null).length).toBeGreaterThan(1); // the assertion below needs real dates
  expect(isAscendingThenNulls(upcoming)).toBe(true);

  // CAS-470's own scope note: In Cinema's order is untouched — newest arrival first, i.e. descending.
  const inCinema = await cinemaDatesInGroup(page, "in_cinema");
  if(inCinema.length > 1){
    const dated = inCinema.filter(d => d !== null);
    for(let i = 1; i < dated.length; i++) expect(dated[i] <= dated[i-1]).toBe(true);
  }
});

test("CAS-470: a sort with no meaning pre-release still falls back to the release timeline, soonest first", async ({ page }) => {
  await toShortlist(page, "cinema");
  await pickCard(page, "Blockbusters");
  await finishFlow(page);
  await toListing(page);

  // "Most anticipated" (popularity) is not one of the sorts Upcoming keeps literally (PRE_RELEASE_SORTS),
  // so it falls back to the release timeline — ascending, per CAS-470, not the pre-CAS-470 descending fallback.
  await page.locator("#sort").selectOption("popularity");
  await expect(page.locator('#sort')).toHaveValue("popularity");

  const upcoming = await cinemaDatesInGroup(page, "upcoming");
  expect(upcoming.filter(d => d !== null).length).toBeGreaterThan(1);
  expect(isAscendingThenNulls(upcoming)).toBe(true);
});
