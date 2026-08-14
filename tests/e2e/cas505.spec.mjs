// CAS-505: the Edit Agent > Where & when you'll watch screen's "Notify option" switch (drawWatchLanes/
// #wwLanes) no longer delivers anything — CAS-502 made match_film_watches (a per-film Watch it tick) the
// only thing that notifies. The switch itself stays: turning it on for a notify-only window (e.g. Rent for
// a Cinema agent) still keeps that window in the agent's WATCH scope (watchToStatuses), which drives real
// found/new-count behaviour. So this ticket only reworded the copy — the switch, its hub entry point, and
// the hub's own summary line — to stop promising an alert/email it can no longer deliver, while leaving the
// wiring (state shape, onclick handlers, watchToStatuses) untouched.
import { test, expect } from "@playwright/test";
import {
  toShortlist, shortlistCards, pickCard, finishFlow, toListing, settleListing, ctaLocator, sectionCounts,
} from "./helpers.mjs";

async function openWatchScreen(page){
  await page.evaluate(() => window.editCascade());
  const door = page.locator(".osdoor", { hasText: "Where & when you'll watch" });
  await expect(door).toBeVisible();
  await expect(door.locator(".di")).toHaveText("📺");
  await door.click();
  await expect(page.locator("#wwLanes .wwlane").first()).toBeVisible();
}

test("CAS-505: the Edit Agent hub door for this screen no longer says Notifications or carries a bell", async ({ page }) => {
  await toShortlist(page, "cinema");
  const cards = await shortlistCards(page);
  await pickCard(page, cards[0].name);
  await finishFlow(page);
  await toListing(page);

  await page.evaluate(() => window.editCascade());
  const rowLabels = await page.locator(".osdoor .dh").allTextContents();
  expect(rowLabels.some(t => /notif/i.test(t))).toBe(false);
  const rowIcons = await page.locator(".osdoor .di").allTextContents();
  expect(rowIcons).not.toContain("🔔");
});

test("CAS-505: the switch itself reads 'Follow', not 'Notify option', and promises no alert", async ({ page }) => {
  await toShortlist(page, "cinema");
  const cards = await shortlistCards(page);
  await pickCard(page, cards[0].name);
  await finishFlow(page);
  await toListing(page);
  await openWatchScreen(page);

  const subtitle = await page.locator("#wwLanes").locator("xpath=preceding-sibling::p[1]").textContent();
  expect(subtitle).toContain("Follow");
  expect(/\balert\b|\bemail\b/i.test(subtitle)).toBe(false);

  const premiumLane = page.locator("#wwLanes .wwlane").filter({ has: page.locator(".wwn", { hasText: "Premium" }) });
  const followBtn = premiumLane.locator(".agwt", { hasText: "Follow" });
  await expect(followBtn).toHaveCount(1);
  await expect(premiumLane.locator(".agwt", { hasText: "Notify option" })).toHaveCount(0);

  const hint = await followBtn.getAttribute("title");
  expect(/\balert\b|\bnotify\b|\bemail\b/i.test(hint || "")).toBe(false);
});

test("CAS-505: toggling Follow behaves exactly as the old Notify switch did — scope changes, listing does not", async ({ page }) => {
  await toShortlist(page, "cinema");
  const cards = await shortlistCards(page);
  await pickCard(page, cards[0].name);
  await finishFlow(page);
  await toListing(page);
  await openWatchScreen(page);

  const premiumLane = page.locator("#wwLanes .wwlane").filter({ has: page.locator(".wwn", { hasText: "Premium" }) });
  const followBtn = premiumLane.locator(".agwt", { hasText: "Follow" });
  await expect(followBtn).toHaveAttribute("aria-pressed", "false");
  await followBtn.click();
  await expect(followBtn).toHaveAttribute("aria-pressed", "true");
  await expect(followBtn).toHaveClass(/on/);

  // The hub's own summary line reports it without claiming an alert.
  await ctaLocator(page).click();                                    // Done, back to the Edit Agent hub
  await expect(page.locator(".osh", { hasText: /Edit Agent/ })).toBeVisible();
  const summary = await page.locator(".osdoor", { hasText: "Where & when you'll watch" }).locator(".ds").textContent();
  expect(summary).toContain("Premium");
  expect(/\balert/i.test(summary || "")).toBe(false);

  await page.locator(".osfoot .oscta", { hasText: "Save agent" }).click();
  await expect(page.locator("#onbStep")).not.toHaveClass(/open/);
  await settleListing(page);

  // Listing scope is unaffected — Premium never gained a List switch, so no pvod section appears.
  const windows = (await sectionCounts(page)).map(s => s.window);
  expect(windows).not.toContain("pvod");

  // Re-opening shows the tick held — the state shape (winFlags/winOn) is untouched, only the label is new.
  await openWatchScreen(page);
  await expect(page.locator("#wwLanes .wwlane").filter({ has: page.locator(".wwn", { hasText: "Premium" }) })
    .locator(".agwt", { hasText: "Follow" })).toHaveClass(/on/);
});
