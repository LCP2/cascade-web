// CAS-531: Edit Agent redesign — the agent's name moves into the page header (large title + edit pencil,
// replacing the old "Agent Name" row); Mission and Style become the primary, tinted cards and show every
// underlying selection instead of a one-line summary; Rating and How far back drop to a flat two-up row;
// "Where & when you'll watch" is gone from this page entirely, replaced by a pointer note to Preferences
// (CAS-532). Save/Delete are unchanged at the bottom.
import { test, expect } from "@playwright/test";
import { toShortlist, pickCard, finishFlow, toListing } from "./helpers.mjs";

async function openBriefing(page, kind, presetName){
  await toShortlist(page, kind);
  await pickCard(page, presetName);
  await finishFlow(page);
  await toListing(page);
  await page.locator("#agentsBtn").click();
  await expect(page.locator("#agentsScreen")).toHaveClass(/open/);
  const row = page.locator(".agrow", { has: page.locator(".agname", { hasText: presetName }) }).first();
  await row.locator(".ag-edit").click();
  await expect(page.locator("#onbStep")).toHaveClass(/open/);
  await expect(page.locator(".osh.eahn")).toBeVisible();
}

test("CAS-531: the agent's name is the page header, not a row in the list", async ({ page }) => {
  await openBriefing(page, "cinema", "Blockbusters");

  // The old "Agent Name" door is gone — the name lives in the header instead.
  await expect(page.locator(".osdoor", { hasText: "Agent Name" })).toHaveCount(0);
  await expect(page.locator(".osh.eahn")).toHaveText("Blockbusters");

  await page.locator(".eapenc").click();
  await expect(page.locator(".osh", { hasText: "Name your Agent" })).toBeVisible();
  const field = page.locator("#onbStepName");
  await field.fill("Big Loud Films");
  await page.locator("#onbStepCta").click();

  // Done on a Briefing spoke returns to the hub, header repainted with the new name.
  await expect(page.locator(".osh.eahn")).toHaveText("Big Loud Films");
});

test("CAS-531: Mission is the first, tinted card and spells out every dial as its own line", async ({ page }) => {
  await openBriefing(page, "cinema", "Blockbusters");

  const mission = page.locator(".eacard.msn");
  const style = page.locator(".eacard.sty");
  await expect(mission).toBeVisible();
  await expect(style).toBeVisible();

  // Mission comes before Style in the DOM (the promoted order the ticket asks for).
  const order = await page.evaluate(() => {
    const all = [...document.querySelectorAll(".eacard")];
    return all.map(el => el.classList.contains("msn") ? "msn" : "sty");
  });
  expect(order.indexOf("msn")).toBeLessThan(order.indexOf("sty"));

  // Blockbusters' preset bar is Studio · $56M+ · Talked-about — the old one-liner. The card now spells out
  // all three as their own lines instead of folding them into "Studio · $56M+".
  await expect(mission.locator(".eamhead")).toHaveText("Studio release");
  const lines = await mission.locator(".eamline").allTextContents();
  expect(lines).toEqual(["Budget $56M or more", "Talked-about buzz required"]);
});

test("CAS-531: Style shows real chips, not a count, and truncates a long selection behind +N more", async ({ page }) => {
  await openBriefing(page, "cinema", "Blockbusters");

  // The preset leaves every genre open — the card says so in words, same principle as "All ratings".
  await expect(page.locator(".eacard.sty .eaempty")).toHaveText("All genres");
  await expect(page.locator(".eacard.sty .chip")).toHaveCount(0);

  // Narrow the agent's genres to exactly 10, by tapping real chips on the real Style screen.
  await page.locator(".eacard.sty").click();
  await expect(page.locator(".osh", { hasText: "Style" })).toBeVisible();
  await page.locator("button.q", { hasText: "Clear all" }).click();
  const genreChips = page.locator("#onbStepGenres .chip.gen");
  const picked = [];
  for(let i = 0; i < 10; i++){
    const chip = genreChips.nth(i);
    picked.push((await chip.evaluate(el => el.dataset.chipkey)));
    await chip.click();
  }
  await page.locator("#onbStepCta").click();      // Done — back to the hub
  await expect(page.locator(".osh.eahn")).toBeVisible();

  const shownChips = await page.locator(".eacard.sty .chip.on.gen").allTextContents();
  expect(shownChips).toEqual(picked.slice(0, 8));
  await expect(page.locator(".eacard.sty .chip.svcmore")).toHaveText("+2 more");
});

test("CAS-531: Rating and How far back sit in a flat two-up row, with real selections spelled out", async ({ page }) => {
  await openBriefing(page, "cinema", "Blockbusters");

  // A cinema agent has no "How far back" dial — only Rating shows, still inside the two-up row.
  const secRow = page.locator(".easec");
  await expect(secRow.locator(".easub")).toHaveCount(1);
  await expect(secRow.locator(".eash")).toHaveText("Rating");
  // Blockbusters' preset default excludes G/PG (non-family presets default to M and up, see the /family/i
  // check near AGE_LEVELS.filter(a=>!GENTLE.has(a))) — the card should say so, not summarise as "All ratings".
  await expect(secRow.locator(".easv")).toHaveText("M, MA 15+, R 18+");
  // The Rating/How-far-back row is visually flat/secondary — no violet or cyan tint like Mission/Style.
  await expect(page.locator(".easub").first()).not.toHaveClass(/eacard/);

  // Narrow to G and PG only, on the real ratings control. Each segment is an independent toggle and the
  // preset starts at M/MA 15+/R 18+ (G, PG already off), so getting to "G, PG only" means flipping every
  // segment: the two currently-off ones turn on, the three currently-on ones turn off.
  await secRow.locator(".easub").first().click();
  await expect(page.locator(".osh", { hasText: "Ratings" })).toBeVisible();
  const segs = page.locator("#onbStepAges .rseg");
  const n = await segs.count();
  for(let i = 0; i < n; i++) await segs.nth(i).click();
  await page.locator("#onbStepCta").click();

  await expect(page.locator(".easec .easv")).toHaveText("G, PG");
});

test("CAS-531: \"Where & when you'll watch\" is gone from this page — a pointer note to Preferences stands in", async ({ page }) => {
  await openBriefing(page, "cinema", "Blockbusters");

  await expect(page.locator(".osdoor", { hasText: "Where & when you'll watch" })).toHaveCount(0);
  await expect(page.locator("button", { hasText: "Where & when you'll watch" })).toHaveCount(0);

  const note = page.locator(".eaptr");
  await expect(note).toBeVisible();
  await expect(note).toContainText("Where & when you'll watch now lives in Preferences");
  await expect(note).toContainText("applies to every agent");

  // Save/Delete are unchanged at the bottom.
  await expect(page.locator(".oscta", { hasText: "Save agent" })).toBeVisible();
  await expect(page.locator(".osdel", { hasText: "Delete agent" })).toBeVisible();
});

test("CAS-531: a streaming agent's Mission spells out vote and critic thresholds, and gets both secondary rows", async ({ page }) => {
  await openBriefing(page, "stream", "Loved & Acclaimed");

  const mission = page.locator(".eacard.msn");
  await expect(mission.locator(".eamhead")).toHaveText("Loved");
  const lines = await mission.locator(".eamline").allTextContents();
  expect(lines).toEqual(["People's vote 7.5+", "Critic score 80+"]);

  // A streaming agent DOES have a "How far back" dial, so the two-up row carries both cards.
  await expect(page.locator(".easec .easub")).toHaveCount(2);
  await expect(page.locator(".easec .eash").nth(1)).toHaveText("How far back");
});
