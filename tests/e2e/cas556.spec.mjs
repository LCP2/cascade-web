// CAS-556: agent lane colour moves off the availability palette (--amber/--green) onto its own family,
// --lane-cin (deep) / --lane-str (light) — shades of the Agents chip's own blue. Covers the deck, Manage
// Agents (same --dcc convention, CAS-424), Rent/Upcoming's retuned values, and the header's short labels.
import { test, expect } from "@playwright/test";
import { toShortlist, shortlistCards, pickCard, finishFlow, toListing, settleListing } from "./helpers.mjs";

const LANE_CIN = "rgb(30, 69, 201)";   // #1E45C9
const LANE_STR = "rgb(147, 184, 255)"; // #93B8FF
const FAINT = "rgb(155, 165, 181)";    // --faint, #9ba5b5

/** One cinema agent (from onboarding) plus one streaming agent (added from the deck's "+ New" card),
 * landed back on the listing. Building the 2nd agent doesn't go through the onboarding tour — picking a
 * starter for an agent added after the first goes straight to the Briefing screen's own Save agent CTA. */
async function twoLaneAgents(page){
  await toShortlist(page, "cinema");
  const cinCards = await shortlistCards(page);
  await pickCard(page, cinCards[0].name);
  await finishFlow(page);
  await toListing(page);
  await settleListing(page);

  await page.evaluate(() => newCascade());
  await expect(page.locator(".priobtn.str")).toBeVisible();
  await page.locator(".priobtn.str").click();
  await expect(page.locator(".scard").first()).toBeVisible();
  const strCards = await shortlistCards(page);
  await page.locator(".scard", { has: page.locator(".sc-name", { hasText: strCards[0].name }) }).first().click();
  await page.locator(".oscta", { hasText: "Save agent" }).click();
  await settleListing(page);

  await page.locator("#agentsBtn").click();
}

test("CAS-556: deck cards read the cinema/streaming lane off --lane-cin/--lane-str, not --amber/--green", async ({ page }) => {
  await twoLaneAgents(page);

  const cinCard = page.locator(".dcard.agent-cin .dc-in").first();
  const strCard = page.locator(".dcard.agent-str .dc-in").first();
  await expect(cinCard).toBeVisible();
  await expect(strCard).toBeVisible();

  await expect.poll(() => cinCard.evaluate(el => getComputedStyle(el).borderLeftColor)).toBe(LANE_CIN);
  await expect.poll(() => strCard.evaluate(el => getComputedStyle(el).borderLeftColor)).toBe(LANE_STR);
});

test("CAS-556: Manage Agents rows share the deck's lane tokens, and the type label stays legible", async ({ page }) => {
  await twoLaneAgents(page);

  await page.locator("#navMenuBtn").click();
  await page.locator("#navMenu .navitem", { hasText: "Manage Agents" }).click();
  await expect(page.locator("#agentsScreen")).toHaveClass(/open/);

  const cinRow = page.locator(".agrow.agent-cin").first();
  const strRow = page.locator(".agrow.agent-str").first();
  await expect(cinRow).toBeVisible();
  await expect(strRow).toBeVisible();

  await expect.poll(() => cinRow.evaluate(el => getComputedStyle(el).borderLeftColor)).toBe(LANE_CIN);
  await expect.poll(() => strRow.evaluate(el => getComputedStyle(el).borderLeftColor)).toBe(LANE_STR);

  // The uppercase "Cinema agent"/"Streaming agent" label used to read the raw lane colour as text — a fail
  // against --lane-cin's dark navy. It now matches the deck's own .dc-type convention (--faint) on both rows.
  await expect.poll(() => cinRow.locator(".agtype").evaluate(el => getComputedStyle(el).color)).toBe(FAINT);
  await expect.poll(() => strRow.locator(".agtype").evaluate(el => getComputedStyle(el).color)).toBe(FAINT);
  await expect(cinRow.locator(".agtype")).toHaveText("Cinema agent");
  await expect(strRow.locator(".agtype")).toHaveText("Streaming agent");
});

test("CAS-556: Rent is retuned off blue, Upcoming is decoupled from the brand violet", async ({ page }) => {
  await toShortlist(page, "cinema");
  const cards = await shortlistCards(page);
  await pickCard(page, cards[0].name);
  await finishFlow(page);
  await toListing(page);
  await settleListing(page);

  const vals = await page.evaluate(() => {
    const cs = getComputedStyle(document.documentElement);
    return { blue: cs.getPropertyValue("--blue").trim(), upcoming: cs.getPropertyValue("--upcoming").trim() };
  });
  expect(vals.blue.toLowerCase()).toBe("#5fbfb3");
  expect(vals.upcoming.toLowerCase()).toBe("#7a3fd4");

  // Neither retuned value collides with the new agent lanes or with each other.
  expect(vals.blue.toLowerCase()).not.toBe("#93b8ff");
  expect(vals.upcoming.toLowerCase()).not.toBe("#7c5cff");
});

test("CAS-556: the header's short labels read Agents/Your Movies, and fit at 360px", async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 740 });
  await toShortlist(page, "stream");
  const cards = await shortlistCards(page);
  await pickCard(page, cards[0].name);
  await finishFlow(page);
  await toListing(page);
  await settleListing(page);

  const agentsShort = page.locator("#agentsBtn .mclabel-short");
  const moviesShort = page.locator("#moviesBtn .mclabel-short");
  await expect(agentsShort).toBeVisible();
  await expect(moviesShort).toBeVisible();
  await expect(agentsShort).toHaveText("Agents");
  await expect(moviesShort).toHaveText("Your Movies");

  // No wrap, no clipping: each label's own scrollWidth must fit inside its rendered box.
  const overflowing = await page.evaluate(() => {
    const labels = [document.querySelector("#agentsBtn .mclabel-short"), document.querySelector("#moviesBtn .mclabel-short")];
    return labels.map(l => l.scrollWidth > l.clientWidth + 1);
  });
  expect(overflowing).toEqual([false, false]);

  // The chip row itself doesn't push the page wider than the 360px viewport.
  const bodyScrollWidth = await page.evaluate(() => document.body.scrollWidth);
  expect(bodyScrollWidth).toBeLessThanOrEqual(360);
});
