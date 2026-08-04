// CAS-338: the Language step is gone from first-run onboarding in both lanes — the agent assumes English.
// The Language control itself is untouched; it just no longer sits in FLOWS, so Agent Settings / New Cascade
// / Edit Agent (the `briefing` hub, CAS-267) still reaches it via its own door.
import { test, expect } from "@playwright/test";
import { toShortlist, shortlistCards, pickCard, finishFlow, ctaLocator } from "./helpers.mjs";

for(const kind of ["cinema", "stream"]){
  test(`CAS-338: the ${kind} onboarding flow never steps on Language`, async ({ page }) => {
    await toShortlist(page, kind);
    const cards = await shortlistCards(page);
    await pickCard(page, cards[0].name);

    expect(await page.evaluate(k => FLOWS[k].includes("language"), kind),
      `FLOWS.${kind} should no longer list a language step`).toBe(false);

    for(let i = 0; i < 15; i++){
      const stillInFlow = await page.evaluate(() => flowOn === true);
      if(!stillInFlow) break;
      await expect(page.locator(".osh", { hasText: "Language" })).toHaveCount(0);
      await ctaLocator(page).click();
      await page.waitForTimeout(120);
    }
    await expect(page.locator("#membScreen.open")).toBeVisible();
  });

  test(`CAS-338: a freshly built ${kind} agent assumes English`, async ({ page }) => {
    await toShortlist(page, kind);
    const cards = await shortlistCards(page);
    await pickCard(page, cards[0].name);
    await finishFlow(page);
    const lang = await page.evaluate(() => (onbFlow.draft || {}).lang);
    expect(lang).toEqual(["en"]);
  });
}

test("CAS-338: the Language control is still reachable from Edit Agent", async ({ page }) => {
  await toShortlist(page, "stream");
  const cards = await shortlistCards(page);
  await pickCard(page, cards[0].name);
  await finishFlow(page);
  await page.locator(".membcta").click();
  await expect(page.locator("#membScreen.open")).toBeHidden({ timeout: 30_000 });
  await page.evaluate(() => window.editCascade());
  await page.locator("#onbStepInner .osdoor", { hasText: "Language" }).click();
  expect(await page.evaluate(() => onbStepKey)).toBe("language");
  await expect(page.locator(".osh", { hasText: "Language" })).toBeVisible();
});
