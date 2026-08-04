// CAS-347: Back from the priority step must return to wherever the flow was opened from — the splash for a
// true first run, but the deck ("+ New Cascade") for anyone already signed in with an agent. It used to hard-
// code the splash both ways, which booted a signed-in user back to the login wall.
import { test, expect } from "@playwright/test";
import { freshApp, toShortlist, shortlistCards, pickCard, finishFlow, toListing } from "./helpers.mjs";

test("CAS-347: Back on the priority step from first-run still returns to the splash", async ({ page }) => {
  await freshApp(page);
  await page.locator("#splashCta").click();
  await expect(page.locator(".priobtn").first()).toBeVisible();
  expect(await page.evaluate(() => onbStepKey)).toBe("priority");

  await page.locator("#onbStep .osback").click();
  await expect(page.locator("#splash")).toHaveClass(/open/);
  await expect(page.locator(".priobtn").first()).toBeHidden();
});

test("CAS-347: Back on the priority step from + New Cascade returns to the deck, not the splash", async ({ page }) => {
  await toShortlist(page, "cinema");
  const first = await shortlistCards(page);
  await pickCard(page, first[0].name);
  await finishFlow(page);
  await toListing(page);

  // The deck is a coverflow strip — a card's action buttons only show once it is centred, and the
  // "New Agent" card sits last (CAS-270 centres cards the same way, via deckGo, in its own specs).
  await page.evaluate(() => deckGo(deckCount() - 1, false));
  await expect(page.locator(".dcard.new.is-centre")).toBeVisible();
  await page.locator(".dcard.new .ca-btn.new").click();
  await expect(page.locator(".priobtn").first()).toBeVisible();
  expect(await page.evaluate(() => onbStepKey)).toBe("priority");

  await page.locator("#onbStep .osback").click();
  await expect(page.locator("#splash")).not.toHaveClass(/open/);
  await expect(page.locator(".priobtn").first()).toBeHidden();
  await expect(page.locator("#groups .card, #groups .stub").first()).toBeVisible();
});
