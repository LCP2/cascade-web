// CAS-477: a Watch-it tick is account-wide storage (notify[id].wins[key]) — but watchLevelsFor() used to
// drop a level's row entirely once THIS cascade stopped tracking it (`if(c && !f.list && !f.notify) return`),
// and watchPanelRowsHTML() filtered to agentOn-only rows on top of that. So ticking a level, then turning
// this cascade's own tracking of that level off, made the tick look reset even though it was still there.
// Both gates are gone now — every eligible level is shown, live and tickable, regardless of whether this
// cascade's own Notify/List switches are on for it; see the CAS-477 comments on watchLevelsFor/watchPanelRowsHTML.
import { test, expect } from "@playwright/test";
import {
  toShortlist, shortlistCards, pickCard, finishFlow, toListing, settleListing, ctaLocator,
} from "./helpers.mjs";

async function openNotificationsScreen(page){
  await page.evaluate(() => window.editCascade());
  await expect(page.locator(".osh", { hasText: /Edit Agent/ })).toBeVisible();
  await page.locator(".osdoor", { hasText: "Notifications" }).click();
  await expect(page.locator("#wwLanes .wwlane").first()).toBeVisible();
}

async function setLaneSwitch(page, label, which, desiredOn){
  const lane = page.locator(".wwlane", { has: page.locator(".wwn", { hasText: label }) });
  const btn = lane.locator(".agwt", { hasText: which === "notify" ? "Notify option" : "List" });
  const isOn = (await btn.getAttribute("aria-pressed")) === "true";
  if(isOn !== desiredOn) await btn.click();
  await expect(btn).toHaveAttribute("aria-pressed", String(desiredOn));
}

async function saveAgentAndReturnToListing(page){
  await ctaLocator(page).click();                                    // Done, back to the Edit Agent hub
  await expect(page.locator(".osh", { hasText: /Edit Agent/ })).toBeVisible();
  await page.locator(".osfoot .oscta", { hasText: "Save agent" }).click();
  await expect(page.locator("#onbStep")).not.toHaveClass(/open/);
  await settleListing(page);
}

test("CAS-477: a ticked Watch-it level stays visible and ticked after this agent stops tracking it", async ({ page }) => {
  await toShortlist(page, "stream");
  const cards = await shortlistCards(page);
  await pickCard(page, cards[0].name);
  await finishFlow(page);
  await toListing(page);

  // Pick a film currently sitting at Rent — its own listing membership rides on Rent's List switch, which
  // this test never touches. Streaming (untracked below) sits AHEAD of Rent on the ladder, so its row is not
  // spent for this film and stays tickable throughout.
  const card = page.locator('#groups .group[data-g="rental"] .card').first();
  test.skip((await card.count()) === 0, "no film currently at Rent in this agent's listing");
  await expect(card).toBeVisible();
  const id = (await card.getAttribute("id")).replace(/^card-/, "");

  await page.locator(`.ctl.notify[data-nid="${id}"]`).click();
  await expect(page.locator(".cpop.npop")).toBeVisible();
  const streamRow = page.locator('.cpop.npop .nopt[data-wk="stream"]');
  await expect(streamRow).toBeVisible();
  if(!(await streamRow.evaluate(el => el.classList.contains("on")))) await streamRow.click();
  await expect(streamRow).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.press("Escape");

  // Now turn this cascade's own tracking of Streaming fully off — both List and Notify — reproducing exactly
  // the untracked condition the old `!f.list && !f.notify` check used to hide the row on.
  await openNotificationsScreen(page);
  await setLaneSwitch(page, "Streaming", "notify", false);
  await setLaneSwitch(page, "Streaming", "list", false);
  await saveAgentAndReturnToListing(page);

  // The film (still listed via Rent, untouched) still shows a Streaming row in its Watch-it popup, live and
  // ticked — the row was never reset, it was just hidden by a cascade config the account-wide tick never
  // depended on.
  await expect(page.locator(`#card-${id}`)).toBeVisible();
  await page.locator(`.ctl.notify[data-nid="${id}"]`).click();
  await expect(page.locator(".cpop.npop")).toBeVisible();
  const streamRowAfter = page.locator('.cpop.npop .nopt[data-wk="stream"]');
  await expect(streamRowAfter).toBeVisible();
  await expect(streamRowAfter).toBeEnabled();
  await expect(streamRowAfter).toHaveAttribute("aria-pressed", "true");
  await expect(streamRowAfter).toHaveClass(/on/);
});
