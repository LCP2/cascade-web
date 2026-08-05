// CAS-372: the Name-your-Agent step no longer prefills with the "Streaming "/"Cinema " channel word —
// the box shows (and, left untouched, saves) the preset name alone. The card and starterPreview still
// disambiguate with the channel word (CAS-218/222); only this step's field drops it. Covers both agent
// types through the first-run door — New Cascade (CAS-246) reuses the same "name" step body/wire, so
// covering onboarding is sufficient (see cas366.spec.mjs for the same reasoning).
import { test, expect } from "@playwright/test";
import { toShortlist, shortlistCards, pickCard, finishFlow, toListing } from "./helpers.mjs";

for(const kind of ["cinema", "stream"]){
  test(`CAS-372: Name step prefill has no channel prefix for ${kind}`, async ({ page }) => {
    await toShortlist(page, kind);
    const cards = await shortlistCards(page);
    await pickCard(page, cards[0].name);
    await page.evaluate(() => window.gotoStep("name", "none"));
    await expect(page.locator(".osh", { hasText: "Name your Agent" })).toBeVisible();

    const field = page.locator("#onbStepName");
    const value = await field.inputValue();
    const placeholder = await field.getAttribute("placeholder");
    expect(value).toBe(cards[0].name);
    expect(placeholder).toBe(cards[0].name);
    expect(value.startsWith("Cinema ")).toBe(false);
    expect(value.startsWith("Streaming ")).toBe(false);
  });
}

test("CAS-372: leaving the prefill untouched saves the agent without the channel prefix", async ({ page }) => {
  await toShortlist(page, "cinema");
  const cards = await shortlistCards(page);
  await pickCard(page, cards[0].name);
  await finishFlow(page);           // clicks Continue through every step, never typing into Name
  await toListing(page);
  const made = await page.evaluate(() => cascades[cascades.length - 1]);
  expect(made.name).toBe(cards[0].name);
});

test("CAS-372: the field stays fully editable and the blank-field fallback also drops the prefix", async ({ page }) => {
  await toShortlist(page, "cinema");
  const cards = await shortlistCards(page);
  await pickCard(page, cards[0].name);
  await page.evaluate(() => window.gotoStep("name", "none"));

  const field = page.locator("#onbStepName");
  await field.fill("My Own Name");
  await expect(field).toHaveValue("My Own Name");
  expect(await page.evaluate(() => onbFlow.name)).toBe("My Own Name");

  await field.fill("");
  await expect(page.locator("#onbNameNote")).toHaveText(`Leave it blank and it'll be called ${cards[0].name}.`);
});
