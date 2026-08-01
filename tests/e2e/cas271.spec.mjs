// CAS-271: the × on an agent card is gone. It never closed anything — it selected All.
import { test, expect } from "@playwright/test";
import { toShortlist, shortlistCards, pickCard, finishFlow, toListing } from "./helpers.mjs";

async function toAgentListing(page, kind){
  await toShortlist(page, kind);
  const cards = await shortlistCards(page);
  await pickCard(page, cards[0].name);
  await finishFlow(page);
  await toListing(page);
  await expect(page.locator(".dcard.is-active").first()).toBeVisible();
}

test("CAS-271: no agent card carries a Close control", async ({ page }) => {
  await toAgentListing(page, "cinema");
  await expect(page.locator('.dcard [data-act="close"]')).toHaveCount(0);
  await expect(page.locator('.dcard [aria-label="Close this Cascade"]')).toHaveCount(0);
  // The × glyph itself is gone from the control row — an × on a thing you built reads as "delete".
  const acts = await page.locator(".dcard.is-active .dc-acts").first().textContent();
  expect(acts, `the control row reads "${acts}"`).not.toContain("×");
});

test("CAS-271: the handler is gone too, not just the button", async ({ page }) => {
  await toAgentListing(page, "cinema");
  expect(await page.evaluate(() => typeof window.closeCascade)).toBe("undefined");
});

test("CAS-271: the controls that ARE real actions survive", async ({ page }) => {
  await toAgentListing(page, "cinema");
  const row = page.locator(".dcard.is-active .dc-acts").first();
  await expect(row.locator('[data-act="edit"]')).toHaveCount(1);
  await expect(row.locator('[data-act="search"]')).toHaveCount(1);
});

test("CAS-271: leaving an agent is still one gesture — select All", async ({ page }) => {
  await toAgentListing(page, "cinema");
  const agentId = await page.evaluate(() => activeId);
  await page.evaluate(() => deckGo(0, false));
  await expect(page.locator(".dcard.all.is-centre")).toBeVisible();
  await page.locator(".dcard.all").first().click();
  await expect.poll(() => page.evaluate(() => activeId)).not.toBe(agentId);
  expect(await page.evaluate(() => activeId === ALL_ID)).toBe(true);
});
