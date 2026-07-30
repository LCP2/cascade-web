// CAS-244: "Notify me by" — the account decides which channels exist, the agent narrows them.
import { test, expect } from "@playwright/test";
import { toShortlist, shortlistCards, pickCard, finishFlow, toListing } from "./helpers.mjs";

async function toAgentSettings(page, kind = "cinema"){
  await toShortlist(page, kind);
  const cards = await shortlistCards(page);
  await pickCard(page, cards[0].name);
  await finishFlow(page);
  await toListing(page);
  await page.evaluate(() => window.editCascade());
  await page.locator(".osdoor", { hasText: "Agent settings" }).click();
  await expect(page.locator(".osh", { hasText: /Where & when/ })).toBeVisible();
}

test("CAS-244: only channels the account has on are offered, and the agent can turn one off", async ({ page }) => {
  await toAgentSettings(page);
  await expect(page.locator(".wwsec", { hasText: "Notify me by" })).toBeVisible();

  // The app's default account state is in-app on, email off — so exactly one channel is offered.
  let rows = await page.locator("#wwChannels .wwch").allTextContents();
  expect(rows.join(" ")).toMatch(/In-app/);
  expect(rows.join(" "), "email is off in Account and must not be offered here").not.toMatch(/Email/);

  // Turn email on at the ACCOUNT level, and it appears here — already on, because the rule is
  // "available and not turned off", not "opt in again".
  await page.evaluate(() => { notifyPrefs.emailOn = true; saveNotifyPrefs(); drawNotifyBy(); });
  rows = await page.locator("#wwChannels .wwch").allTextContents();
  expect(rows.length).toBe(2);
  expect(rows.join(" ")).toMatch(/Email/);
  let live = await page.evaluate(() => onbApply().channelsLive);
  expect(live).toEqual({ inApp: true, email: true });

  // The agent narrows it for itself, and that is what the monitor will read.
  await page.locator("#wwChannels .wwch", { hasText: "Email" }).click();
  live = await page.evaluate(() => onbApply().channelsLive);
  expect(live).toEqual({ inApp: true, email: false });

  // An agent can never grant itself a channel the account has off.
  await page.evaluate(() => { notifyPrefs.inApp = false; saveNotifyPrefs(); drawNotifyBy(); });
  live = await page.evaluate(() => onbApply().channelsLive);
  expect(live.inApp, "the account switched in-app off; the agent must not still be deliverable on it").toBe(false);
});

test("CAS-244: with no channel on, the section says so instead of pretending", async ({ page }) => {
  await toAgentSettings(page);
  await page.evaluate(() => {
    notifyPrefs.inApp = false; notifyPrefs.emailOn = false; saveNotifyPrefs(); drawNotifyBy();
  });
  await expect(page.locator("#wwChannels .wwch")).toHaveCount(0);
  await expect(page.locator("#wwChannels .wwnone")).toContainText(/no notification channels/i);
  await expect(page.locator("#wwChannels .oslink")).toContainText(/Account/);
  const live = await page.evaluate(() => onbApply().channelsLive);
  expect(live).toEqual({ inApp: false, email: false });
});
