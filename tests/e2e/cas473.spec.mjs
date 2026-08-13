// CAS-473: the per-film "Watch it" popup used to grey out the option matching a film's CURRENT window
// (CAS-434's `spent` treated the current rung the same as a past one) — so a film already at Rent could
// never have "Standard Rent" ticked unless it had been ticked earlier, while the film was still upstream.
// watchLevelsFor's `spent` is now strictly-past rungs only; see the CAS-473 comment there.
import { test, expect } from "@playwright/test";
import {
  toShortlist, shortlistCards, pickCard, finishFlow, toListing, settleListing, ctaLocator,
} from "./helpers.mjs";

// The popup only ever offers a row for a window this agent's own Notify switch is on for (CAS-427 — a level
// the agent hasn't opted into isn't shown greyed, it isn't shown at all), and a fresh onboarded agent starts
// with every window's Notify off. So exercising the greying at all means turning Notify on for every window
// first, via the same Edit Agent > Notifications screen a person would use.
async function enableAllNotify(page){
  await page.evaluate(() => window.editCascade());
  await expect(page.locator(".osh", { hasText: /Edit Agent/ })).toBeVisible();
  await page.locator(".osdoor", { hasText: "Notifications" }).click();
  await expect(page.locator("#wwLanes .wwlane").first()).toBeVisible();
  for(const label of ["Premium", "Standard Rent", "Streaming"]){
    const lane = page.locator(".wwlane", { has: page.locator(".wwn", { hasText: label }) });
    const notifyBtn = lane.locator(".agwt", { hasText: "Notify option" });
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

/** Open the Watch-it popup for the first card in a given listing group ("rental"/"pvod"/"included_streaming"),
 * returning the card's id, or null if the group has no cards. */
async function openWatchPanelForGroup(page, group){
  const card = page.locator(`#groups .group[data-g="${group}"] .card`).first();
  if(await card.count() === 0) return null;
  const id = (await card.getAttribute("id")).replace(/^card-/, "");
  await page.locator(`.ctl.notify[data-nid="${id}"]`).click();
  await expect(page.locator(".cpop.npop")).toBeVisible();
  return id;
}

test("CAS-473: a film currently at Rent has Standard Rent selectable in its Watch-it popup, not greyed out", async ({ page }) => {
  await toListingWithAgent(page);

  const id = await openWatchPanelForGroup(page, "rental");
  test.skip(id === null, "no film currently at Rent in this agent's listing");

  const rentRow = page.locator('.cpop.npop .nopt[data-wk="rent"]');
  await expect(rentRow).toBeVisible();
  await expect(rentRow).not.toHaveClass(/spent/);
  await expect(rentRow).toBeEnabled();

  // Selecting it ticks it (CAS-349's auto-tick — selecting a level ticks itself and everything enabled below it).
  await rentRow.click();
  await expect(rentRow).toHaveAttribute("aria-pressed", "true");
  await expect(rentRow).toHaveClass(/on/);

  // The film's PAST window (Premium, behind Rent on the stream ladder) stays disabled: this is specifically
  // about the current window, not every window behind it.
  const premiumRow = page.locator('.cpop.npop .nopt[data-wk="premium"]');
  if(await premiumRow.count()){
    await expect(premiumRow).toHaveClass(/spent/);
    await expect(premiumRow).toBeDisabled();
  }

  // A future window (Streaming, ahead of Rent) is unaffected by this change — already selectable before it.
  const streamRow = page.locator('.cpop.npop .nopt[data-wk="stream"]');
  if(await streamRow.count()){
    await expect(streamRow).not.toHaveClass(/spent/);
    await expect(streamRow).toBeEnabled();
  }
});

test("CAS-473: a film currently at Premium has Premium selectable in its Watch-it popup, not greyed out", async ({ page }) => {
  await toListingWithAgent(page);

  const id = await openWatchPanelForGroup(page, "pvod");
  test.skip(id === null, "no film currently at Premium in this agent's listing");

  const premiumRow = page.locator('.cpop.npop .nopt[data-wk="premium"]');
  await expect(premiumRow).toBeVisible();
  await expect(premiumRow).not.toHaveClass(/spent/);
  await expect(premiumRow).toBeEnabled();
});

test("CAS-473: a film currently on Streaming has Streaming selectable in its Watch-it popup, not greyed out", async ({ page }) => {
  await toListingWithAgent(page);

  const id = await openWatchPanelForGroup(page, "included_streaming");
  test.skip(id === null, "no film currently on Streaming in this agent's listing");

  const streamRow = page.locator('.cpop.npop .nopt[data-wk="stream"]');
  await expect(streamRow).toBeVisible();
  await expect(streamRow).not.toHaveClass(/spent/);
  await expect(streamRow).toBeEnabled();

  // Its past windows (Premium, Rent) stay disabled.
  for(const key of ["premium", "rent"]){
    const row = page.locator(`.cpop.npop .nopt[data-wk="${key}"]`);
    if(await row.count()){
      await expect(row).toHaveClass(/spent/);
      await expect(row).toBeDisabled();
    }
  }
});
