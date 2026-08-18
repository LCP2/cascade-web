// CAS-575: drop explicit AI signalling (the string "AI", the ✨ sparkle, the 🧠 brain) from user-visible
// copy — a verbatim six-hunk patch, no behaviour change. The splash tagline and the membership benefit row
// are reachable through the normal flow, so those two are driven for real. The invite screens and the
// paused-guest card (hunks 3-6) sit behind guest mode, which CAS-201 left with no UI entry point any more
// (see the "Just browse" comment above guestMode() in app_template.html) — the only way to reach them, for
// a real legacy user or this test, is the localStorage flag + a paused cascade already on device. That
// state is injected directly, then the app's own render functions (openInvite/inviteGo/renderCascadeBar)
// are called exactly as their real callers would.
import { test, expect } from "@playwright/test";
import { freshApp, toShortlist, shortlistCards, pickCard, finishFlow, toListing } from "./helpers.mjs";

test("CAS-575: splash tagline drops the AI claim", async ({ page }) => {
  await freshApp(page);
  await expect(page.locator("#splashTag")).toHaveText("Movie Agents");
});

test("CAS-575: membership benefit row reads Tuned to your taste, not AI preference learning", async ({ page }) => {
  await toShortlist(page, "stream");
  const cards = await shortlistCards(page);
  await pickCard(page, cards[0].name);
  await finishFlow(page);

  const row = page.locator(".mbrow", { has: page.locator(".mbt", { hasText: "Tuned to your taste" }) });
  await expect(row).toBeVisible();
  await expect(row.locator(".mbic")).toHaveText("🎯");
  await expect(row.locator(".mbd")).toHaveText("The more you rate, the sharper every pick gets.");

  await expect(page.locator(".mbt", { hasText: "AI preference learning" })).toHaveCount(0);
});

test("CAS-575: invite screens and the paused-guest card use the target emoji, not the brain", async ({ page }) => {
  await toShortlist(page, "stream");
  const cards = await shortlistCards(page);
  await pickCard(page, cards[0].name);
  await finishFlow(page);
  await toListing(page);

  // Guest mode's only way in for a build this old is the flag already being on-device (CAS-201 killed the
  // "Just browse" entry point but kept the read side for existing guests) — set it the way that user's
  // localStorage would already be set, then pause the agent exactly as enableAgent()'s caller expects.
  await page.evaluate(() => {
    localStorage.setItem("cascade_guest", "1");
    cascades[0].paused = true;
    renderCascadeBar(0);
  });

  const guestCard = page.locator(".guestcard");
  await expect(guestCard).toBeVisible();
  await expect(guestCard.locator(".gc-status")).toContainText("🎯 Learning");
  await expect(guestCard.locator(".gc-status")).not.toContainText("🧠");

  // openInvite()/inviteGo() are the real handlers behind the guest card's "Turn my agent on" button.
  await page.evaluate(() => { openInvite(); });
  await expect(page.locator("#invite")).toHaveClass(/open/);
  await page.evaluate(() => { window.inviteGo(1); });
  await expect(page.locator(".invh")).toHaveText("Tune it to your taste.");
  await expect(page.locator(".ir-name", { hasText: "Tune my agent to my ratings" })).toContainText("🎯");
  await expect(page.locator(".ir-name")).not.toContainText("🧠");

  await page.evaluate(() => { window.inviteGo(2); });
  await expect(page.locator(".invstatus")).toContainText("🎯 Learning");
  await expect(page.locator(".invstatus")).not.toContainText("🧠");
});
