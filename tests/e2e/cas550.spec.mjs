// CAS-550: Edit Agent gets Style back as a primary card (Mission's structural equal — icon, uppercase
// eyebrow, big headline, summary lines, chevron), and Rating / How far back back as the flat `.easec`
// secondary row. CAS-532 retired all three "everywhere" by deliberate decision; this ticket reverses that
// part of it by a later decision, restoring the per-agent doors CAS-531 designed (spoke screens, CSS and
// filter plumbing were never deleted — only the hub rows and their FLOWS entries were). How far back stays
// off a cinema agent: its year cutoff is a no-op there.
import { test, expect } from "@playwright/test";
import { toShortlist, pickCard, finishFlow, toListing } from "./helpers.mjs";

async function openBriefing(page, kind, presetName){
  await toShortlist(page, kind);
  await pickCard(page, presetName);
  await finishFlow(page);
  await toListing(page);
  await page.locator("#navMenuBtn").click();
  await page.locator("#navMenu .navitem", { hasText: "Manage Agents" }).click();
  await expect(page.locator("#agentsScreen")).toHaveClass(/open/);
  const row = page.locator(".agrow", { has: page.locator(".agname", { hasText: presetName }) }).first();
  await row.locator(".ag-edit").click();
  await expect(page.locator("#onbStep")).toHaveClass(/open/);
  await expect(page.locator(".osh.eahn")).toBeVisible();
}

test("CAS-550: a cinema agent's Edit Agent hub shows Mission, Style and Rating — no How far back", async ({ page }) => {
  await openBriefing(page, "cinema", "Blockbusters");

  await expect(page.locator(".eacard")).toHaveCount(2);        // Mission + Style
  await expect(page.locator(".eacard.msn .eachd .dh")).toHaveText("Mission");
  await expect(page.locator(".eacard.sty .eachd .dh")).toHaveText("Style");

  const subs = page.locator(".easec .easub");
  await expect(subs).toHaveCount(1);
  await expect(subs.locator(".eash")).toHaveText("Rating");
  await expect(page.locator(".easub", { hasText: "How far back" })).toHaveCount(0);
});

test("CAS-550: a streaming agent's Edit Agent hub shows all four doors, including How far back", async ({ page }) => {
  await openBriefing(page, "stream", "Loved & Acclaimed");

  await expect(page.locator(".eacard")).toHaveCount(2);        // Mission + Style
  const subs = page.locator(".easec .easub");
  await expect(subs).toHaveCount(2);
  await expect(subs.nth(0).locator(".eash")).toHaveText("Rating");
  await expect(subs.nth(1).locator(".eash")).toHaveText("How far back");
});

test("CAS-550: Style is Mission's structural equal, and narrowing it moves the matched count and survives Save", async ({ page }) => {
  await openBriefing(page, "cinema", "Blockbusters");

  const mission = page.locator(".eacard.msn"), style = page.locator(".eacard.sty");
  // Same internal shape as Mission: icon + eyebrow, headline, summary lines, chevron.
  for (const card of [mission, style]) {
    await expect(card.locator(".eachd .di")).toBeVisible();
    await expect(card.locator(".eamhead")).toBeVisible();
    await expect(card.locator(".eamlines .eamline").first()).toBeVisible();
    await expect(card.locator(".dc")).toHaveText("›");
  }
  // Blockbusters' preset carries no genre standard of its own (crit.genre: []) — wide open.
  await expect(style.locator(".eamhead")).toHaveText("All styles");

  const genreTotal = await page.evaluate(() => ONB_GENRES.length);
  const before = await page.locator(".oscount").first().textContent();
  const beforeN = Number(before.match(/\d+/)[0]);

  await style.click();
  await expect(page.locator(".osh", { hasText: "Style" })).toBeVisible();
  // Turn off the very first chip — a strict narrowing from "all genres" to "all but one".
  const firstChip = page.locator("#onbStepGenres .chip.gen").first();
  await expect(firstChip).toHaveClass(/on/);
  await firstChip.click();
  await expect(firstChip).not.toHaveClass(/on/);
  await page.locator("#onbStepCta").click();               // Done → back to the hub

  await expect(style.locator(".eamhead")).toHaveText(`${genreTotal - 1} of ${genreTotal} styles`);
  const after = await page.locator(".oscount").first().textContent();
  const afterN = Number(after.match(/\d+/)[0]);
  expect(afterN).toBeLessThan(beforeN);

  await page.locator(".oscta", { hasText: "Save agent" }).click();
  await expect(page.locator("#onbStep")).not.toHaveClass(/open/);
  const saved = await page.evaluate(() => cascades[0].genre);
  expect(saved).toHaveLength(genreTotal - 1);
});

test("CAS-550: Rating and How far back open their existing spokes and a change survives Save", async ({ page }) => {
  await openBriefing(page, "stream", "Loved & Acclaimed");

  const ratingSub = page.locator(".easec .easub").filter({ has: page.locator(".eash", { hasText: "Rating" }) });
  const before = await ratingSub.locator(".easv").textContent();

  await ratingSub.click();
  await expect(page.locator(".osh", { hasText: "Ratings" })).toBeVisible();
  const onSegs = page.locator("#onbStepAges .rseg.on");
  const onCountBefore = await onSegs.count();
  await onSegs.first().click();                             // turn one rating off
  await page.locator("#onbStepCta").click();                // Done → back to the hub

  const after = await ratingSub.locator(".easv").textContent();
  expect(after).not.toBe(before);

  const yearsSub = page.locator(".easub", { hasText: "How far back" });
  await expect(yearsSub).toBeVisible();
  await yearsSub.click();
  await expect(page.locator(".osh", { hasText: "How far back?" })).toBeVisible();
  await page.locator("#onbStepCta").click();                // Done, unchanged → back to the hub

  await page.locator(".oscta", { hasText: "Save agent" }).click();
  await expect(page.locator("#onbStep")).not.toHaveClass(/open/);
  const savedAge = await page.evaluate(() => cascades[0].age);
  expect(savedAge).toHaveLength(onCountBefore - 1);
});
