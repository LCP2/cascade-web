// CAS-500: Watch it / Lists / Watched are per-film, account-wide controls (Lee: "if I set watch it, lists or
// watched for a movie then I'm setting it for the movie everywhere, not for a single cascade"). The tick
// itself (notify[id].wins, film_watch on the server) was always account-wide storage — but watchLevelsFor()
// built its ROW SET from the ACTIVE cascade's own kind (cinema vs stream), and watchIsCurrent() resolved a
// film's current window against that same per-cascade kind restriction. A stream-kind agent's AGENT_WINDOWS
// carries no `in_cinema` key at all, so the very same film, ticked "In cinema", read set (green) from a
// cinema-kind agent and plain/unset from a stream-kind agent — exactly the "Anticipated" vs "Boys" symptom
// the ticket reports. See the CAS-500 comments on watchLevelsFor/watchIsCurrent/filmNotifyState.
//
// notifyChipHTML/listsChipHTML/watchChipHTML are the exact, single functions every card's control renders
// from (grep confirms no second copy), so calling them directly for one film id while a second agent is
// active is exactly what a real card for that film would show there — the only practical way to check this
// without contriving a fixture film that sits in more than one window at once.
import { test, expect } from "@playwright/test";
import { toShortlist, shortlistCards, pickCard, finishFlow, toListing, settleListing } from "./helpers.mjs";

// CAS-246: a second agent made from the deck's "New Agent" card is NOT the splash's linear flow — picking a
// shortlist card there stops at the Briefing hub (flowNext's flowNewAgent branch -> briefNewAgent()) instead
// of walking Mission/etc. and landing on the membership haul screen, so it needs its own "Save agent" exit,
// the same one cas477/cas478's own Edit Agent helpers use.
async function addSecondAgent(page, kind){
  await page.locator('.dcard.new button[data-act="new"]').click();
  await expect(page.locator(".priobtn").first()).toBeVisible();
  await page.locator(kind === "stream" ? ".priobtn.str" : ".priobtn.cin").click();
  await expect(page.locator(".scard").first()).toBeVisible();
  const cards = await shortlistCards(page);
  const card = page.locator(".scard", { has: page.locator(".sc-name", { hasText: cards[0].name }) }).first();
  await card.click();
  await expect(page.locator(".osh", { hasText: "Edit Agent" })).toBeVisible();
  await page.locator(".osfoot .oscta", { hasText: "Save agent" }).click();
  await expect(page.locator("#onbStep")).not.toHaveClass(/open/);
  await settleListing(page);
}

test("CAS-500: Watch it / Lists / Watched read the same for one film from a cinema agent and a stream agent", async ({ page }) => {
  await toShortlist(page, "cinema");
  const cinemaCards = await shortlistCards(page);
  await pickCard(page, cinemaCards[0].name);
  await finishFlow(page);
  await toListing(page);

  // A film currently In cinema — the exact case the ticket reports (The Odyssey), since a stream-kind agent's
  // own AGENT_WINDOWS list has no in_cinema row at all for the old, per-cascade-scoped code to find.
  const card = page.locator('#groups .group[data-g="in_cinema"] .card').first();
  test.skip((await card.count()) === 0, "no film currently In cinema in this agent's listing");
  const id = Number((await card.getAttribute("id")).replace(/^card-/, ""));

  // Watch it: tick "In cinema" for this film from the cinema agent.
  await page.locator(`.ctl.notify[data-nid="${id}"]`).click();
  const inCinemaRow = page.locator('.cpop.npop .nopt[data-wk="in_cinema"]');
  await expect(inCinemaRow).toBeVisible();
  if(!(await inCinemaRow.evaluate(el => el.classList.contains("on")))) await inCinemaRow.click();
  await expect(inCinemaRow).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.press("Escape");
  // Read via notifyChipHTML(id) itself, not the live DOM node's outerHTML — the browser re-serialises
  // attributes/self-closing tags on the way out (e.g. "/>" becomes "></circle>"), which would make a
  // byte-for-byte comparison against the raw function string fail on formatting alone, not real state.
  const notifyChipBefore = await page.evaluate(id => notifyChipHTML(id), id);

  // Lists: add it to a new list from the cinema agent.
  await page.locator(`.ctl.casc[data-kid="${id}"]`).click();
  await page.locator('.cpop.lpop [data-role="newlist"]').click();
  await page.locator(".cpop.lpop .newlistin").fill("CAS-500 Test List");
  await page.locator(".cpop.lpop .newlistin").press("Enter");
  await expect(page.locator(`.ctl.casc[data-kid="${id}"] .clab`)).toHaveText("Lists · 1");
  const listsChipBefore = await page.evaluate(id => listsChipHTML(id), id);
  await page.keyboard.press("Escape");   // close the Lists popup before opening the next control

  // Watched: mark it Liked from the cinema agent. Answering collapses the whole card to its stub (CAS-64) —
  // a summary row with no .ctl buttons at all — so the "before" state is read from watchChipHTML(id) itself
  // rather than a DOM node that no longer exists, same as the "after" read below.
  await page.locator(`#card-${id} .ctl.watch`).click();
  await page.locator(`#card-${id} .cpop .cseg .cl`).first().click();
  const watchChipBefore = await page.evaluate(id => watchChipHTML(id), id);

  const levelsBefore = await page.evaluate(id => watchLevelsFor(id), id);

  // Switch to a brand-new STREAM-kind agent — a different active cascade, same account.
  await addSecondAgent(page, "stream");

  const [notifyChipAfter, listsChipAfter, watchChipAfter, levelsAfter] = await page.evaluate(id => (
    [notifyChipHTML(id), listsChipHTML(id), watchChipHTML(id), watchLevelsFor(id)]
  ), id);

  // AC1/AC2: byte-identical button state for all three controls, no reload in between.
  expect(notifyChipAfter).toBe(notifyChipBefore);
  expect(listsChipAfter).toBe(listsChipBefore);
  expect(watchChipAfter).toBe(watchChipBefore);
  // AC3: the Watch it panel's offered rows (including "In cinema", which the old stream-kind AGENT_WINDOWS
  // list didn't carry at all) are the same set wherever it opens.
  expect(levelsAfter).toEqual(levelsBefore);
});

