// CAS-267: the Edit screen asks the same questions, in the same words and the same order, as onboarding.
import { test, expect } from "@playwright/test";
import { toShortlist, shortlistCards, pickCard, finishFlow, toListing } from "./helpers.mjs";

async function toEdit(page, kind){
  await toShortlist(page, kind);
  const cards = await shortlistCards(page);
  await pickCard(page, cards[0].name);
  await finishFlow(page);
  await toListing(page);
  await page.evaluate(() => window.editCascade());
  await expect(page.locator("#onbStepInner .osdoor").first()).toBeVisible();
}

const rowNames = page => page.locator("#onbStepInner .osdoor .dh").allTextContents()
  .then(a => a.map(s => s.trim()));

test("CAS-267: a cinema agent's sections, named and ordered as asked", async ({ page }) => {
  await toEdit(page, "cinema");
  expect(await rowNames(page))
    .toEqual(["Agent Name", "Mission", "Style", "Rating", "Language", "Notifications"]);
});

test("CAS-267: a streaming agent keeps its two extra sections in their onboarding places", async ({ page }) => {
  await toEdit(page, "stream");
  expect(await rowNames(page))
    .toEqual(["Agent Name", "Mission", "Style", "Rating", "How far back", "Language",
              "Streaming services", "Notifications"]);
});

test("CAS-267: the old names are gone", async ({ page }) => {
  await toEdit(page, "cinema");
  const body = page.locator("#onbStepInner");
  for(const old of [/Set your bar/, /Agent settings/, /Age rating/, /^Genres$/]){
    await expect(body.locator(".dh", { hasText: old })).toHaveCount(0);
  }
});

test("CAS-267: every renamed row still opens the screen it names", async ({ page }) => {
  const expected = [["Mission", "selectivity"], ["Style", "genres"], ["Rating", "age"],
                    ["Notifications", "watching"]];
  for(const [label, step] of expected){
    await toEdit(page, "cinema");
    await page.locator("#onbStepInner .osdoor", { hasText: label }).click();
    expect(await page.evaluate(() => onbStepKey), `"${label}" opened the wrong screen`).toBe(step);
  }
});

test("CAS-267: the Edit sections follow the flow's own order", async ({ page }) => {
  await toEdit(page, "stream");
  const steps = await page.locator("#onbStepInner .osdoor").evaluateAll(
    els => els.map(e => (e.getAttribute("onclick") || "").replace(/.*briefGo\('|'\).*/g, "")));
  const flow = await page.evaluate(() => FLOWS.stream);
  // Every section that is also a flow step appears in the flow's relative order. `name` leads, because the
  // thing you are editing has to be named at the top of the screen that edits it.
  const inFlow = steps.filter(s => flow.includes(s) && s !== "name");
  const positions = inFlow.map(s => flow.indexOf(s));
  expect(positions, `sections run ${steps.join(" → ")}`).toEqual([...positions].sort((a, b) => a - b));
  expect(steps[0]).toBe("name");
});
