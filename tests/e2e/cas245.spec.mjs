// CAS-245 / CAS-349: the per-film Watch panel — CAS-245 built it as a plain Notify row-per-window control;
// CAS-349 retaxonomized it (same `.ctl.notify` / `openNotifyPanel` / `.nopt` machinery) into the Watch
// control: only the levels a film can actually be WATCHED at (no Upcoming), greyed rather than hidden once
// passed, an auto-tick cascade, mutually-exclusive streaming tiers, and a bottom "Never" row. This file now
// tests that shape; the close-button handedness half (CAS-245's own contrast with Watched) is unchanged.
import { test, expect } from "@playwright/test";
import { toShortlist, shortlistCards, pickCard, finishFlow, toListing, settleListing } from "./helpers.mjs";

async function toFirstCard(page, kind = "cinema"){
  await toShortlist(page, kind);
  const cards = await shortlistCards(page);
  await pickCard(page, cards[0].name);
  await finishFlow(page);
  await toListing(page);
  await settleListing(page);
  const card = page.locator("#groups .card").first();
  await expect(card).toBeVisible();
  return card;
}

test("CAS-349: the Watch panel offers only levels the film can be watched at, never Upcoming", async ({ page }) => {
  const card = await toFirstCard(page, "cinema");
  await card.locator(".ctl.notify").click();
  const pop = card.locator(".cpop.npop");
  await expect(pop).toBeVisible();

  const rows = await pop.locator(".nopt").allTextContents();
  const joined = rows.join(" | ");
  expect(joined, "Upcoming has no watch level of its own and must never appear here").not.toMatch(/Upcoming/);
  // A cinema agent's own ladder tops out at In-Cinema; it never reaches into the streaming lane.
  expect(joined, "a cinema agent must not be offered a home level").not.toMatch(/Premium|Standard Rent|Streaming/);
  // Never is always offered, whatever the film's own journey looks like.
  expect(joined, "Never must always be on the panel").toMatch(/Never/);
});

test("CAS-349: everything the agent has switched on starts ticked for the film", async ({ page }) => {
  const card = await toFirstCard(page, "stream");
  await card.locator(".ctl.notify").click();
  const pop = card.locator(".cpop.npop");
  // Premium is off for a new streaming agent (CAS-243) — Rent and Streaming are its live levels.
  const rows = await pop.locator(".nopt").allTextContents();
  test.skip(!rows.join(" | ").match(/Standard Rent/),
    "this agent's first card has already passed Rent (CAS-280/CAS-349 greying)");
  const rent = pop.locator('.nopt[data-wk="rent"]');
  await expect(rent).toHaveAttribute("aria-pressed", "true");
  const premium = pop.locator(".nopt", { hasText: "Premium" });
  await expect(premium, "Premium is off for a fresh streaming agent, so it must not be offered").toHaveCount(0);
});

test("CAS-349: a level the film has already passed is shown, greyed, and cannot be picked", async ({ page }) => {
  await toShortlist(page, "stream");
  const cards = await shortlistCards(page);
  await pickCard(page, cards[0].name);
  await finishFlow(page);
  await toListing(page);
  await settleListing(page);
  // A film already streaming has necessarily passed Rent (and Premium, if it were tracked) — picking from
  // this specific section makes the greying deterministic rather than depending on which film sorts first.
  const streamedCard = page.locator('#groups .group[data-g="included_streaming"] .card').first();
  test.skip(await streamedCard.count() === 0, "this agent has no film already streaming to test against");
  const id = Number((await streamedCard.getAttribute("id")).replace("card-", ""));
  const spentKeys = await page.evaluate(i => watchLevelsFor(i).filter(l => l.spent).map(l => l.key), id);
  expect(spentKeys, "a streaming film must have passed Rent").toContain("rent");

  await streamedCard.scrollIntoViewIfNeeded();
  await streamedCard.locator(".ctl.notify").click();
  const pop = page.locator(`#${await streamedCard.getAttribute("id")} .cpop.npop`);
  for(const key of spentKeys){
    const row = pop.locator(`.nopt[data-wk="${key}"]`).first();
    await expect(row).toHaveClass(/spent/);
    await expect(row).toBeDisabled();
    const before = await row.getAttribute("aria-pressed");
    await row.click({ force: true });
    // A disabled button cannot fire its click handler — nothing about the row changes.
    await expect(row).toHaveAttribute("aria-pressed", before);
  }
  // The film's OWN level (Streaming) is current, not spent, and stays interactive.
  const streamRow = pop.locator('.nopt[data-tier="must"]');
  await expect(streamRow).not.toHaveClass(/spent/);
});

