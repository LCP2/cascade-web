// CAS-385: the gate is a smoke test — build + boot + this fixed, small set of critical-path checks. It
// replaces the per-ticket casNNN.spec.mjs specs (each pinned to one commit's exact copy/DOM, so a later
// approved UI change broke the gate for a reason that had nothing to do with a real regression) and the
// older spec-conformance/counts suites (same brittleness, just not filed under one ticket number).
//
// Every check here asserts BEHAVIOUR — a flow completes, a count moves, a control does the thing it says —
// never exact copy, colours or DOM shape, so a future approved UI change cannot turn this gate red. The five
// flows are the ones CAS-385 names as the app's core: app loads, onboarding builds a real agent roster,
// recommendations render, a film's Watched control works, and the my-services filter actually filters.
import { test, expect } from "@playwright/test";
import {
  freshApp, toShortlist, shortlistCards, finishFlow, toListing, settleListing, ctaLocator, sectionCounts,
} from "./helpers.mjs";

// Mirrors cas565.spec.mjs's addSecondAgent — a second agent made from the deck's "New Agent" card stops at
// the Briefing hub instead of walking the splash flow, so it needs its own "Save agent" exit.
async function addSecondAgent(page, kind){
  const newCard = page.locator(".dcard.new");
  await newCard.locator(".dc-name").click();
  await expect(newCard).toHaveClass(/is-centre/);
  await newCard.locator('button[data-act="new"]').click();
  await expect(page.locator(".priobtn").first()).toBeVisible();
  await page.locator(kind === "stream" ? ".priobtn.str" : ".priobtn.cin").click();
  await expect(page.locator(".scard").first()).toBeVisible();
  const cards = await shortlistCards(page);
  const card = page.locator(".scard", { has: page.locator(".sc-name", { hasText: cards[0].name }) }).first();
  await card.click();
  const saveBtn = page.locator(".osfoot .oscta", { hasText: "Save agent" });
  await expect(saveBtn).toBeVisible();
  await saveBtn.click();
  await expect(page.locator("#onbStep")).not.toHaveClass(/open/);
}

test("the app loads and onboarding renders", async ({ page }) => {
  await freshApp(page);
  await expect(page.locator("#splashCta")).toBeVisible();
  await page.locator("#splashCta").click();
  await expect(page.locator("#obWho")).toBeVisible();
});

// CAS-629: onboarding no longer sharpens one hand-named agent — it generates a whole roster from the
// briefing answers (buildOnbAgents) and commits it on entering "working" (Change E1). This replaces the
// old "type a name, expect it back" check with the same acceptance criterion CAS-629 itself states (AC1):
// a non-empty roster, every id distinct, every one a real Cascade — plus one of the two unconditional
// agents (onb_home fires for any roster, whatever the briefing answers were) actually landing by name.
test("onboarding commits a real, de-duplicated agent roster", async ({ page }) => {
  await toShortlist(page, "cinema");
  await finishFlow(page);
  await toListing(page);
  const roster = await page.evaluate(() => cascades.map(c => ({ id: c.id, name: c.name, sort: c.sort })));
  expect(roster.length).toBeGreaterThan(0);
  expect(new Set(roster.map(c => c.id)).size).toBe(roster.length);
  expect(roster.every(c => c.sort === "cascade")).toBe(true);
  expect(roster.map(c => c.name)).toContain("Watch at home");
});

test("recommendations render as a results list with items", async ({ page }) => {
  await toShortlist(page, "cinema");
  await finishFlow(page);
  await toListing(page);

  const rendered = await settleListing(page);
  expect(rendered).toBeGreaterThan(0);
});

test("a film card's Watched control lands an answer", async ({ page }) => {
  await toShortlist(page, "cinema");
  await finishFlow(page);
  await toListing(page);

  const first = page.locator("#groups .card").first();
  await expect(first).toBeVisible();
  await first.locator(".ctl.watch").click();
  const options = page.locator(".cpop .cseg .cl");
  await expect(options.first()).toBeVisible();
  await options.first().click();
  await expect.poll(() => page.evaluate(() => watched.size), { timeout: 10_000 }).toBeGreaterThan(0);
});

