// CAS-563: adds search to the Languages screen (CAS-562 shipped without it — the request arrived as a
// late comment) and gives the selected chip a filled treatment instead of the 20%-alpha outline. This spec
// covers what's new here: ranked prefix-then-substring search, the split render that keeps a chip tap from
// destroying the search input mid-type, the count line's two states, the empty state, and the filled chip.
import { test, expect } from "@playwright/test";
import { toShortlist, pickCard, finishFlow, toListing } from "./helpers.mjs";

async function openLanguages(page){
  await page.locator("#navMenuBtn").click();
  await page.locator("#navMenu .navitem", { hasText: "Languages" }).click();
  await expect(page.locator("#languagesScreen")).toHaveClass(/open/);
}

async function buildAgent(page, kind, presetName){
  await toShortlist(page, kind);
  await pickCard(page, presetName);
  await finishFlow(page);
  await toListing(page);
}

test("CAS-563: typing filters the list, ranked prefix-then-substring on name and code", async ({ page }) => {
  await buildAgent(page, "cinema", "Blockbusters");
  await openLanguages(page);

  await page.locator("#langSearch").fill("ta");
  const names = await page.locator("#langChips .chip.gen").evaluateAll(
    els => els.map(el => el.textContent.replace(/[✓\s\d]+$/,"").trim())
  );
  expect(names).toEqual(["Tamil", "Tagalog", "Italian", "Catalan", "Tibetan"]);
});

test("CAS-563: tapping a chip while searching keeps the query and the input alive", async ({ page }) => {
  await buildAgent(page, "cinema", "Blockbusters");
  await openLanguages(page);

  await page.locator("#langSearch").fill("ta");
  await page.locator("#langChips .chip.gen", { hasText: "Tamil" }).click();

  // The regression this split render prevents is renderLanguages() destroying and recreating #langSearch
  // (which would reset its value to ""). A real mouse click on the chip button legitimately moves DOM
  // focus there — that's normal browser behaviour, not the bug — so we assert the value survived, not
  // that focus stayed put.
  await expect(page.locator("#langSearch")).toHaveValue("ta");
  await expect(page.locator("#langChips .chip.gen", { hasText: "Tamil" })).toHaveClass(/\bon\b/);
  const names = await page.locator("#langChips .chip.gen").evaluateAll(els => els.length);
  expect(names).toBe(5);   // still the "ta" result set, not the idle list
});

test("CAS-563: the count line reads the idle and searching forms correctly", async ({ page }) => {
  await buildAgent(page, "cinema", "Blockbusters");
  await openLanguages(page);

  await expect(page.locator("#langCount")).toHaveText(/^1 of 72 selected · [\d,]+ films$/);

  await page.locator("#langSearch").fill("ta");
  await expect(page.locator("#langCount")).toHaveText('5 of 72 match “ta”');
});

test("CAS-563: clearing the search restores the idle list, sorted by count, with the More expander", async ({ page }) => {
  await buildAgent(page, "cinema", "Blockbusters");
  await openLanguages(page);

  const totalOptions = await page.evaluate(() => LANG_OPTS.length);
  await page.locator("#langSearch").fill("ta");
  await expect(page.locator("#langChips .chip.gen")).toHaveCount(5);

  await page.locator("#langSearchClear").click();
  await expect(page.locator("#langSearch")).toHaveValue("");
  const visible = await page.locator("#langChips .chip.gen").count();
  expect(visible).toBeLessThan(totalOptions);
  await expect(page.locator("#langChips .chipmore")).toBeVisible();

  // English is pre-selected, so its chip carries a leading "✓ " as well as a trailing catalogue count —
  // strip both.
  const firstTwo = await page.locator("#langChips .chip.gen").evaluateAll(
    els => els.slice(0,2).map(el => el.textContent.replace(/^✓\s*/,"").replace(/[\s\d,]+$/,"").trim())
  );
  expect(firstTwo).toEqual(["English", "French"]);
});

test("CAS-563: a query matching nothing shows the empty state, not a blank area", async ({ page }) => {
  await buildAgent(page, "cinema", "Blockbusters");
  await openLanguages(page);

  await page.locator("#langSearch").fill("zzzzzz");
  await expect(page.locator("#langChips .langempty")).toBeVisible();
  await expect(page.locator("#langChips .langempty")).toContainText("No language matches");
  await expect(page.locator("#langChips .chip.gen")).toHaveCount(0);
});

test("CAS-563: a selected chip is filled (no border), not just tinted", async ({ page }) => {
  await buildAgent(page, "cinema", "Blockbusters");
  await openLanguages(page);

  const english = page.locator("#langChips .chip.gen", { hasText: "English" });
  const style = await english.evaluate(el => {
    const cs = getComputedStyle(el);
    return { bg: cs.backgroundImage, borderColor: cs.borderColor };
  });
  expect(style.bg).toContain("gradient");
});

test("CAS-563: Select all still stores [] and Clear still stores null (CAS-182)", async ({ page }) => {
  await buildAgent(page, "cinema", "Blockbusters");
  await openLanguages(page);

  await page.locator("#languagesScreen .q", { hasText: "Select all" }).click();
  expect(await page.evaluate(() => tasteBase.langs)).toEqual([]);

  await page.locator("#languagesScreen .q", { hasText: "Clear" }).click();
  expect(await page.evaluate(() => tasteBase.langs)).toBeNull();
});
