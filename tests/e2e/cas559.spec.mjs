// CAS-559: guest mode was retired by CAS-201 (no entry point since), but the account sheet still carried
// copy written for it — a device-storage stake count, an "any email works, even a made-up one" pitch, and
// (when config.js is missing) developer text naming Supabase/config.js/config.example.js. Lee's call: there
// is no signed-out usage any more, so remove the copy that describes it rather than pretend it's still a
// supported mode.
//
// The suite stays guest-mode/network-free by convention (see helpers.mjs), so #authSignedOut is reached
// the same way cas558.spec.mjs reads it — the markup is static regardless of which panel CSS currently
// shows, so its text is readable via evaluate without opening a configured session. Actually completing a
// made-up-email sign-in needs a real Supabase round trip, which this suite deliberately never makes; that
// half of AC3 is verified by construction instead (the diff never touches continueWithEmail/derivePassword/
// the #authEmail-#authContinue wiring, only the static intro text above them).
import { test, expect } from "@playwright/test";
import { freshApp } from "./helpers.mjs";

const BANNED = /Supabase|config\.js|config\.example\.js|localStorage|made-up|this browser/i;

test("CAS-559: the account sheet's static markup names no backend/repo/storage detail anywhere", async ({ page }) => {
  await freshApp(page);
  const text = await page.locator("#authModal").evaluate(el => el.textContent);
  expect(text).not.toMatch(BANNED);
});

test("CAS-559: #authGuestStake and its paint function are gone", async ({ page }) => {
  await freshApp(page);
  expect(await page.locator("#authGuestStake").count()).toBe(0);
  expect(await page.evaluate(() => typeof window.paintGuestStake)).toBe("undefined");
});

test("CAS-559: the no-config panel shows a plain, user-facing message and warns the real reason to console", async ({ page }) => {
  const warnings = [];
  page.on("console", msg => { if(msg.type() === "warning" || msg.type() === "error") warnings.push(msg.text()); });

  await freshApp(page);
  await page.locator("#splashLogin").click();
  await expect(page.locator("#authGuest")).toBeVisible();

  const guestText = (await page.locator("#authGuest").textContent()).trim();
  expect(guestText).toBe("Cascade can't reach its account service right now. Please try again shortly.");
  expect(guestText).not.toMatch(BANNED);

  expect(warnings.some(w => /no account config/i.test(w))).toBe(true);
});

test("CAS-559: the signed-out intro drops the made-up-email pitch and the browser-storage framing", async ({ page }) => {
  await freshApp(page);
  const intro = await page.locator("#authSignedOut .pnote").first()
    .evaluate(el => el.textContent.trim().replace(/\s+/g, " "));
  expect(intro).toBe("Enter your email to sign in, or create your account. Your Cascades then sync across your devices.");
});

test("CAS-559: sign-in wiring (#authEmail/#authContinue) is untouched — still present and enabled", async ({ page }) => {
  await freshApp(page);
  const email = page.locator("#authEmail");
  const cta = page.locator("#authContinue");
  expect(await email.count()).toBe(1);
  expect(await cta.count()).toBe(1);
  expect(await cta.isEnabled()).toBe(true);
});
