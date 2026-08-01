// CAS-263: the pick-agent explainer names the choice on the screen.
import { test, expect } from "@playwright/test";
import { toShortlist } from "./helpers.mjs";

for(const kind of ["cinema", "stream"]){
  test(`CAS-263: the ${kind} shortlist carries the new explainer`, async ({ page }) => {
    await toShortlist(page, kind);
    const sub = page.locator("#onbStepInner .ossub").first();
    await expect(sub).toHaveText("Choose a pre configured Agent or go totally custom.");
    // …and the promise it makes is on the screen: a custom card to go custom with.
    await expect(page.locator(".scard", { hasText: "Totally Custom" })).toHaveCount(1);
  });
}
