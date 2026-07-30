// CAS-253: an armed email bell needs somewhere to send it.
import { test, expect } from "@playwright/test";
import { toShortlist, shortlistCards, pickCard } from "./helpers.mjs";

async function toNotify(page, kind){
  await toShortlist(page, kind);
  const cards = await shortlistCards(page);
  await pickCard(page, cards[0].name);
  await page.evaluate(() => {
    notifyPrefs.emailOn = false; notifyPrefs.email = ""; saveNotifyPrefs();
    window.gotoStep("notifysettings", "none");
  });
  await expect(page.locator(".osh", { hasText: /notify you/i })).toBeVisible();
}

for(const kind of ["cinema", "stream"]){
  test(`CAS-253 (${kind}): Continue is blocked until the address is real`, async ({ page }) => {
    await toNotify(page, kind);
    const cta = page.locator("#flowCta");

    // Email off: nothing to answer, nothing blocked.
    await expect(cta).toBeEnabled();

    // Email on, empty: blocked, and not yet scolded — an unanswered question is not a mistake.
    await page.locator(".bigtoggle", { hasText: /Send me alerts by email/ }).click();
    await expect(cta).toBeDisabled();
    await expect(page.locator("#onbEmailErr")).toBeHidden();

    // …and pressing on anyway does not move the flow.
    const before = await page.evaluate(() => onbStepKey);
    await page.evaluate(() => window.onbStepContinue());
    expect(await page.evaluate(() => onbStepKey), "the flow left the step unanswered").toBe(before);
    await expect(page.locator("#onbEmailErr")).toBeVisible();

    // A wrong address says so.
    await page.locator("#onbEmail").fill("not-an-email");
    await expect(page.locator("#onbEmailErr")).toBeVisible();
    await expect(page.locator("#onbEmail")).toHaveClass(/bad/);
    await expect(cta).toBeDisabled();

    // A real one clears it.
    await page.locator("#onbEmail").fill("lee@example.com");
    await expect(page.locator("#onbEmailErr")).toBeHidden();
    await expect(cta).toBeEnabled();

    // Switching email back off releases it whatever the field holds.
    await page.locator("#onbEmail").fill("nope");
    await expect(cta).toBeDisabled();
    await page.locator(".bigtoggle", { hasText: /Send me alerts by email/ }).click();
    await expect(cta).toBeEnabled();
  });
}

test("CAS-253: the gate survives a repaint", async ({ page }) => {
  await toNotify(page, "stream");
  await page.locator(".bigtoggle", { hasText: /Send me alerts by email/ }).click();
  await expect(page.locator("#flowCta")).toBeDisabled();
  // Anything that repaints the button must not hand back a Continue the screen is not ready for.
  await page.evaluate(() => onbRefresh());
  await expect(page.locator("#flowCta")).toBeDisabled();
  await page.locator(".bigtoggle", { hasText: /Allow in-app/ }).click();
  await expect(page.locator("#flowCta")).toBeDisabled();
});
