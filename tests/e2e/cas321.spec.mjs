// CAS-321: the Jump-to + Order controls become one row (chips left, sort pinned right), the "JUMP TO" /
// "ORDER" text labels are dropped, and the "We're only showing films on your services" banner is gone.
import { test, expect } from "@playwright/test";
import { toShortlist, shortlistCards, pickCard, finishFlow, toListing, sectionCounts } from "./helpers.mjs";

async function toAgentListing(page, kind = "stream"){
  await toShortlist(page, kind);
  const cards = await shortlistCards(page);
  await pickCard(page, cards[0].name);
  await finishFlow(page);
  await toListing(page);
}

test("CAS-321: jump-to chips and the sort control share one row", async ({ page }) => {
  await toAgentListing(page);
  await expect(page.locator("#listCtl")).toBeVisible();
  // Both live inside the same row, not stacked as the old sortbar/jumpbar pair.
  expect(await page.evaluate(() => !!document.querySelector("#listCtl #jumpBar"))).toBe(true);
  expect(await page.evaluate(() => !!document.querySelector("#listCtl #sortCtl"))).toBe(true);

  const sections = await sectionCounts(page);
  test.skip(sections.length < 2, "this agent's listing has only one section today");
  const tops = await page.evaluate(() => ({
    jump: document.querySelector("#jumpBar").getBoundingClientRect().top,
    sort: document.querySelector("#sortCtl").getBoundingClientRect().top,
  }));
  expect(Math.abs(tops.jump - tops.sort), "chips and sort must sit on the same line").toBeLessThanOrEqual(2);
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

test("CAS-321: the sort control is icon-only on phone and stays pinned while chips scroll", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });   // the width the ticket calls out
  await toAgentListing(page);

  const narrow = await page.evaluate(() => {
    const cur = document.querySelector("#sortCur");
    return { curShown: getComputedStyle(cur).display !== "none" };
  });
  expect(narrow.curShown, "no visible current-sort label at 375px").toBe(false);

  const geo = await page.evaluate(() => {
    const row = document.querySelector("#listCtl").getBoundingClientRect();
    const jump = document.querySelector("#jumpBar").getBoundingClientRect();
    const sort = document.querySelector("#sortCtl").getBoundingClientRect();
    return { rowH: row.height, jumpBottom: jump.bottom, jumpTop: jump.top, sortRight: sort.right, rowRight: row.right };
  });
  // A single line: the row is not tall enough to hold a second stacked row of chips.
  expect(geo.jumpBottom - geo.jumpTop, "the jump rail must not wrap to a second line").toBeLessThan(40);
  // The sort pill sits pinned at the row's right edge.
  expect(Math.abs(geo.sortRight - geo.rowRight)).toBeLessThanOrEqual(2);
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