// CAS-647: opening Notify, Tags or Watched on a card left the card blank and cut the top of the list. The
// actual mechanism was a scroll drift (Chromium's silent reveal-scroll on focus, same cause as CAS-315's
// keepRowInPlace fix) rather than anything about a specific control's own state, so this checks the
// mechanism directly — scrollY unmoved and the card's own content still visible — across all three
// controls and the first/mid/last card, per the ticket's acceptance criteria.
test("opening Notify, Tags or Watched leaves the card rendered and scroll unmoved", async ({ page }) => {
  await toShortlist(page, "cinema");
  await finishFlow(page);
  await toListing(page);

  const cards = page.locator("#groups .card");
  const count = await cards.count();
  expect(count).toBeGreaterThan(2);
  const indices = [0, Math.floor(count / 2), count - 1];

  for(const i of indices){
    const card = cards.nth(i);
    await card.scrollIntoViewIfNeeded();
    const before = await page.evaluate(() => scrollY);
    for(const ctl of [".ctl.notify", ".ctl.casc", ".ctl.watch"]){
      await card.locator(ctl).click();
      await expect(card.locator(".titletext")).toBeVisible();
      expect(Math.abs((await page.evaluate(() => scrollY)) - before)).toBeLessThan(2);
      await page.keyboard.press("Escape");
      await expect(card.locator(".titletext")).toBeVisible();
      expect(Math.abs((await page.evaluate(() => scrollY)) - before)).toBeLessThan(2);
    }
  }
});

// CAS-649: CAS-644 made Moving the landing screen and dropped its back control, but #movingScreen wasn't
// added to the rule that pulls #agentsScreen/#yourMovies down below the sticky header — it rendered at
// inset:0, z-index:84, covering the header (z-index:30). A returning visitor landed on a screen with no
// navigation and no way out. This checks the actual failure mode: the header and its three chips are there
// and working the moment a cold load lands on Moving, not just that #movingScreen itself opened.
test("a cold load with onboarding seen shows the header, not just Moving", async ({ page }) => {
  await toShortlist(page, "cinema");
  await finishFlow(page);
  await toListing(page);

  await page.reload();
  await expect(page.locator("#movingScreen")).toHaveClass(/open/);
  await expect(page.locator("header")).toBeVisible();
  await expect(page.locator("#agentsBtn")).toBeVisible();
  await expect(page.locator("#moviesBtn")).toBeVisible();
  await expect(page.locator("#movingBtn")).toBeVisible();

  await page.locator("#moviesBtn").click();
  await expect(page.locator("#movingScreen")).not.toHaveClass(/open/);
  await expect(page.locator("#groups .card").first()).toBeVisible();

  await page.locator("#agentsBtn").click();
  await expect(page.locator("#agentsScreen")).toHaveClass(/open/);
});

// CAS-725: the Watch screen's tab strip is derived from which windows are switched on in Where & when, not
// a fixed three — this walks that path directly (enable Premium, place a film there, disable it again)
// rather than asserting the derivation's internals.
test("the Watch screen's tab strip follows the enabled watch windows", async ({ page }) => {
  await toShortlist(page, "cinema");
  await finishFlow(page);
  await toListing(page);

  await expect(page.locator(".wtabbtn", { hasText: "Premium" })).toHaveCount(0);

  await page.locator("#navMenuBtn").click();
  await page.locator("#navMenu .navitem", { hasText: "Where & when you'll watch" }).click();
  await expect(page.locator(".osh", { hasText: "Where & when you'll watch" })).toBeVisible();
  const premiumLane = page.locator(".wwlane", { has: page.locator(".wwn", { hasText: "Premium" }) });
  await premiumLane.locator(".agwt", { hasText: "Track" }).click();
  await expect(premiumLane).toHaveClass(/on/);
  await page.locator("#wwScreen .osback").click();
  await expect(page.locator("#wwScreen")).not.toHaveClass(/open/);

  const premiumTab = page.locator(".wtabbtn", { hasText: "Premium" });
  await expect(premiumTab).toBeVisible();

  // An upcoming film's Premium level can never already be spent (CAS-725's own WINDOW_RUNG says so), so
  // ticking one there is a reliable way to place a film at Premium without hunting for an eligible row.
  const card = page.locator('#groups .group[data-g="upcoming"] .card').first();
  await expect(card).toBeVisible();
  const cardId = await card.getAttribute("id");
  await card.locator(".ctl.notify").click();
  await page.locator('.nopt[data-wk="premium"]').click();
  await page.keyboard.press("Escape");

  await premiumTab.click();
  await expect(page.locator(`#${cardId}`)).toBeVisible();
  await page.locator(".wtabbtn", { hasText: "Streaming" }).click();
  await expect(page.locator(`#${cardId}`)).toHaveCount(0);

  await page.locator("#navMenuBtn").click();
  await page.locator("#navMenu .navitem", { hasText: "Where & when you'll watch" }).click();
  await premiumLane.locator(".agwt", { hasText: "Track" }).click();
  await expect(premiumLane).not.toHaveClass(/on/);
  await page.locator("#wwScreen .osback").click();
  await expect(page.locator(".wtabbtn", { hasText: "Premium" })).toHaveCount(0);
});