test("CAS-349: ticking In-Cinema/Premium/Rent auto-ticks every enabled level down to Streaming", async ({ page }) => {
  const card = await toFirstCard(page, "stream");
  const id = Number((await card.getAttribute("id")).replace("card-", ""));
  await card.locator(".ctl.notify").click();
  const pop = card.locator(".cpop.npop");
  const rent = pop.locator('.nopt[data-wk="rent"]');
  test.skip(!(await rent.count()) || (await rent.getAttribute("class") || "").includes("spent"),
    "this agent's first card has no live Rent level to cascade from");

  // Start from both off, so ticking Rent is unambiguously the cascade's doing, not a pre-existing default.
  await page.evaluate(i => { const e = entryFor(i); e.wins = { rent: false, stream: false }; saveNotify(); }, id);
  await card.locator(".ctl.notify").click();          // reopen with the cleared state rendered
  await card.locator(".ctl.notify").click();
  await rent.click();

  const state = await page.evaluate(i => ({
    rent: (notify[i].wins || {}).rent, stream: (notify[i].wins || {}).stream, tier: notify[i].streamTier,
  }), id);
  expect(state.rent, "Rent itself should be ticked").toBe(true);
  expect(state.stream, "Streaming should be auto-ticked too — it's downstream of Rent").toBe(true);
  expect(state.tier, "the auto-tick lands on the Must Watch tier").toBe("must");

  await expect(pop.locator('.nopt[data-wk="rent"]')).toHaveAttribute("aria-pressed", "true");
  await expect(pop.locator('.nopt[data-tier="must"]')).toHaveAttribute("aria-pressed", "true");
});

test("CAS-349: the three streaming tiers are mutually exclusive", async ({ page }) => {
  const card = await toFirstCard(page, "stream");
  const id = Number((await card.getAttribute("id")).replace("card-", ""));
  await card.locator(".ctl.notify").click();
  const pop = card.locator(".cpop.npop");
  const must = pop.locator('.nopt[data-tier="must"]'), b = pop.locator('.nopt[data-tier="b"]');
  test.skip(!(await must.count()), "this agent's first card has no live Streaming level");

  await must.click();
  await expect(must).toHaveAttribute("aria-pressed", "true");
  await b.click();
  await expect(b, "picking B-tier must switch off Must Watch, not add to it").toHaveAttribute("aria-pressed", "true");
  await expect(must).toHaveAttribute("aria-pressed", "false");
  const tier = await page.evaluate(i => notify[i].streamTier, id);
  expect(tier).toBe("b");
});

test("CAS-349: Never clears the film's future ticks and blocks it, the same flag Won't Watch always used", async ({ page }) => {
  const card = await toFirstCard(page, "stream");
  const id = Number((await card.getAttribute("id")).replace("card-", ""));
  await card.locator(".ctl.notify").click();
  const pop = card.locator(".cpop.npop");
  await pop.locator('.nopt[data-wk="never"]').click();
  await settleListing(page);

  const state = await page.evaluate(i => ({ opinion: opinionOf(i), blocked: blocked.has(i) }), id);
  expect(state.opinion).toBe("notfor");
  expect(state.blocked).toBe(true);
  // Never folds the card to its stub, exactly like every other opinion answer.
  await expect(page.locator(`#groups .stub[id="card-${id}"]`)).toHaveCount(1);
});

test("CAS-245: the close sits on the LEFT and points RIGHT, the mirror of Watched", async ({ page }) => {
  const card = await toFirstCard(page, "cinema");

  await card.locator(".ctl.notify").click();
  const notifyGeom = await card.locator(".cpop.npop").evaluate(pop => {
    const close = pop.querySelector(".cclose"), body = pop.querySelector(".nopts");
    return { close: close.getBoundingClientRect().left, body: body.getBoundingClientRect().left,
             rotate: getComputedStyle(close.querySelector("svg")).transform };
  });
  expect(notifyGeom.close, "the Watch close must be left of its options").toBeLessThan(notifyGeom.body);
  expect(notifyGeom.rotate, "a down chevron must be rotated to point somewhere").not.toBe("none");

  // …and the Watched panel is the other way round, which is the contrast the ticket asks for.
  await page.keyboard.press("Escape");
  await card.locator(".ctl.watch").click();
  const watchGeom = await card.locator(".cpop").evaluate(pop => {
    const close = pop.querySelector(".cclose"), body = pop.querySelector(".csegs");
    return { close: close.getBoundingClientRect().left, body: body.getBoundingClientRect().left };
  });
  expect(watchGeom.close, "the Watched close must be right of its options").toBeGreaterThan(watchGeom.body);
});

// CAS-245's own version of this test opted a film INTO a window the agent itself didn't watch — the honest
// thing for a plain Notify toggle to allow. CAS-349 explicitly reverses that for Watch: "show ONLY the
// levels the agent/cascade is configured to track". Premium is off for a fresh streaming agent (CAS-243), so
// it must be ABSENT from the panel, full stop — there is no per-film opt-in around that any more.
test("CAS-349: a level the agent does not track does not appear at all", async ({ page }) => {
  const card = await toFirstCard(page, "stream");
  const id = Number((await card.getAttribute("id")).replace("card-", ""));
  const tracked = await page.evaluate(i => watchLevelsFor(i).map(l => l.key), id);
  expect(tracked, "Premium must not be one of a fresh streaming agent's levels").not.toContain("premium");

  await card.locator(".ctl.notify").click();
  const premium = card.locator(".cpop.npop .nopt", { hasText: "Premium" });
  await expect(premium).toHaveCount(0);
});
