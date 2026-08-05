// CAS-363: punched-up copy on the priority step, text only — same two-card layout, icons, and Back
// behaviour (CAS-347). Approved wording (Set A, 2026-08-05).
import { test, expect } from "@playwright/test";
import { freshApp, toShortlist, shortlistCards, pickCard, finishFlow, toListing } from "./helpers.mjs";

test("CAS-363: priority step reads the approved copy on first-run Onboarding", async ({ page }) => {
  await freshApp(page);
  await page.locator("#splashCta").click();
  await expect(page.locator(".priobtn").first()).toBeVisible();

  await expect(page.locator(".prioh")).toHaveText("What matters most right now?");
  await expect(page.locator(".priobtn.cin .priotx")).toHaveText("Never miss a great film on the big screen.");
  await expect(page.locator(".priobtn.str .priotx")).toHaveText("Always know what to stream next.");
  await expect(page.locator(".priostmt")).toHaveText("Just a starting point — add as many Cascade Agents as you like.");
});

test("CAS-363: priority step reads the approved copy from + New Cascade", async ({ page }) => {
  await toShortlist(page, "cinema");
  const first = await shortlistCards(page);
  await pickCard(page, first[0].name);
  await finishFlow(page);
  await toListing(page);

  // The deck is a coverflow strip — "New Agent" sits last and only shows its actions once centred
  // (same pattern CAS-347 uses to reach this same screen).
  await page.evaluate(() => deckGo(deckCount() - 1, false));
  await expect(page.locator(".dcard.new.is-centre")).toBeVisible();
  await page.locator(".dcard.new .ca-btn.new").click();
  await expect(page.locator(".priobtn").first()).toBeVisible();

  await expect(page.locator(".prioh")).toHaveText("What matters most right now?");
  await expect(page.locator(".priobtn.cin .priotx")).toHaveText("Never miss a great film on the big screen.");
  await expect(page.locator(".priobtn.str .priotx")).toHaveText("Always know what to stream next.");
  await expect(page.locator(".priostmt")).toHaveText("Just a starting point — add as many Cascade Agents as you like.");
});
