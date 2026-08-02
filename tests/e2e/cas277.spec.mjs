// CAS-277 stacked the per-card controls vertically. CAS-304 (Lee's 0.8.3 review) reverted that call — the
// row is back — so the stacking assertions this file made are gone; row-layout coverage now lives in
// cas304.spec.mjs. What survives here is the one thing CAS-277 also had to prove and still has to hold:
// the panels still open and still anchor to the row, whatever the row's own layout is.
import { test, expect } from "@playwright/test";
import { toShortlist, shortlistCards, pickCard, finishFlow, toListing } from "./helpers.mjs";

async function toAgentListing(page){
  await toShortlist(page, "stream");
  const cards = await shortlistCards(page);
  await pickCard(page, cards[0].name);
  await finishFlow(page);
  await toListing(page);
  await expect(page.locator("#groups .card .actions").first()).toBeVisible();
}

test("CAS-277: both panels still open and anchor to the stack", async ({ page }) => {
  await toAgentListing(page);
  const card = page.locator("#groups .card").first();

  await card.locator(".ctl.watch").click();
  await expect(card.locator(".cpop")).toBeVisible();
  await expect(card.locator(".cpop .cseg").first()).toBeVisible();
  await card.locator(".cpop .cclose").click();
  await expect(card.locator(".cpop")).toHaveCount(0);

  await card.locator(".ctl.notify").click();
  await expect(card.locator(".cpop.npop")).toBeVisible();
});
