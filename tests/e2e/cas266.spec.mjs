// CAS-266: the edit screen is titled by what it does, not by what the agent is.
import { test, expect } from "@playwright/test";
import { toShortlist, shortlistCards, pickCard, finishFlow, toListing } from "./helpers.mjs";

/** Build an agent of `kind`, then open its Edit screen the way a person does. */
async function toEdit(page, kind){
  await toShortlist(page, kind);
  const cards = await shortlistCards(page);
  await pickCard(page, cards[0].name);
  await finishFlow(page);
  await toListing(page);
  await page.evaluate(() => window.editCascade());
  await expect(page.locator(".osh").first()).toBeVisible();
}

for(const kind of ["cinema", "stream"]){
  test(`CAS-266: a ${kind} agent's edit screen says Edit Agent`, async ({ page }) => {
    await toEdit(page, kind);
    await expect(page.locator("#onbStepInner .osh").first()).toHaveText("Edit Agent");
    await expect(page.locator("#onbStepInner .ossub").first()).toHaveText("Reconfigure this agent here.");
    // The old copy is gone, both halves of it.
    await expect(page.locator("#onbStepInner")).not.toContainText(/Briefing/);
    await expect(page.locator("#onbStepInner")).not.toContainText(/dip into any section/);
  });
}

test("CAS-266: the rows under it still work", async ({ page }) => {
  await toEdit(page, "cinema");
  await expect(page.locator("#onbStepInner .osdoor").first()).toBeVisible();
  await page.locator("#onbStepInner .osdoor").first().click();
  expect(await page.evaluate(() => onbStepKey), "the first row no longer opens its screen").not.toBe("briefing");
});
