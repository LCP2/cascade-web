// CAS-273: "Finish your agent" no longer rides above the listing.
import { test, expect } from "@playwright/test";
import { toShortlist, shortlistCards, pickCard, finishFlow, toListing, settleListing } from "./helpers.mjs";

async function toAgentListing(page, kind){
  await toShortlist(page, kind);
  const cards = await shortlistCards(page);
  await pickCard(page, cards[0].name);
  await finishFlow(page);
  await toListing(page);
}

for(const kind of ["cinema", "stream"]){
  test(`CAS-273: a ${kind} agent's listing carries no Finish-your-agent block`, async ({ page }) => {
    await toAgentListing(page, kind);
    await expect(page.locator("#listChrome")).not.toContainText(/Finish your agent/i);
    await expect(page.locator("#listChrome")).not.toContainText(/Add my services/i);
    await expect(page.locator("body")).not.toContainText(/Finish your agent/i);
  });
}

test("CAS-273: it does not come back on a second visit, which is when it used to appear", async ({ page }) => {
  await toAgentListing(page, "cinema");
  // Its trigger was visits >= 2 with services unset and films found — reload to satisfy exactly that.
  await page.reload();
  await settleListing(page);
  expect(await page.evaluate(() => visits), "this is the return visit its trigger waited for")
    .toBeGreaterThanOrEqual(2);
  expect(await page.evaluate(() => servicesPicked()), "services are still unset").toBe(false);
  await expect(page.locator("body")).not.toContainText(/Finish your agent/i);
});

test("CAS-273: the builder for it is gone, not merely unrendered", async ({ page }) => {
  await toAgentListing(page, "cinema");
  expect(await page.evaluate(() => typeof window.finishAgentHTML)).toBe("undefined");
});

test("CAS-273: the listing's own chrome still renders under it", async ({ page }) => {
  await toAgentListing(page, "cinema");
  // Removing the block must not take renderListChrome down with it.
  await expect(page.locator("#listChrome")).toBeAttached();
  const cards = await page.locator("#groups .card, #groups .stub").count();
  expect(cards, "the films the agent found are what the first screenful should hold").toBeGreaterThan(0);
});
