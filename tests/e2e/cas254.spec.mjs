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

test("CAS-254: with services picked, the banner says the list is scoped to them", async ({ page }) => {
  await toDeck(page);
  await page.evaluate(() => {
    prefs.sub.clear(); prefs.sub.add(SUB_SERVICES[0]); prefs.on = true; savePrefs();
    const c = activeCascade();
    c.myServices = { pvod: true, rental: true, included_streaming: true };
    saveCascades(); render();
  });
  const note = page.locator('[data-svcnote="scoped"]');
  await expect(note).toBeVisible();
  await expect(note).toContainText(/only showing films on your streaming services/i);
  await expect(note, "a scoped list is a fact, not a warning").toHaveClass(/info/);

  // …and it closes.
  await note.locator(".svcx").click();
  await expect(note).toHaveCount(0);
  await page.evaluate(() => render());
  await expect(page.locator('[data-svcnote="scoped"]'), "it came back after a repaint").toHaveCount(0);
});

test("CAS-254: with none picked it is still a warning, and dismissing one does not silence the other", async ({ page }) => {
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

  // Dismissing the SCOPED banner must not silence this one — it is the one you would most want to see.
  await page.evaluate(() => window.dismissSvcNote("scoped"));
  await page.evaluate(() => render());
  await expect(page.locator('[data-svcnote="empty"]'), "closing one banner silenced the other").toBeVisible();

  await page.locator('[data-svcnote="empty"] .svcx').click();
  await page.evaluate(() => render());
  await expect(page.locator('[data-svcnote="empty"]')).toHaveCount(0);
});
