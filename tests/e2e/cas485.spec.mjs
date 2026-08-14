// CAS-485: the Watch-it control now carries CAS-468's gold "recent" glow when the film's CURRENT window is
// one you've ticked on that control — reusing watchIsCurrent (CAS-349's st.current), no recency gate, and
// the same .cap.recent border/box-shadow values rather than a second visual language.
// CAS-494: watchIsCurrent originally tested the tick against only the film's SINGLE primaryStatus rung, so a
// film sitting in more than one window at once (e.g. still in_cinema while also included_streaming) never
// glowed for a tick on any window but its primary one. The tests at the bottom of this file cover that case
// with the CAS-486 multi-window fixture (TEST 5, tmdb_id 999000005) — the "reading, not simulating a full UI
// flow" approach cas486/490/491 already use for this account-gated harness.
import { test, expect } from "@playwright/test";
import {
  toShortlist, shortlistCards, pickCard, finishFlow, toListing, settleListing, ctaLocator,
} from "./helpers.mjs";

// Same setup as CAS-473: the Watch-it popup only offers a row for a window this agent's Notify switch is on
// for, and a fresh onboarded agent starts with every window's Notify off.
async function enableAllNotify(page){
  await page.evaluate(() => window.editCascade());
  await expect(page.locator(".osh", { hasText: /Edit Agent/ })).toBeVisible();
  await page.locator(".osdoor", { hasText: "Where & when you'll watch" }).click();
  await expect(page.locator("#wwLanes .wwlane").first()).toBeVisible();
  for(const label of ["Premium", "Standard Rent", "Streaming"]){
    const lane = page.locator(".wwlane", { has: page.locator(".wwn", { hasText: label }) });
    const notifyBtn = lane.locator(".agwt", { hasText: "Follow" });
    await notifyBtn.click();
    await expect(notifyBtn).toHaveClass(/on/);
  }
  await ctaLocator(page).click();                                    // Done, back to the Edit Agent hub
  await expect(page.locator(".osh", { hasText: /Edit Agent/ })).toBeVisible();
  await page.locator(".osfoot .oscta", { hasText: "Save agent" }).click();
  await expect(page.locator("#onbStep")).not.toHaveClass(/open/);
  await settleListing(page);
}

async function toListingWithAgent(page){
  await toShortlist(page, "stream");
  const cards = await shortlistCards(page);
  await pickCard(page, cards[0].name);
  await finishFlow(page);
  await toListing(page);
  await enableAllNotify(page);
}

/** First card in a given listing group ("rental"/"pvod"/"included_streaming"), or null if the group is empty. */
async function firstCardInGroup(page, group){
  const card = page.locator(`#groups .group[data-g="${group}"] .card`).first();
  if(await card.count() === 0) return null;
  return (await card.getAttribute("id")).replace(/^card-/, "");
}

test("CAS-485: ticking a film's current window glows the Watch-it control immediately, no reload", async ({ page }) => {
  await toListingWithAgent(page);

  const id = await firstCardInGroup(page, "rental");
  test.skip(id === null, "no film currently at Rent in this agent's listing");

  const chip = page.locator(`.ctl.notify[data-nid="${id}"]`);
  await expect(chip).not.toHaveClass(/recent/);

  await chip.click();
  await expect(page.locator(".cpop.npop")).toBeVisible();
  const rentRow = page.locator('.cpop.npop .nopt[data-wk="rent"]');
  await expect(rentRow).toBeEnabled();
  await rentRow.click();                          // ticks the film's own CURRENT window

  // The chip is re-rendered (repaintWatchControl) — re-locate it and expect the glow with no reload.
  const glowingChip = page.locator(`.ctl.notify[data-nid="${id}"]`);
  await expect(glowingChip).toHaveClass(/recent/);
  await expect(glowingChip).toHaveClass(/on/);

  // Un-ticking removes the glow immediately too — the popup is still open from the tick above
  // (repaintWatchControl re-applies .open), so the same row is clicked again to untick it.
  await expect(page.locator(".cpop.npop")).toBeVisible();
  await page.locator('.cpop.npop .nopt[data-wk="rent"]').click();
  const untickedChip = page.locator(`.ctl.notify[data-nid="${id}"]`);
  await expect(untickedChip).not.toHaveClass(/recent/);
});

test("CAS-485: ticking a window that is NOT the film's current window does not glow", async ({ page }) => {
  await toListingWithAgent(page);

  // Streaming is ahead of Rent on the ladder — a film currently at Rent has Streaming un-spent but not current.
  const id = await firstCardInGroup(page, "rental");
  test.skip(id === null, "no film currently at Rent in this agent's listing");

  const chip = page.locator(`.ctl.notify[data-nid="${id}"]`);
  await chip.click();
  await expect(page.locator(".cpop.npop")).toBeVisible();
  const streamRow = page.locator('.cpop.npop .nopt[data-wk="stream"]');
  test.skip(await streamRow.count() === 0, "no future Streaming row offered for this film");
  await expect(streamRow).toBeEnabled();
  await streamRow.click();

  const stillDark = page.locator(`.ctl.notify[data-nid="${id}"]`);
  await expect(stillDark).not.toHaveClass(/recent/);
});

