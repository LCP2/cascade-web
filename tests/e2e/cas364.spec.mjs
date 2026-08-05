// CAS-364: the onboarding setup summary no longer prints an "Agent" row, for either agent type.
import { test, expect } from "@playwright/test";
import { toShortlist, shortlistCards, pickCard } from "./helpers.mjs";

for (const kind of ["cinema", "stream"]) {
  test(`CAS-364 (${kind}): the setup trail carries no Agent row, but keeps its other rows`, async ({ page }) => {
    await toShortlist(page, kind);
    const cards = await shortlistCards(page);
    await pickCard(page, cards[0].name);

    // pickCard lands on Mission (selectivity), which is where the trail first appears — it recaps every
    // step walked so far, including the preset pick this ticket's row used to summarise.
    await expect(page.locator("#onbTrail")).toBeVisible();
    expect(await page.locator(".otrow", { has: page.locator(".otk", { hasText: "Agent" }) }).count(),
      "the trail should render no Agent row at all").toBe(0);

    // The trail itself survives for the steps that still have something to recap.
    await expect(page.locator(".otrow", { has: page.locator(".otk", { hasText: "Mission" }) })).toBeVisible();
  });
}
