// CAS-562: splits the old combined Preferences page into two top-menu destinations (Languages, Where &
// when you'll watch — see cas551/cas532 specs for the menu-order/reachability coverage that split produced),
// gives the language chips a real selected treatment, and widens LANG_OPTS from a fixed dozen to every
// language code the live catalogue carries. This spec covers what's new here specifically: the chip's
// selected state, full catalogue coverage with no bare codes, and the xx/cn-zh decisions.
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

test("CAS-562: a selected language chip is filled and checked; an unselected one is neither", async ({ page }) => {
  await buildAgent(page, "cinema", "Blockbusters");
  await openLanguages(page);

  const english = page.locator("#languagesScreen .chip.gen", { hasText: "English" });
  await expect(english).toHaveClass(/\bon\b/);
  await expect(english).toContainText("✓");

  const french = page.locator("#languagesScreen .chip.gen", { hasText: "French" });
  await expect(french).not.toHaveClass(/\bon\b/);
  await expect(french).not.toContainText("✓");

  await french.click();
  await expect(french).toHaveClass(/\bon\b/);
  await expect(french).toContainText("✓");
});

test("CAS-562: the long tail sits behind a More languages expander, not a wall of chips", async ({ page }) => {
  await buildAgent(page, "cinema", "Blockbusters");
  await openLanguages(page);

  const totalOptions = await page.evaluate(() => LANG_OPTS.length);
  expect(totalOptions).toBeGreaterThan(12);   // CAS-562 widened this well past the old fixed dozen

  const visibleBefore = await page.locator("#languagesScreen .chip.gen").count();
  expect(visibleBefore).toBeLessThan(totalOptions);   // the tail isn't rendered flat by default

  const more = page.locator("#languagesScreen .chipmore");
  await expect(more).toBeVisible();
  await more.click();
  const visibleAfter = await page.locator("#languagesScreen .chip.gen").count();
  expect(visibleAfter).toBe(totalOptions);   // unfolded, every catalogue language is reachable
});

test("CAS-562: no language name ever falls back to a bare code", async ({ page }) => {
  await buildAgent(page, "cinema", "Blockbusters");
  const bareCodes = await page.evaluate(() =>
    LANG_OPTS.filter(code => langName(code) === code.toUpperCase()));
  expect(bareCodes).toEqual([]);
});

test("CAS-562: xx (no dialogue) is not offered as a language and always passes the filter, even when cleared", async ({ page }) => {
  await buildAgent(page, "cinema", "Blockbusters");
  const result = await page.evaluate(() => {
    const noDialogue = { language: "xx" };
    tasteBase.langs = null;   // Clear — "nothing qualifies"
    const underClear = passesTasteBase(noDialogue);
    tasteBase.langs = ["en"];   // narrowed to a language the title doesn't carry
    const underNarrow = passesTasteBase(noDialogue);
    return { inOptions: LANG_OPTS.includes("xx"), underClear, underNarrow };
  });
  expect(result.inOptions).toBe(false);
  expect(result.underClear).toBe(true);
  expect(result.underNarrow).toBe(true);
});

test("CAS-562: cn and zh are one Chinese chip, and selecting it matches both catalogue codes", async ({ page }) => {
  await buildAgent(page, "cinema", "Blockbusters");
  const result = await page.evaluate(() => {
    const chineseOptions = LANG_OPTS.filter(code => langName(code) === "Chinese");
    tasteBase.langs = ["zh"];
    const matchesZh = passesTasteBase({ language: "zh" });
    const matchesCn = passesTasteBase({ language: "cn" });
    return { chineseOptions, matchesZh, matchesCn };
  });
  expect(result.chineseOptions).toEqual(["zh"]);   // one selectable code, not two same-labelled chips
  expect(result.matchesZh).toBe(true);
  expect(result.matchesCn).toBe(true);
});

test("CAS-562: Select all stores [] and a wide-open agent then matches a language outside the old fixed dozen", async ({ page }) => {
  await buildAgent(page, "cinema", "Blockbusters");
  await openLanguages(page);

  // A code that only exists because CAS-562 widened LANG_OPTS past the old ["en","ko","ja","zh","fr","es",
  // "hi","it","de","th","sv","pt"] list — proves the expansion is actually reachable, not just present in
  // LANG_OPTS. Falls back to any newly-added code if the catalogue's exact tail composition drifts.
  const OLD_DOZEN = ["en","ko","ja","zh","fr","es","hi","it","de","th","sv","pt"];
  const widened = await page.evaluate(old => LANG_OPTS.filter(c => !old.includes(c)), OLD_DOZEN);
  expect(widened.length).toBeGreaterThan(0);

  await page.locator("#languagesScreen .q", { hasText: "Select all" }).click();
  const langs = await page.evaluate(() => tasteBase.langs);
  expect(langs).toEqual([]);

  const admitsWidenedLang = await page.evaluate(code => passesTasteBase({ language: code }), widened[0]);
  expect(admitsWidenedLang).toBe(true);
});

test("CAS-562: Clear still stores null and still means nothing qualifies (CAS-182)", async ({ page }) => {
  await buildAgent(page, "cinema", "Blockbusters");
  await openLanguages(page);

  await page.locator("#languagesScreen .q", { hasText: "Clear" }).click();
  const langs = await page.evaluate(() => tasteBase.langs);
  expect(langs).toBeNull();

  const admitsEnglish = await page.evaluate(() => passesTasteBase({ language: "en" }));
  expect(admitsEnglish).toBe(false);
});
