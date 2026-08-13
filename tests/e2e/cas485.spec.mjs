// CAS-485: the Watch-it control now carries CAS-468's gold "recent" glow when the film's CURRENT window is
// one you've ticked on that control — reusing watchIsCurrent (CAS-349's st.current), no recency gate, and
// the same .cap.recent border/box-shadow values rather than a second visual language.
import { test, expect } from "@playwright/test";
import {
  toShortlist, shortlistCards, pickCard, finishFlow, toListing, settleListing, ctaLocator,
} from "./helpers.mjs";

// Same setup as CAS-473: the Watch-it popup only offers a row for a window this agent's Notify switch is on
// for, and a fresh onboarded agent starts with every window's Notify off.
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

/** First card in a given listing group ("rental"/"pvod"/"included_streaming"), or null if the group is empty. */
async function firstCardInGroup(page, group){
  const card = page.locator(`#groups .group[data-g="${group}"] .card`).first();
  if(await card.count() === 0) return null;
  return (await card.getAttribute("id")).replace(/^card-/, "");
}

test("CAS-485: ticking a film's current window glows the Watch-it control immediately, no reload", async ({ page }) => {
  await toListingWithAgent(page);

  const id = await firstCardInGroup(page, "rental");
  test.skip(id === null, "no film currently at Rent in this agent's listing");

  const chip = page.locator(`.ctl.notify[data-nid="${id}"]`);
  await expect(chip).not.toHaveClass(/recent/);

  await chip.click();
  await expect(page.locator(".cpop.npop")).toBeVisible();
  const rentRow = page.locator('.cpop.npop .nopt[data-wk="rent"]');
  await expect(rentRow).toBeEnabled();
  await rentRow.click();                          // ticks the film's own CURRENT window

  // The chip is re-rendered (repaintWatchControl) — re-locate it and expect the glow with no reload.
  const glowingChip = page.locator(`.ctl.notify[data-nid="${id}"]`);
  await expect(glowingChip).toHaveClass(/recent/);
  await expect(glowingChip).toHaveClass(/on/);

  // Un-ticking removes the glow immediately too — the popup is still open from the tick above
  // (repaintWatchControl re-applies .open), so the same row is clicked again to untick it.
  await expect(page.locator(".cpop.npop")).toBeVisible();
  await page.locator('.cpop.npop .nopt[data-wk="rent"]').click();
  const untickedChip = page.locator(`.ctl.notify[data-nid="${id}"]`);
  await expect(untickedChip).not.toHaveClass(/recent/);
});

test("CAS-485: ticking a window that is NOT the film's current window does not glow", async ({ page }) => {
  await toListingWithAgent(page);

  // Streaming is ahead of Rent on the ladder — a film currently at Rent has Streaming un-spent but not current.
  const id = await firstCardInGroup(page, "rental");
  test.skip(id === null, "no film currently at Rent in this agent's listing");

  const chip = page.locator(`.ctl.notify[data-nid="${id}"]`);
  await chip.click();
  await expect(page.locator(".cpop.npop")).toBeVisible();
  const streamRow = page.locator('.cpop.npop .nopt[data-wk="stream"]');
  test.skip(await streamRow.count() === 0, "no future Streaming row offered for this film");
  await expect(streamRow).toBeEnabled();
  await streamRow.click();

  const stillDark = page.locator(`.ctl.notify[data-nid="${id}"]`);
  await expect(stillDark).not.toHaveClass(/recent/);
});