// CAS-723: c.kind retires — every agent now watches every window enabled in Where & when, with no cinema/
// stream narrowing, so a "cinema" preset's listing carries a film's whole journey rather than losing it the
// moment it leaves cinemas. Premium is the only window off by default, so enabling it (the same path CAS-725's
// test above already drives) is what "every window enabled" means here.
test("an agent created with every window enabled lists films at rental or streaming too (CAS-723)", async ({ page }) => {
  await toShortlist(page, "cinema");
  await finishFlow(page);
  await toListing(page);

  await page.locator("#navMenuBtn").click();
  await page.locator("#navMenu .navitem", { hasText: "Where & when you'll watch" }).click();
  await expect(page.locator(".osh", { hasText: "Where & when you'll watch" })).toBeVisible();
  const premiumLane = page.locator(".wwlane", { has: page.locator(".wwn", { hasText: "Premium" }) });
  await premiumLane.locator(".agwt", { hasText: "Track" }).click();
  await expect(premiumLane).toHaveClass(/on/);
  await page.locator("#wwScreen .osback").click();
  await expect(page.locator("#wwScreen")).not.toHaveClass(/open/);

  await settleListing(page);
  const groups = await sectionCounts(page);
  expect(groups.some(g => (g.window === "rental" || g.window === "included_streaming") && g.count > 0),
    `no rental/included_streaming group in ${JSON.stringify(groups)}`).toBe(true);
});

test("'Only show films on my services' changes what a new agent finds", async ({ page }) => {
  // Every window a streaming agent lists (Premium/Rent/Streaming) is service-scoped, so switching the
  // filter on with no services named must drop the count — this exercises the real mechanism the switch
  // controls, not just its own visible state.
  // CAS-480: CAS-475 moved this switch out of the per-agent editor into one account-level spoke (top menu
  // -> My services), which only ever writes the global prefs.on. An open agent's OWN service scope is
  // fixed at the moment it was last saved (CAS-199) and does not follow prefs.on afterwards, so flipping
  // the switch while that agent's own listing is on screen has no visible effect.
  // CAS-566: this used to jump to the All view to read the switch's live effect — All is retired, and R3
  // means the only state that ever read prefs.on live (activeCascade() null) is now the zero-agent state,
  // which lists nothing. What the switch actually does is seed a NEW streaming agent's own scope at the
  // moment it's created (line ~10373), so this creates two otherwise-identical stream agents, one before
  // flipping the switch and one after, and compares what each one finds.
  await toShortlist(page, "stream");
  await finishFlow(page);
  await toListing(page);
  const before = await settleListing(page);
  expect(before).toBeGreaterThan(0);

  await page.locator("#navMenuBtn").click();
  await page.locator("#navMenu .navitem", { hasText: "My services" }).click();
  await expect(page.locator(".osh", { hasText: "My services" })).toBeVisible();

  await page.locator("#onbSvcOnly").click();
  await expect(page.locator("#onbSvcOnly")).toHaveClass(/on/);
  await ctaLocator(page).click();   // Done, back to the listing
  await expect(page.locator("#onbStep")).not.toHaveClass(/open/);

  await addSecondAgent(page, "stream");
  const after = await settleListing(page);
  expect(after, `before=${before} after=${after}`).toBeLessThan(before);
});
