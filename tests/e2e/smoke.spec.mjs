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
  freshApp, toShortlist, shortlistCards, finishFlow, toListing, settleListing, ctaLocator,
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
