// CAS-254: the services banner says what is actually happening, and can be closed.
import { test, expect } from "@playwright/test";
import { toShortlist, shortlistCards, pickCard, finishFlow, toListing, settleListing } from "./helpers.mjs";

async function toDeck(page){
  await toShortlist(page, "stream");
  const cards = await shortlistCards(page);
  await pickCard(page, cards[0].name);
  await finishFlow(page);
  await toListing(page);
  await settleListing(page);
}

test("CAS-254/CAS-321: with services picked, the \"scoped\" banner is gone — the Jump-to chips carry that fact now", async ({ page }) => {
  await toDeck(page);
  await page.evaluate(() => {
    prefs.sub.clear(); prefs.sub.add(SUB_SERVICES[0]); prefs.on = true; savePrefs();
    const c = activeCascade();
    c.myServices = { pvod: true, rental: true, included_streaming: true };
    saveCascades(); render();
  });
  await expect(page.locator('[data-svcnote="scoped"]')).toHaveCount(0);
});

test("CAS-254: with none picked it is still a warning, and dismissing the (gone) scoped state does not silence it", async ({ page }) => {
  await toDeck(page);
  await page.evaluate(() => {
    prefs.sub.clear(); prefs.store.clear(); prefs.on = true; savePrefs();
    const c = activeCascade();
    c.myServices = { pvod: true, rental: true, included_streaming: true };
    saveCascades(); render();
  });
  const warn = page.locator('[data-svcnote="empty"]');
  await expect(warn).toBeVisible();
  await expect(warn).toContainText(/nothing qualifies/i);
  await expect(warn, "the empty case must not be dressed as an ordinary note").not.toHaveClass(/info/);
  await expect(warn.locator(".ctabtn")).toContainText(/Pick your services/i);

  // CAS-321 removed the scoped banner, but dismissSvcNote is still state-keyed — calling it for the state
  // that no longer renders must still leave the empty warning alone.
  await page.evaluate(() => window.dismissSvcNote("scoped"));
  await page.evaluate(() => render());
  await expect(page.locator('[data-svcnote="empty"]'), "closing one banner silenced the other").toBeVisible();

  await page.locator('[data-svcnote="empty"] .svcx').click();
  await page.evaluate(() => render());
  await expect(page.locator('[data-svcnote="empty"]')).toHaveCount(0);
});
