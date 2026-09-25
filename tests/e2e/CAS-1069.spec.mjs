// CAS-1069: the membership screen no longer carries free-month/price copy or the "Prototype" disclaimer —
// account stays required (Lee, 25 Sep 2026), this is a copy-only change. Covers both #membScreen paths:
// the onboarding recap (openOnbMembership, reached via finishFlow) and the standalone preview
// (openMembership, reached via ?step=membership, same entry CAS-909/CAS-910 use for other preview steps).
import { test, expect } from "@playwright/test";
import { toShortlist, finishFlow, toListing } from "./helpers.mjs";

/** The screen's own rendered text has neither banned phrase, case-insensitively. */
async function expectCleanCopy(page){
  const text = (await page.locator("#membBody").textContent()) || "";
  const lower = text.toLowerCase();
  expect(lower).not.toContain("free month");
  expect(lower).not.toContain("prototype");
}

test("onboarding recap (openOnbMembership): clean copy, 'Save my agents' CTA, and membStart() still lands on the listing (CAS-1069 AC1/AC2/AC3)", async ({ page }) => {
  await toShortlist(page, "cinema");
  await finishFlow(page);   // lands on #membScreen.open — the onboarding recap

  await expect(page.locator("#membScreen.open")).toBeVisible();
  await expectCleanCopy(page);
  await expect(page.locator(".membcta")).toHaveText("Save my agents");

  // membStart() behaviour is unchanged: guest mode (config.js 404'd by freshApp) needs no email and
  // proceeds straight through to the listing.
  await toListing(page);
  await expect(page.locator("#groups")).toBeVisible();
});

test("standalone preview (openMembership via ?step=membership): clean copy and 'Save my agents' CTA (CAS-1069 AC1/AC2)", async ({ page }) => {
  await page.route("**/config.js", route => route.fulfill({ status: 404, body: "" }));
  await page.goto("/index.html?step=membership");
  await page.waitForFunction(() => typeof flowStart === "function" && Array.isArray(MOVIES));

  await expect(page.locator("#membScreen.open")).toBeVisible();
  await expectCleanCopy(page);
  await expect(page.locator(".membcta")).toHaveText("Save my agents");
});
