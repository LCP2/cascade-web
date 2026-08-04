// CAS-336: product terminology shift — the top-of-list nav says Agents, not Cascades.
import { test, expect } from "@playwright/test";
import { toShortlist, shortlistCards, pickCard, finishFlow, toListing } from "./helpers.mjs";

test("CAS-336: the deck's section label and its New card both say Agent, not Cascade", async ({ page }) => {
  await toShortlist(page, "cinema");
  const first = await shortlistCards(page);
  await pickCard(page, first[0].name);
  await finishFlow(page);
  await toListing(page);

  // .casclbl is upper-cased by CSS (text-transform), so the text content itself is the thing to assert.
  await expect(page.locator("#cascLbl")).toHaveText("Agents");

  const newCard = page.locator(".dcard.new");
  await expect(newCard).toHaveAttribute("aria-label", "New Agent");
  await expect(newCard.locator(".dc-name")).toHaveText("New Agent");
});
