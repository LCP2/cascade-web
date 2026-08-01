// CAS-275: a jump-to control in the cascade band.
import { test, expect } from "@playwright/test";
import { toShortlist, shortlistCards, pickCard, finishFlow, toListing, sectionCounts } from "./helpers.mjs";

async function toAgentListing(page, kind = "cinema"){
  await toShortlist(page, kind);
  const cards = await shortlistCards(page);
  await pickCard(page, cards[0].name);
  await finishFlow(page);
  await toListing(page);
}

test("CAS-275: the jump rail lives in the cascade band and offers the sections that exist", async ({ page }) => {
  await toAgentListing(page);
  const sections = await sectionCounts(page);
  test.skip(sections.length < 2, "this agent's listing has only one section today");

  await expect(page.locator("#jumpBar")).toBeVisible();
  // It really is inside the band, not floating above the list.
  expect(await page.evaluate(() => !!document.querySelector("#cascbar #jumpBar"))).toBe(true);

  const chips = await page.locator("#jumpBar .jchip").evaluateAll(bs => bs.map(b => b.dataset.jump));
  expect(chips, "one chip per section, in the listing's own order").toEqual(sections.map(s => s.window));
});

test("CAS-275: it never offers a destination that is not in the list", async ({ page }) => {
  await toAgentListing(page);
  const sections = await sectionCounts(page);
  test.skip(sections.length < 2, "this agent's listing has only one section today");

  const chips = await page.locator("#jumpBar .jchip").evaluateAll(bs => bs.map(b => b.dataset.jump));
  for(const k of chips){
    await expect(page.locator(`#groups .group[data-g="${k}"]`)).toHaveCount(1);
  }
});

test("CAS-275: tapping a chip brings that section's heading into view, clear of the sticky band", async ({ page }) => {
  await toAgentListing(page);
  const sections = await sectionCounts(page);
  test.skip(sections.length < 2, "this agent's listing has only one section today");

  // The last section is the one furthest down, so it is the real test of the control.
  const target = sections[sections.length - 1].window;
  await page.locator(`#jumpBar .jchip[data-jump="${target}"]`).click();
  // Wait for the smooth scroll to SETTLE rather than guessing a duration. CAS-295 reordered the cinema lane
  // so the jump can now be several thousand pixels, and a fixed wait raced it.
  await page.waitForFunction(() => {
    const y = window.scrollY;
    if(window.__lastY === y){ return true; }
    window.__lastY = y;
    return false;
  }, null, { polling: 120, timeout: 10_000 });

  const placed = await page.evaluate(k => {
    const head = document.querySelector(`#groups .group[data-g="${k}"] .grouphead`).getBoundingClientRect();
    const bar = document.querySelector("#cascbar").getBoundingClientRect();
    return { headTop: head.top, barBottom: bar.bottom, vh: window.innerHeight };
  }, target);

  expect(placed.headTop, "the heading is hidden behind the sticky band").toBeGreaterThanOrEqual(placed.barBottom - 1);
  expect(placed.headTop, "the heading is off the bottom of the screen").toBeLessThan(placed.vh);
});

test("CAS-275: the chip counts agree with the section headings", async ({ page }) => {
  await toAgentListing(page);
  const sections = await sectionCounts(page);
  test.skip(sections.length < 2, "this agent's listing has only one section today");

  const chipCounts = await page.locator("#jumpBar .jchip").evaluateAll(bs =>
    bs.map(b => ({ window: b.dataset.jump, count: Number(b.querySelector(".jn").textContent.trim()) })));
  expect(chipCounts).toEqual(sections);
});

test("CAS-275: with nothing to jump between, the rail stays away", async ({ page }) => {
  await toAgentListing(page);
  // Force the single-section case rather than hoping the catalogue supplies one.
  const hidden = await page.evaluate(() => {
    document.querySelectorAll("#groups .group").forEach((g, i) => { if(i > 0) g.remove(); });
    renderJumpBar();
    return document.querySelector("#jumpBar").hidden;
  });
  expect(hidden, "a jump control with one destination scrolls you nowhere").toBe(true);
});
