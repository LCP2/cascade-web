// CAS-501: the Agents screen row gets two new tap targets — the body (icon/name/summary/count) opens that
// agent's film list, and a new Edit button opens its edit screen — while the drag handle and the Learning
// chip keep doing exactly what they already did. All four have to coexist on the same row without one
// swallowing another's tap, so this drives each control by its own real pointer interaction rather than
// calling the underlying functions directly (helpers.mjs's own rule — see its file comment).
import { test, expect } from "@playwright/test";
import { toShortlist, shortlistCards, pickCard, finishFlow, toListing } from "./helpers.mjs";

// Mirrors cas500.spec.mjs's addSecondAgent — a second agent from the deck's "New Agent" card stops at the
// Briefing hub instead of walking the splash flow, so it needs its own "Save agent" exit.
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
}

/** Two real agents, cinema then stream — enough to tell rows apart and to have something to drag. Returns
 * their ids in creation order. */
async function twoAgents(page){
  await toShortlist(page, "cinema");
  const cinemaCards = await shortlistCards(page);
  await pickCard(page, cinemaCards[0].name);
  await finishFlow(page);
  await toListing(page);
  const firstId = await page.evaluate(() => activeId);
  await addSecondAgent(page, "stream");
  const secondId = await page.evaluate(() => activeId);
  return [firstId, secondId];
}

test("CAS-501: tapping a row's body opens that agent's film list", async ({ page }) => {
  const [firstId, secondId] = await twoAgents(page);
  expect(await page.evaluate(() => activeId)).toBe(secondId);   // the newly-made agent is the active one

  await page.locator("#agentsBtn").click();
  await expect(page.locator("#agentsScreen")).toHaveClass(/open/);

  // firstId's row is the non-active one — tap its name to open it.
  const row = page.locator(`.agrow[data-id="${firstId}"]`);
  await row.locator(".agname").click();

  await expect(page.locator("#agentsScreen")).not.toHaveClass(/open/);
  expect(await page.evaluate(() => activeId)).toBe(firstId);
});

test("CAS-501: tapping Edit on a row opens that agent's edit screen", async ({ page }) => {
  const [firstId] = await twoAgents(page);

  await page.locator("#agentsBtn").click();
  await expect(page.locator("#agentsScreen")).toHaveClass(/open/);

  const row = page.locator(`.agrow[data-id="${firstId}"]`);
  await row.locator(".ag-edit").click();

  await expect(page.locator(".osh", { hasText: "Edit Agent" })).toBeVisible();
  await expect(page.locator("#agentsScreen")).not.toHaveClass(/open/);
  // It opened THAT row's agent, not whichever happened to be active.
  expect(await page.evaluate(() => onbFlow.draft && onbFlow.draft.id)).toBe(firstId);
});

test("CAS-501: dragging the grip reorders and never opens an agent", async ({ page }) => {
  const [, secondId] = await twoAgents(page);   // secondId is active

  await page.locator("#agentsBtn").click();
  await expect(page.locator("#agentsScreen")).toHaveClass(/open/);

  const rows = page.locator("#agList .agrow");
  const before = await rows.evaluateAll(els => els.map(e => e.dataset.id));
  expect(before.length).toBe(2);

  const grip = rows.nth(1).locator(".aggrip");
  const gripBox = await grip.boundingBox();
  const topRowBox = await rows.nth(0).boundingBox();
  await page.mouse.move(gripBox.x + gripBox.width / 2, gripBox.y + gripBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(topRowBox.x + topRowBox.width / 2, topRowBox.y + 4, { steps: 8 });
  await page.mouse.up();

  const after = await rows.evaluateAll(els => els.map(e => e.dataset.id));
  expect(after).toEqual([...before].reverse());   // the two rows swapped
  // The drag never read as a tap: still on the Agents screen, still the same active agent.
  await expect(page.locator("#agentsScreen")).toHaveClass(/open/);
  expect(await page.evaluate(() => activeId)).toBe(secondId);
});

test("CAS-501: tapping the Learning chip still opens review, not the agent", async ({ page }) => {
  const [firstId, secondId] = await twoAgents(page);   // secondId is active

  await page.locator("#agentsBtn").click();
  await expect(page.locator("#agentsScreen")).toHaveClass(/open/);

  const row = page.locator(`.agrow[data-id="${firstId}"]`);
  await row.locator(".ag-learn").click();

  await expect(page.locator("#reviewScreen")).toHaveClass(/open/);
  // Review opened for the row it was pressed on, not the active agent — and nothing navigated away.
  expect(await page.evaluate(() => reviewAgentId)).toBe(firstId);
  expect(await page.evaluate(() => activeId)).toBe(secondId);
});

test("CAS-501: the row body, count and Edit button don't overlap at iPhone width", async ({ page }) => {
  // The suite's default viewport (390x844, playwright.config.mjs) IS the iPhone reference width.
  await twoAgents(page);
  await page.locator("#agentsBtn").click();
  await expect(page.locator("#agentsScreen")).toHaveClass(/open/);

  const rows = page.locator("#agList .agrow");
  const n = await rows.count();
  for(let i = 0; i < n; i++){
    const row = rows.nth(i);
    const rowBox = await row.boundingBox();
    const countBox = await row.locator(".agcount").boundingBox();
    const editBox = await row.locator(".ag-edit").boundingBox();
    // Edit sits clear of the count, and neither spills outside the row's own box.
    expect(countBox.x + countBox.width).toBeLessThanOrEqual(editBox.x + 1);
    expect(editBox.x + editBox.width).toBeLessThanOrEqual(rowBox.x + rowBox.width + 1);
  }
  // No control forced the screen wider than the viewport.
  const overflowing = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
  expect(overflowing).toBe(false);
});
