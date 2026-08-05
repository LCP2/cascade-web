// CAS-336: product terminology shift — the deck says Agents, not Cascades.
// CAS-371 removed the #cascLbl "AGENTS" heading this spec used to check outright; the terminology now
// surfaces on each agent card's own type label instead (see cas371.spec.mjs), so that's what's asserted here.
import { test, expect } from "@playwright/test";
import { toShortlist, shortlistCards, pickCard, finishFlow, toListing } from "./helpers.mjs";

test("CAS-336: the open agent's type label and the New card both say Agent, not Cascade", async ({ page }) => {
  await toShortlist(page, "cinema");
  const first = await shortlistCards(page);
  await pickCard(page, first[0].name);
  await finishFlow(page);
  await toListing(page);

  // .dc-type is upper-cased by CSS (text-transform), so the text content itself is the thing to assert.
  await expect(page.locator(".dcard.is-active .dc-type")).toHaveText(/agent$/i);

  const newCard = page.locator(".dcard.new");
  await expect(newCard).toHaveAttribute("aria-label", "New Agent");
  await expect(newCard.locator(".dc-name")).toHaveText("New Agent");
});
