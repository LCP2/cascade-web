// CAS-474: a Cinema agent's "Where & when you'll watch" editor used to offer only Upcoming and In cinema.
// It now also offers Premium, Standard Rent and Streaming — "catch it at home" for a film missed at the
// cinema — but Notify-only: those three windows never get a List switch, because a Cinema agent's own
// catalogue stays cinema-scoped (AGENT_WINDOWS.cinema's HOME_WINDOWS entries carry notifyOnly:true; see the
// comment there and in drawWatchLanes()). Streaming agents are untouched — they already had all three,
// with both switches, from CAS-243.
import { test, expect } from "@playwright/test";
import {
  toShortlist, shortlistCards, pickCard, finishFlow, toListing, settleListing, ctaLocator, sectionCounts,
} from "./helpers.mjs";

async function openNotifications(page){
  await page.evaluate(() => window.editCascade());
  await expect(page.locator(".osh", { hasText: /Edit Agent/ })).toBeVisible();
  await page.locator(".osdoor", { hasText: "Where & when you'll watch" }).click();
  await expect(page.locator("#wwLanes .wwlane").first()).toBeVisible();
}

async function toListingWithCinemaAgent(page){
  await toShortlist(page, "cinema");
  const cards = await shortlistCards(page);
  await pickCard(page, cards[0].name);
  await finishFlow(page);
  await toListing(page);
}

test("CAS-474: a Cinema agent's Notify screen adds Premium/Standard Rent/Streaming below Upcoming/In cinema, Notify-only", async ({ page }) => {
  await toListingWithCinemaAgent(page);
  await openNotifications(page);

  const lanes = page.locator("#wwLanes .wwlane");
  const labels = await lanes.locator(".wwn").allTextContents();
  expect(labels).toEqual(["Upcoming", "In cinema", "Premium", "Standard Rent", "Streaming"]);

  // The two existing cinema windows still carry both switches.
  for(const label of ["Upcoming", "In cinema"]){
    const lane = lanes.filter({ has: page.locator(".wwn", { hasText: label }) });
    await expect(lane.locator(".agwt", { hasText: "List" })).toHaveCount(1);
    await expect(lane.locator(".agwt", { hasText: "Follow" })).toHaveCount(1);
  }
  // The three new home-availability windows carry Notify only — no List switch at all.
  for(const label of ["Premium", "Standard Rent", "Streaming"]){
    const lane = lanes.filter({ has: page.locator(".wwn", { hasText: label }) });
    await expect(lane.locator(".agwt", { hasText: "List" })).toHaveCount(0);
    await expect(lane.locator(".agwt", { hasText: "Follow" })).toHaveCount(1);
  }
});

test("CAS-474: ticking Notify on Premium for a Cinema agent arms the bell but leaves its listing cinema-scoped", async ({ page }) => {
  await toListingWithCinemaAgent(page);
  await openNotifications(page);

  const premiumLane = page.locator("#wwLanes .wwlane").filter({ has: page.locator(".wwn", { hasText: "Premium" }) });
  const notifyBtn = premiumLane.locator(".agwt", { hasText: "Follow" });
  await notifyBtn.click();
  await expect(notifyBtn).toHaveClass(/on/);

  await ctaLocator(page).click();                                  // Done, back to the Edit Agent hub
  await expect(page.locator(".osh", { hasText: /Edit Agent/ })).toBeVisible();
  await page.locator(".osfoot .oscta", { hasText: "Save agent" }).click();
  await expect(page.locator("#onbStep")).not.toHaveClass(/open/);
  await settleListing(page);

  // The listing itself never gained a Premium/Rent/Streaming section — List scope is unaffected by Notify.
  const windows = (await sectionCounts(page)).map(s => s.window);
  for(const homeWindow of ["pvod", "rental", "included_streaming"]) expect(windows).not.toContain(homeWindow);

  // Re-opening the editor shows the bell held, so the tick actually persisted.
  await openNotifications(page);
  await expect(page.locator("#wwLanes .wwlane").filter({ has: page.locator(".wwn", { hasText: "Premium" }) })
    .locator(".agwt", { hasText: "Follow" })).toHaveClass(/on/);
});

test("CAS-474: Streaming agents are unaffected — still Premium/Standard Rent/Streaming with both switches", async ({ page }) => {
  await toShortlist(page, "stream");
  const cards = await shortlistCards(page);
  await pickCard(page, cards[0].name);
  await finishFlow(page);
  await toListing(page);
  await openNotifications(page);

  const labels = await page.locator("#wwLanes .wwlane .wwn").allTextContents();
  expect(labels).toEqual(["Premium", "Standard Rent", "Streaming"]);

  for(const label of labels){
    const lane = page.locator("#wwLanes .wwlane").filter({ has: page.locator(".wwn", { hasText: label }) });
    await expect(lane.locator(".agwt", { hasText: "List" })).toHaveCount(1);
    await expect(lane.locator(".agwt", { hasText: "Follow" })).toHaveCount(1);
  }
});
