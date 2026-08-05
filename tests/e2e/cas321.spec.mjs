// CAS-321: the "JUMP TO" / "ORDER" text labels are dropped, and the "We're only showing films on your
// services" banner is gone.
// CAS-371 later took the Order control out of this row entirely — it rides in the open agent's own card
// now (see cas371.spec.mjs) — so the "chips and sort share one row" premise this file used to open with is
// gone; #listCtl is the jump rail alone.
import { test, expect } from "@playwright/test";
import { toShortlist, shortlistCards, pickCard, finishFlow, toListing, sectionCounts } from "./helpers.mjs";

async function toAgentListing(page, kind = "stream"){
  await toShortlist(page, kind);
  const cards = await shortlistCards(page);
  await pickCard(page, cards[0].name);
  await finishFlow(page);
  await toListing(page);
}

test("CAS-321: the jump-to row no longer carries the sort control", async ({ page }) => {
  await toAgentListing(page);
  await expect(page.locator("#listCtl")).toBeVisible();
  expect(await page.evaluate(() => !!document.querySelector("#listCtl #jumpBar"))).toBe(true);
  // CAS-371: sort left this row for the open agent card's action row.
  expect(await page.evaluate(() => !!document.querySelector("#listCtl #sortCtl"))).toBe(false);
});

test("CAS-321: the old \"JUMP TO\" / \"ORDER\" text labels are gone", async ({ page }) => {
  await toAgentListing(page);
  await expect(page.locator(".jlbl")).toHaveCount(0);
  await expect(page.locator(".sortlbl")).toHaveCount(0);
  await expect(page.locator("#listCtl", { hasText: "Jump to" })).toHaveCount(0);
  await expect(page.locator("#listCtl", { hasText: "Order" })).toHaveCount(0);
});

test("CAS-321: the \"only showing films on your streaming services\" banner is gone for good", async ({ page }) => {
  await toAgentListing(page);
  await page.evaluate(() => {
    prefs.sub.clear(); prefs.sub.add(SUB_SERVICES[0]); prefs.on = true; savePrefs();
    const c = activeCascade();
    c.myServices = { pvod: true, rental: true, included_streaming: true };
    saveCascades(); render();
  });
  await expect(page.locator('[data-svcnote="scoped"]')).toHaveCount(0);
  await expect(page.locator("body", { hasText: /only showing films on your streaming services/i })).toHaveCount(0);
});

test("CAS-321: chips read Buy / Rent / Stream, left to right, with a dot and a count", async ({ page }) => {
  await toAgentListing(page);
  const sections = await sectionCounts(page);
  const wanted = ["pvod", "rental", "included_streaming"].filter(k => sections.some(s => s.window === k));
  test.skip(wanted.length < 2, "today's agent doesn't carry at least two of Buy/Rent/Stream");

  const chips = await page.locator("#jumpBar .jchip").evaluateAll(bs => bs.map(b => ({
    key: b.dataset.jump,
    label: (b.textContent || "").trim(),
    dot: !!b.querySelector(".gdot"),
    n: (b.querySelector(".jn")?.textContent || "").trim(),
  })));
  const relevant = chips.filter(c => wanted.includes(c.key));
  expect(relevant.map(c => c.key), "Buy, then Rent, then Stream").toEqual(wanted);
  relevant.forEach(c => {
    expect(c.dot, `${c.key} chip carries its status dot`).toBe(true);
    expect(c.n.length, `${c.key} chip carries a count`).toBeGreaterThan(0);
  });
  const buy = chips.find(c => c.key === "pvod");
  if(buy) expect(buy.label).toContain("Buy");
});

test("CAS-321: the jump rail is icon-only chips on phone and never wraps", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });   // the width the ticket calls out
  await toAgentListing(page);

  const narrow = await page.evaluate(() => {
    const cur = document.querySelector("#sortCur");
    return { curShown: getComputedStyle(cur).display !== "none" };
  });
  expect(narrow.curShown, "no visible current-sort label at 375px").toBe(false);

  const geo = await page.evaluate(() => {
    const jump = document.querySelector("#jumpBar").getBoundingClientRect();
    return { jumpBottom: jump.bottom, jumpTop: jump.top };
  });
  // A single line: the row is not tall enough to hold a second stacked row of chips.
  expect(geo.jumpBottom - geo.jumpTop, "the jump rail must not wrap to a second line").toBeLessThan(40);
});

test("CAS-321: from 560px the sort pill expands to show the current sort and a chevron", async ({ page }) => {
  await page.setViewportSize({ width: 700, height: 900 });
  await toAgentListing(page);
  const wide = await page.evaluate(() => {
    const cur = document.querySelector("#sortCur"), chev = document.querySelector(".sortchev");
    return { curShown: getComputedStyle(cur).display !== "none", curText: cur.textContent.trim(),
             chevShown: getComputedStyle(chev).display !== "none" };
  });
  expect(wide.curShown).toBe(true);
  expect(wide.chevShown).toBe(true);
  expect(wide.curText.length).toBeGreaterThan(0);
});

test("CAS-321: picking a non-default sort updates the pill's label and lights its active-dot", async ({ page }) => {
  await page.setViewportSize({ width: 700, height: 900 });
  await toAgentListing(page);
  // Agents can be saved on any sort (a Blockbuster-style preset leads with "popularity"), so pin to the
  // known default explicitly rather than assuming this agent already sits on it.
  await page.locator("#sort").selectOption("availability");
  await expect(page.locator("#sortCur")).toHaveText(/Availability/i);
  await expect(page.locator("#sortDot")).toBeHidden();

  await page.locator("#sort").selectOption("imdb");
  await expect(page.locator("#sortCur")).toHaveText(/IMDb rating/i);
  await expect(page.locator("#sortDot")).toBeVisible();
});

test("CAS-321: chips and the sort pill share the same height", async ({ page }) => {
  await toAgentListing(page);
  const sections = await sectionCounts(page);
  test.skip(sections.length < 1, "no sections to compare against");
  const geo = await page.evaluate(() => {
    const chip = document.querySelector("#jumpBar .jchip");
    const sort = document.querySelector("#sortCtl");
    return { chipH: chip ? chip.getBoundingClientRect().height : null, sortH: sort.getBoundingClientRect().height };
  });
  test.skip(geo.chipH == null, "this agent's listing has no jump chips today");
  expect(Math.abs(geo.chipH - geo.sortH)).toBeLessThanOrEqual(1);
});
