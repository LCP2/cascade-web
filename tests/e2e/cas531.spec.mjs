// CAS-531: Edit Agent redesign — the agent's name moves into the page header (large title + edit pencil,
// replacing the old "Agent Name" row); Mission becomes the primary, tinted card and shows every underlying
// selection instead of a one-line summary; "Where & when you'll watch" is gone from this page entirely,
// replaced by a pointer note to Preferences (CAS-532).
//
// CAS-532 (signed off the same day, description #3) superseded this ticket's own Style-chips and
// Rating/How-far-back two-up-row requirements: "Genre, How far back and Age rating are removed... no UI
// for them at all going forward." That shipped in 214a32a and retired styleChipsHTML/ratingFullText/the
// Briefing's Style+Rating rows outright (see the CAS-532 comment above missionDetail() in app_template.html).
// The Style- and Rating/How-far-back-specific assertions this spec originally had are gone from here too —
// they tested a UI CAS-532 deliberately removed, not a regression. Save/Delete are unchanged at the bottom.
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

test("CAS-531: Mission is the primary, tinted card and spells out every dial as its own line", async ({ page }) => {
  await openBriefing(page, "cinema", "Blockbusters");

  const mission = page.locator(".eacard.msn");
  await expect(mission).toBeVisible();

  // CAS-532 retired Style/Rating/How-far-back everywhere — Mission is the only card on this page now, and
  // there is no per-agent Style door left to promote it above.
  await expect(page.locator(".eacard.sty")).toHaveCount(0);

  // Blockbusters' preset bar is Studio · $56M+ · Talked-about — the old one-liner. The card now spells out
  // all three as their own lines instead of folding them into "Studio · $56M+".
  await expect(mission.locator(".eamhead")).toHaveText("Studio release");
  const lines = await mission.locator(".eamline").allTextContents();
  expect(lines).toEqual(["Budget $56M or more", "Talked-about buzz required"]);
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

test("CAS-531: a streaming agent's Mission spells out vote and critic thresholds", async ({ page }) => {
  await openBriefing(page, "stream", "Loved & Acclaimed");

  const mission = page.locator(".eacard.msn");
  await expect(mission.locator(".eamhead")).toHaveText("Loved");
  const lines = await mission.locator(".eamline").allTextContents();
  expect(lines).toEqual(["People's vote 7.5+", "Critic score 80+"]);
});