// ---- CAS-494: a film sitting in MORE THAN ONE window at once ----------------------------------------------
// TEST 5 (tmdb_id 999000005) carries all five windows simultaneously — unrealistic, but it is exactly what
// exposed the primaryStatus-only bug, so the fixture is reused rather than replaced (per the ticket's own note).
const STREAM_FIXTURE_ID = 999000005; // "TEST 5 — Streaming": upcoming, in_cinema, pvod, rental, included_streaming
const CINEMA_ONLY_FIXTURE_ID = 999000002; // "TEST 2 — In cinemas": upcoming, in_cinema only

async function gotoAsFixtureTester(page){
  await page.route("**/config.js", route => route.fulfill({ status: 404, body: "" }));
  await page.goto("/index.html?fixtures=1");
  await page.evaluate(() => { try{ localStorage.clear(); }catch(e){} });
  await page.goto("/index.html?fixtures=1");
  await page.waitForFunction(() => typeof flowStart === "function" && Array.isArray(MOVIES));
  await page.evaluate((email) => {
    window.CascadeAuth = window.CascadeAuth || {};
    window.CascadeAuth.user = { email };
  }, "lee+c1@codynamics.com.au");
  await page.evaluate(() => window.CascadeFixtures.maybeLoadFixtures());
}

// Similar to CAS-491's addBroadStreamingCascade, but a CINEMA-kind agent — the only kind whose own window
// list carries all four Watch levels (in_cinema plus premium/rent/stream, folded in notify-only per CAS-474)
// without duplication. Without an active cascade, watchLevelsFor(id) has no kind to read and falls back to
// BOTH kinds' window lists, which duplicates premium/rent/stream (they're in both) — a pre-existing quirk of
// that no-agent fallback, out of CAS-494's scope, but one that would make toggleFilmOpt's own tick/untick
// cascade (CAS-349) misfire in these tests if left unset.
async function addCinemaCascade(page){
  return page.evaluate(() => {
    const c = { id: cascadeNewId(), name: "Cinema", kind: "cinema", status: [], genre: [], age: [], lang: [] };
    normCascade(c);
    c.order = cascades.length;
    cascades.push(c);
    recomputeFound();
    setActive(c.id);
    return c.id;
  });
}

test("CAS-494: a film on Streaming AND still in cinema glows when Streaming is ticked", async ({ page }) => {
  await gotoAsFixtureTester(page);
  await addCinemaCascade(page);

  await page.evaluate((id) => window.toggleFilmOpt(id, "stream"), STREAM_FIXTURE_ID);

  const st = await page.evaluate((id) => filmNotifyState(id), STREAM_FIXTURE_ID);
  expect(st.current).toBe(true);
});

test("CAS-494: the same multi-window film ALSO glows when In cinema is ticked, not only its primary window", async ({ page }) => {
  await gotoAsFixtureTester(page);
  await addCinemaCascade(page);

  // primaryStatus() for TEST 5 resolves to "in_cinema" (cinema outranks a simultaneous home window per
  // CAS-395), so this row was already the one the old rung-only check happened to pass — kept as a control.
  await page.evaluate((id) => window.toggleFilmOpt(id, "in_cinema"), STREAM_FIXTURE_ID);

  const st = await page.evaluate((id) => filmNotifyState(id), STREAM_FIXTURE_ID);
  expect(st.current).toBe(true);
});

test("CAS-494: a tick matching none of the film's current windows still does not glow", async ({ page }) => {
  await gotoAsFixtureTester(page);
  await addCinemaCascade(page);

  // TEST 2 is only ever in_cinema (plus the un-tickable upcoming rung) — Streaming is neither current nor
  // spent for it, so ticking it must not glow the control.
  await page.evaluate((id) => window.toggleFilmOpt(id, "stream"), CINEMA_ONLY_FIXTURE_ID);

  const st = await page.evaluate((id) => filmNotifyState(id), CINEMA_ONLY_FIXTURE_ID);
  expect(st.current).toBe(false);
});

test("CAS-494: ticking an already-true window glows immediately, un-ticking removes it immediately", async ({ page }) => {
  await gotoAsFixtureTester(page);
  await addCinemaCascade(page);

  const before = await page.evaluate((id) => filmNotifyState(id).current, STREAM_FIXTURE_ID);
  expect(before).toBe(false);

  await page.evaluate((id) => window.toggleFilmOpt(id, "stream"), STREAM_FIXTURE_ID);
  const afterTick = await page.evaluate((id) => filmNotifyState(id).current, STREAM_FIXTURE_ID);
  expect(afterTick).toBe(true);

  await page.evaluate((id) => window.toggleFilmOpt(id, "stream"), STREAM_FIXTURE_ID);
  const afterUntick = await page.evaluate((id) => filmNotifyState(id).current, STREAM_FIXTURE_ID);
  expect(afterUntick).toBe(false);
});
