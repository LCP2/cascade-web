// CAS-366: Mission step intro reads a single line, and the bottom "no score yet" caveat is gone —
// for both agent types, wherever Mission renders (first-run Onboarding here; New Cascade uses the
// same body() so covering both agent kinds through the first-run door is sufficient).
import { test, expect } from "@playwright/test";
import { toShortlist, shortlistCards, pickCard } from "./helpers.mjs";

for(const kind of ["cinema", "stream"]){
  test(`CAS-366: Mission step copy is correct for ${kind}`, async ({ page }) => {
    await toShortlist(page, kind);
    const first = await shortlistCards(page);
    await pickCard(page, first[0].name);

    // The dual-pane slide (gotoStep) leaves the outgoing pane's .ossub in the DOM, id-stripped, until its
    // 460ms transition ends — #onbStepInner always resolves to the current (incoming) pane, never the outgoing one.
    const intro = page.locator("#onbStepInner .ossub");
    await expect(intro).toHaveText("Set the standards a film has to meet.");
    await expect(page.locator("#onbSelSay")).toHaveCount(0);
    await expect(page.locator("#onbStepInner .osaside")).toHaveCount(0);

    // 390px is the reference mobile width (CAS-162/200) — the copy must not wrap there.
    const box = await intro.boundingBox();
    const lineHeight = await intro.evaluate(el => parseFloat(getComputedStyle(el).lineHeight));
    expect(box.height).toBeLessThanOrEqual(lineHeight * 1.5);
  });
}