// Lee's revised diagnosis (Jira comment, 2026-08-14): green/set and the gold glow are two DIFFERENT
// questions that the pre-fix code collapsed onto one predicate (st.current) — "green" means a request
// exists (any level ticked, arrived or not), "glow" means the request is already satisfied (a ticked level
// is one the film currently occupies). A film with only a future level ticked must read green with no glow;
// a film with a current level ticked reads green AND glowing. The first cas500 test above only exercises a
// film that's already In cinema (current from the moment it's ticked), so it can't catch this — every
// combination below is needed.
test("CAS-500: the Watch it button is green whenever any level is ticked, and glows only when a ticked level is current", async ({ page }) => {
  await toShortlist(page, "cinema");
  const cinemaCards = await shortlistCards(page);
  await pickCard(page, cinemaCards[0].name);
  await finishFlow(page);
  await toListing(page);

  // curId: a film In cinema right now (ticking it is satisfied immediately). futId: a film still Upcoming
  // (ticking "In cinema" on it is a real level, per CAS-280's ladder, but one it hasn't reached yet).
  const curCard = page.locator('#groups .group[data-g="in_cinema"] .card').first();
  const futCard = page.locator('#groups .group[data-g="upcoming"] .card').first();
  test.skip((await curCard.count()) === 0 || (await futCard.count()) === 0,
    "need one In-cinema film and one Upcoming film in this agent's listing");
  const curId = Number((await curCard.getAttribute("id")).replace(/^card-/, ""));
  const futId = Number((await futCard.getAttribute("id")).replace(/^card-/, ""));

  // Combination 1 — no ticks on either film: plain, no glow.
  let [curChip, futChip] = await page.evaluate(([c, f]) => [notifyChipHTML(c), notifyChipHTML(f)], [curId, futId]);
  for(const chip of [curChip, futChip]){
    expect(chip).toContain(" dim");
    expect(chip).not.toContain("recent");
  }

  // Combination 2 — tick "In cinema" on the UPCOMING film, a level it hasn't reached: green (not dim), but
  // no glow. This is the exact repro from Lee's comment: a ticked-but-not-arrived level must not read plain.
  await page.evaluate(f => toggleFilmOpt(f, "in_cinema"), futId);
  futChip = await page.evaluate(f => notifyChipHTML(f), futId);
  expect(futChip).not.toContain(" dim");
  expect(futChip).not.toContain("recent");

  // Combination 3 — tick "In cinema" on the film that's actually in cinemas now: green AND glowing. CAS-349's
  // auto-tick cascade also ticks Premium/Rent/Streaming below it (none of which are current), so this doubles
  // as proof the glow comes from watchIsCurrent's `.some()` match on the one current level, not from every
  // ticked level being current.
  await page.evaluate(c => toggleFilmOpt(c, "in_cinema"), curId);
  curChip = await page.evaluate(c => notifyChipHTML(c), curId);
  expect(curChip).not.toContain(" dim");
  expect(curChip).toContain("recent");

  // Combination 4 — both readings hold from a second, stream-kind agent with no reload: the green/glow split
  // is per-film and account-wide, exactly like the byte-identical panel rows the first test checks.
  await addSecondAgent(page, "stream");
  const [curChip2, futChip2] = await page.evaluate(([c, f]) => [notifyChipHTML(c), notifyChipHTML(f)], [curId, futId]);
  expect(curChip2).toBe(curChip);
  expect(futChip2).toBe(futChip);
});
