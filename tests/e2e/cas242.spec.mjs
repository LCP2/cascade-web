// CAS-242: the Upcoming bell's finer moments, and the lane treatment that stopped reading as "off".
import { test, expect } from "@playwright/test";
import { toShortlist, shortlistCards, pickCard, finishFlow, toListing } from "./helpers.mjs";

async function toAgentSettings(page){
  await toShortlist(page, "cinema");
  const cards = await shortlistCards(page);
  await pickCard(page, cards[0].name);
  await finishFlow(page);
  await toListing(page);
  await page.evaluate(() => window.editCascade());
  await page.locator(".osdoor", { hasText: "Notifications" }).click();   // CAS-267 renamed this row
  await expect(page.locator(".osh", { hasText: /Where & when/ })).toBeVisible();
}

test("CAS-242: Upcoming's Notify carries its two finer moments, both on for a new cinema agent", async ({ page }) => {
  await toAgentSettings(page);
  const lane = page.locator("#wwLanes .wwlane", { hasText: "Upcoming" });
  const subs = lane.locator(".agwsubt");
  await expect(subs).toHaveCount(2);
  await expect(subs.nth(0)).toContainText("When announced");
  await expect(subs.nth(1)).toContainText("Opening next week");
  for(const i of [0, 1]) await expect(subs.nth(i)).toHaveAttribute("aria-pressed", "true");
  // Each says what it actually fires on, rather than leaving the label to be guessed at.
  await expect(subs.nth(0)).toContainText(/reaches Cascade/i);
  await expect(subs.nth(1)).toContainText(/opening date/i);

  // The two moments reach the agent's alerts — a switch here is a promise the daily job keeps.
  const armed = await page.evaluate(() => { const d = onbApply(); return d.alerts; });
  expect(armed.announced, "When announced did not arm its alert").toBe(true);
  expect(armed.opens_soon, "Opening next week did not arm its alert").toBe(true);

  // …and turning one off takes it away without touching the bell it sits under.
  await subs.nth(0).click();
  const after = await page.evaluate(() => { const d = onbApply(); return { a: d.alerts, w: onbFlow.watch }; });
  expect(after.a.announced).toBe(false);
  expect(after.a.opens_soon).toBe(true);
  expect(after.a.cinema, "the base bell must survive a sub-moment being switched off").toBe(true);
  expect(after.w.upcoming.notify).toBe(true);
});

test("CAS-242: the moments hide with the bell, and an off lane looks off", async ({ page }) => {
  await toAgentSettings(page);
  const lane = page.locator("#wwLanes .wwlane", { hasText: "Upcoming" });

  // An enabled Upcoming lane must not be wearing the same treatment as a disabled one — the whole report.
  await expect(lane).toHaveClass(/\bon\b/);
  const litDot = await lane.locator(".wwhead .cd").evaluate(el => getComputedStyle(el).backgroundColor);

  await lane.locator(".agwt", { hasText: "Notify" }).click();
  await expect(lane.locator(".agwsubt"), "the moments must go with the bell they belong to").toHaveCount(0);
  await lane.locator(".agwt", { hasText: "List" }).click();
  await expect(lane).not.toHaveClass(/\bon\b/);
  const darkDot = await lane.locator(".wwhead .cd").evaluate(el => getComputedStyle(el).backgroundColor);
  expect(darkDot, "a switched-off lane still shows its window colour").not.toBe(litDot);

  // Switching the bell back on restores the moments rather than forgetting them.
  await lane.locator(".agwt", { hasText: "Notify" }).click();
  await expect(lane.locator(".agwsubt")).toHaveCount(2);
});
