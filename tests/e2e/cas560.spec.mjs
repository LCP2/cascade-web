// CAS-560: the per-agent language filter is retired. matchesCriteria no longer reads c.lang (Preferences'
// tasteBase.langs is the only language gate left), no new agent is seeded with a non-empty lang, and an
// existing agent's stray ["en"] is migrated to [] on load. Covered at the matching-logic level by
// tests/js/invariants.test.mjs ("language narrowing lives on tasteBase now…") — this spec covers what a
// person can actually click: building a new agent, reloading a device with a pre-CAS-560 agent already
// saved, and the Preferences language chip picker.
import { test, expect } from "@playwright/test";
import { freshApp, toShortlist, shortlistCards, pickCard, finishFlow, toListing } from "./helpers.mjs";

for(const kind of ["cinema", "stream"]){
  test(`CAS-560: a freshly built ${kind} agent carries no language criterion`, async ({ page }) => {
    await toShortlist(page, kind);
    const cards = await shortlistCards(page);
    await pickCard(page, cards[0].name);
    await finishFlow(page);
    await toListing(page);
    expect(await page.evaluate(() => cascades[0].lang)).toEqual([]);
  });
}

test("CAS-560: an agent saved before this ticket is migrated to lang:[] on load, and the migration is written back", async ({ page }) => {
  await freshApp(page);
  const legacy = { id: "33333333-3333-4333-8333-333333333333", name: "Pre-CAS-560 Agent", kind: "cinema",
    status: [], genre: [], age: [], lang: ["en"], culture: [], year: [] };
  await page.evaluate((c) => {
    localStorage.setItem("cascade_cascades", JSON.stringify([c]));
  }, legacy);

  await page.goto("/index.html");
  await page.waitForFunction(() => typeof flowStart === "function" && Array.isArray(MOVIES));

  // In memory: normCascade forces it on every load, no matter what.
  expect(await page.evaluate(() => cascades.find(c => c.id === "33333333-3333-4333-8333-333333333333").lang))
    .toEqual([]);
  // On disk: the one-shot migration (LANG_MIG_KEY) writes the corrected value back, so the raw saved JSON
  // stops carrying the stray ["en"] rather than only correcting it in memory on every future load.
  const raw = await page.evaluate(() => JSON.parse(localStorage.getItem("cascade_cascades")));
  expect(raw[0].lang).toEqual([]);

  // Idempotent: a second reload (migration already applied, LANG_MIG_KEY already set) leaves it exactly [].
  await page.goto("/index.html");
  await page.waitForFunction(() => typeof flowStart === "function" && Array.isArray(MOVIES));
  expect(await page.evaluate(() => cascades.find(c => c.id === "33333333-3333-4333-8333-333333333333").lang))
    .toEqual([]);
});

test("CAS-560: Preferences — ticking all 12 language chips individually stores [], same as the Select all button", async ({ page }) => {
  await toShortlist(page, "cinema");
  const cards = await shortlistCards(page);
  await pickCard(page, cards[0].name);
  await finishFlow(page);
  await toListing(page);

  await page.locator("#navMenuBtn").click();
  await page.locator("#navMenu .navitem", { hasText: "Preferences" }).click();
  await expect(page.locator("#preferencesScreen")).toHaveClass(/open/);

  const chips = page.locator("#preferencesScreen .chip");
  const n = await chips.count();
  expect(n).toBeGreaterThanOrEqual(12);
  for(let i = 0; i < n; i++){
    const chip = chips.nth(i);
    if(!(await chip.evaluate(el => el.classList.contains("on")))) await chip.click();
  }
  await expect(chips.first()).toHaveClass(/on/);
  expect(await page.evaluate(() => tasteBase.langs)).toEqual([]);
});
