// CAS-308: the trail's Notify row was baked into the DOM when the notifysettings step first painted, and
// flowNotify() only patched the toggle button + CTA gate — never the trail — so ticking "Send me alerts by
// email" left the row reading its stale "In-app" value. flowNotify() now calls onbRefresh(), the same
// repaint every other flow control uses, which already recomputes the trail row on every change (CAS-264).
import { test, expect } from "@playwright/test";
import { toShortlist, shortlistCards, pickCard } from "./helpers.mjs";

async function toNotify(page, kind){
  await toShortlist(page, kind);
  const cards = await shortlistCards(page);
  await pickCard(page, cards[0].name);
  await page.evaluate(() => {
    notifyPrefs.inApp = true; notifyPrefs.emailOn = false; notifyPrefs.email = ""; saveNotifyPrefs();
    window.gotoStep("notifysettings", "none");
  });
  await expect(page.locator(".osh", { hasText: /notify you/i })).toBeVisible();
}

const notifyRowValue = page => page.locator(".otrow", { has: page.locator(".otk", { hasText: "Notify" }) }).locator(".otv");

for(const kind of ["cinema", "stream"]){
  test(`CAS-308 (${kind}): the trail's Notify row updates the moment email alerts are ticked`, async ({ page }) => {
    await toNotify(page, kind);
    const row = notifyRowValue(page);

    await expect(row).toHaveText("In-app");

    await page.locator(".bigtoggle", { hasText: /Send me alerts by email/ }).click();
    await expect(row).toHaveText("In-app, Email");

    // Switching in-app off in the same beat leaves only the channel that is actually on.
    await page.locator(".bigtoggle", { hasText: /Allow in-app/ }).click();
    await expect(row).toHaveText("Email");

    // Both off reads as Off, never an empty row.
    await page.locator(".bigtoggle", { hasText: /Send me alerts by email/ }).click();
    await expect(row).toHaveText("Off");
  });
}
