// CAS-566: retired the built-in "All" cascade — the app now opens on the first agent instead, and the
// deck's leftmost card is that agent. This drives AC1 (boot lands on the first agent, deck matches, no
// All card anywhere — and, incidentally, AC4's "__all__" backward-compat path) and AC3 (deleting the open
// agent lands on the new first agent, or the zero-agent state once the last one is gone).
import { test, expect } from "@playwright/test";
import { toShortlist, shortlistCards, pickCard, finishFlow, toListing } from "./helpers.mjs";

// Mirrors cas565.spec.mjs's addSecondAgent — a second agent from the deck's "New Agent" card stops at the
// Briefing hub instead of walking the splash flow, so it needs its own "Save agent" exit.
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

// Two real agents, first-created (cinema) then second (stream) — the second lands active, same as
// cas565.spec.mjs's twoAgents(). Returns [firstId, secondId].
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

async function deleteActiveAgent(page){
  page.once("dialog", d => d.accept());
  await page.locator(".dcard.is-centre.is-active").locator('[data-act="edit"]').click();
  await expect(page.locator(".osdel")).toBeVisible();
  await page.locator(".osdel").click();
}

test("CAS-566/AC1+AC4: boot lands on the first agent, the deck's first card matches, and there is no All card", async ({ page }) => {
  const [firstId, secondId] = await twoAgents(page);
  expect(await page.evaluate(() => activeId)).toBe(secondId);   // sanity: the just-made agent is open

  // AC4: an existing install's stored cascade_active pointing at the retired "__all__" sentinel must be
  // treated as absent, not as a broken id — same code path a deleted agent's stale pointer takes (R7).
  await page.evaluate(() => localStorage.setItem("cascade_active", "__all__"));

  // A raw reload, not freshApp()/toShortlist() — both clear storage, which would erase the two agents just
  // made. This is the real boot path: index.html loads, the top-of-file activeId computation runs.
  await page.goto("/index.html");
  await page.waitForFunction(() => typeof flowStart === "function" && Array.isArray(MOVIES));

  expect(await page.evaluate(() => activeId)).toBe(firstId);
  expect(await page.evaluate(() => cascades[0].id)).toBe(firstId);   // matches Manage Agents order (AC7)

  const firstCard = page.locator("#cascStrip .dcard").first();
  await expect(firstCard).toHaveClass(/is-active/);
  await expect(firstCard).toHaveClass(/is-centre/);
  expect(await firstCard.getAttribute("data-id")).toBe(firstId);

  await expect(page.locator(".dcard.all")).toHaveCount(0);
});

test("CAS-566/AC3: deleting the open agent lands on the new first agent, then on the zero-agent state", async ({ page }) => {
  const [firstId, secondId] = await twoAgents(page);
  expect(await page.evaluate(() => activeId)).toBe(secondId);

  // Delete the open (second) agent — the survivor, firstId, is the new cascades[0].
  await deleteActiveAgent(page);
  await expect(page.locator("#onbStep")).not.toHaveClass(/open/);
  expect(await page.evaluate(() => activeId)).toBe(firstId);
  expect(await page.evaluate(() => cascades.length)).toBe(1);
  const survivorCard = page.locator("#cascStrip .dcard").first();
  await expect(survivorCard).toHaveClass(/is-active/);
  expect(await survivorCard.getAttribute("data-id")).toBe(firstId);

  // Delete the last agent — AC2's zero-agent state: nothing throws, no films listed, the starter panel and
  // New Agent card show.
  await deleteActiveAgent(page);
  await expect(page.locator("#onbStep")).not.toHaveClass(/open/);
  expect(await page.evaluate(() => activeId)).toBeNull();
  expect(await page.evaluate(() => cascades.length)).toBe(0);
  await expect(page.locator("#groups .card, #groups .stub")).toHaveCount(0);
  await expect(page.locator(".cascstart")).toBeVisible();
  await expect(page.locator(".dcard.new")).toBeVisible();
  await expect(page.locator(".dcard.all")).toHaveCount(0);
});
