// CAS-246: "+ New Cascade" is the onboarding funnel, not a template grid.
import { test, expect } from "@playwright/test";
import { toShortlist, shortlistCards, pickCard, finishFlow, toListing, settleListing } from "./helpers.mjs";

test("CAS-246: New Cascade runs priority → pick an agent → the Briefing, and Save creates it", async ({ page }) => {
  // Get one agent made and land in the listing, which is where "+ New Cascade" lives.
  await toShortlist(page, "cinema");
  const first = await shortlistCards(page);
  await pickCard(page, first[0].name);
  await finishFlow(page);
  await toListing(page);
  await settleListing(page);
  const before = await page.evaluate(() => cascades.length);

  // …and make a second one the way a person does.
  await page.evaluate(() => window.newCascade());
  await expect(page.locator(".osh.prioh")).toBeVisible();
  const step1 = await page.evaluate(() => onbStepKey);
  expect(step1, "New Cascade must start on the priority question").toBe("priority");

  await page.evaluate(() => window.flowPriority("stream"));
  expect(await page.evaluate(() => onbStepKey), "…then the pick-agent screen").toBe("pickagent");

  const cards = await page.locator("#onbStep .scard").allTextContents();
  expect(cards.length, "the pick-agent screen must offer the streaming presets").toBeGreaterThan(1);
  await page.locator("#onbStep .scard").first().click();

  // …and lands in the Briefing, on the agent just picked, with Save.
  expect(await page.evaluate(() => onbStepKey), "…and lands in the Briefing").toBe("briefing");
  // CAS-266 renamed this screen's title to "Edit Agent"; the step it IS is still `briefing`, asserted above.
  await expect(page.locator(".osh", { hasText: /Edit Agent/ })).toBeVisible();
  await expect(page.locator(".oscta", { hasText: "Save agent" })).toBeVisible();
  const draftState = await page.evaluate(() => ({ id: onbFlow.draft.id, kind: onbFlow.draft.kind }));
  expect(draftState.id, "the agent must not be on the deck before Save").toBe(null);
  expect(draftState.kind).toBe("stream");
  expect(await page.evaluate(() => cascades.length), "nothing may be created before Save").toBe(before);

  await page.locator(".oscta", { hasText: "Save agent" }).click();
  expect(await page.evaluate(() => cascades.length), "Save must create the agent").toBe(before + 1);
  const made = await page.evaluate(() => cascades[cascades.length - 1]);
  expect(made.kind).toBe("stream");
});

test("CAS-246: the keyword parser and the template grid are gone", async ({ page }) => {
  await toShortlist(page, "cinema");
  const cards = await shortlistCards(page);
  await pickCard(page, cards[0].name);
  await finishFlow(page);
  await toListing(page);

  for(const id of ["tplPane", "tplGrid", "tplSoon", "nlInput", "nlGo"]){
    await expect(page.locator(`#${id}`), `#${id} should have gone with the screen`).toHaveCount(0);
  }
  const gone = await page.evaluate(() => ({
    nlDraft: typeof window.nlDraft, parseNL: typeof window.parseNL,
  }));
  expect(gone.nlDraft).toBe("undefined");
  // The page must not have thrown on load wiring handlers to elements that no longer exist.
  const alive = await page.evaluate(() => typeof window.newCascade === "function" && MOVIES.length > 0);
  expect(alive, "the engine did not finish evaluating").toBe(true);
});
