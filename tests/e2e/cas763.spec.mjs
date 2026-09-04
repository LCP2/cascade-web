// CAS-763: Lee's reaction to CAS-760 shipping as a hard tinted rectangle sitting ON TOP of an agent's list
// — the rank tint now paints a continuous LANE behind the whole block instead. The render loop wraps each
// agent's .grouphead.sub (CAS-717) and its .list in one .ablock, and moves the CAS-760 rank class onto that
// wrapper: the wrapper carries the wash + full-height left strip, the heading loses its own border/background
// and simply sits, matching-colour and opaque, at the top of the lane. CAS-761's sticky pin/release still
// holds — its own spec's comment explains why the mechanism it now rests on changed.
//
// Real onboarding roster + explicit .order ranking (cas760's rankCascades technique), films pinned in
// (CAS-709 — cas753/754/760/761's technique) so there is no dependency on catalogue-derived taste matching.
// The "Other" (unowned) block is produced the same way cas760 does it: a paused clone of cascade[0] whose
// pin still lists it (listedBy() never checks .paused) but recomputeFound excludes from ownership.
import { test, expect } from "@playwright/test";
import { toShortlist, finishFlow, toListing, settleListing } from "./helpers.mjs";

const ALL_FILMS = [];
const PAUSED_CLONE_ID = "cas763-paused-clone";

async function toWatchScreen(page){
  await toShortlist(page, "stream");
  await finishFlow(page);
  await toListing(page);
  return page.evaluate(() => cascades.map(c => c.id));
}

/** Rank cascadeIds[0..2] 1/2/3 (order 10/20/30) and make them status-permissive — cas760's technique. */
async function rankCascades(page, cascadeIds){
  await page.evaluate((cascadeIds) => {
    const ord = [10, 20, 30];
    cascadeIds.slice(0, 3).forEach((id, i) => {
      const c = cascades.find(x => x.id === id);
      c.order = ord[i]; c.status = []; c.listStatus = [];
    });
  }, cascadeIds);
}

async function addPausedClone(page, cascadeIds){
  await page.evaluate(({ cascadeIds, PAUSED_CLONE_ID }) => {
    const clone = JSON.parse(JSON.stringify(cascades.find(c => c.id === cascadeIds[0])));
    clone.id = PAUSED_CLONE_ID; clone.paused = true; clone.order = 999;
    cascades.push(clone);
  }, { cascadeIds, PAUSED_CLONE_ID });
}

async function seedFilm(page, { id, title, status, cascadeId }){
  ALL_FILMS.push(id);
  await page.evaluate(({ id, title, status, cascadeId }) => {
    MOVIES.push({ tmdb_id: id, title, status: [status], offers: [] });
    const e = entryFor(id);
    if(cascadeId) e.pinnedTo = [cascadeId];
    e.wins = { stream: true };
    e.winsSource = { stream: "manual" };
  }, { id, title, status, cascadeId });
}

async function toStreamTab(page){
  await page.evaluate(() => setWatchTab("stream"));
  await settleListing(page);
}

test.afterEach(async ({ page }) => {
  await page.evaluate(({ ids, PAUSED_CLONE_ID }) => {
    ids.forEach(id => {
      const i = MOVIES.findIndex(m => m.tmdb_id === id);
      if(i >= 0) MOVIES.splice(i, 1);
      delete notify[id];
    });
    const ci = cascades.findIndex(c => c.id === PAUSED_CLONE_ID);
    if(ci >= 0) cascades.splice(ci, 1);
  }, { ids: ALL_FILMS.splice(0), PAUSED_CLONE_ID });
});

test("CAS-763 AC1/AC2/AC3: the tinted .ablock spans heading-to-last-card carrying the strip+wash; the heading has no border of its own and an identical, opaque background", async ({ page }) => {
  const cascadeIds = await toWatchScreen(page);
  expect(cascadeIds.length).toBeGreaterThanOrEqual(1);
  await rankCascades(page, cascadeIds);
  for(let i = 0; i < 4; i++)
    await seedFilm(page, { id: 900763100 + i, title: `CAS-763 A${i}`, status: "upcoming", cascadeId: cascadeIds[0] });
  await page.evaluate(() => render());
  await toStreamTab(page);

  const result = await page.evaluate(() => {
    const ablock = document.querySelector(".ablock.agrank-1");
    const sub = ablock.querySelector(".grouphead.sub");
    const cards = [...ablock.querySelectorAll(".list .card")];
    const last = cards[cards.length - 1];
    const ar = ablock.getBoundingClientRect(), sr = sub.getBoundingClientRect(), lr = last.getBoundingClientRect();
    const acs = getComputedStyle(ablock), scs = getComputedStyle(sub);
    const bgHex = getComputedStyle(document.documentElement).getPropertyValue("--bg").trim();
    return {
      cardCount: cards.length,
      topDelta: ar.top - sr.top,
      bottomDelta: ar.bottom - lr.bottom,
      ablockBorderLeft: acs.borderLeftWidth,
      ablockBg: acs.backgroundColor,
      subBorderLeft: scs.borderLeftWidth,
      subBg: scs.backgroundColor,
      bgHex,
    };
  });
  expect(result.cardCount).toBe(4);
  // AC1: the wrapper spans from the heading's own top to the last card's own bottom (not its trailing
  // margin), and carries the strip's left border plus the wash background — painted at BLOCK height.
  expect(Math.abs(result.topDelta)).toBeLessThanOrEqual(1);
  expect(Math.abs(result.bottomDelta)).toBeLessThanOrEqual(1);
  expect(result.ablockBorderLeft).toBe("3px");
  expect(result.ablockBg).not.toBe("rgba(0, 0, 0, 0)");
  const bgAsRgb = await page.evaluate((hex) => {
    const m = hex.replace("#", "").match(/.{2}/g).map(x => parseInt(x, 16));
    return `rgb(${m[0]}, ${m[1]}, ${m[2]})`;
  }, result.bgHex);
  expect(result.ablockBg).not.toBe(bgAsRgb);   // genuinely tinted, not plain --bg
  // AC2: the heading carries no left border of its own, and its background equals the wrapper's exactly.
  expect(result.subBorderLeft).toBe("0px");
  expect(result.subBg).toBe(result.ablockBg);
  // AC3: that shared background is fully opaque — a card scrolling under it while pinned stays hidden.
  const alphaOf = c => { const m = c.match(/rgba?\(([^)]+)\)/)[1].split(",").map(s => s.trim()); return m.length === 4 ? Number(m[3]) : 1; };
  expect(alphaOf(result.subBg)).toBe(1);
});

test("CAS-763 AC4: CAS-761's pin/release still holds — a heading pins at --stickyh while its own block is on screen and releases once the next block's heading takes over", async ({ page }) => {
  const cascadeIds = await toWatchScreen(page);
  expect(cascadeIds.length).toBeGreaterThanOrEqual(2);
  await rankCascades(page, cascadeIds);
  for(let i = 0; i < 10; i++)
    await seedFilm(page, { id: 900763200 + i, title: `CAS-763 B1-${i}`, status: "upcoming", cascadeId: cascadeIds[0] });
  for(let i = 0; i < 10; i++)
    await seedFilm(page, { id: 900763300 + i, title: `CAS-763 B2-${i}`, status: "upcoming", cascadeId: cascadeIds[1] });
  await page.evaluate(() => render());
  await toStreamTab(page);

  const subsSel = '#groups .group[data-g="upcoming"] .grouphead.sub';
  const scrollPastStick = async (nth, offset) => {
    await page.evaluate(({ sel, nth, offset }) => {
      const el = document.querySelectorAll(sel)[nth];
      const stickyh = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--stickyh")) || 0;
      const absTop = window.scrollY + el.getBoundingClientRect().top;
      window.scrollTo(0, Math.max(0, absTop - stickyh + offset));
    }, { sel: subsSel, nth, offset });
    await page.waitForTimeout(300);
  };
  const tops = () => page.evaluate((sel) => [...document.querySelectorAll(sel)].map(el => el.getBoundingClientRect().top), subsSel);
  const stickyh = await page.evaluate(() => parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--stickyh")) || 0);

  // Deep into block 1 — its heading sits pinned at --stickyh.
  await scrollPastStick(0, 200);
  let t = await tops();
  expect(t.length).toBe(2);
  expect(Math.abs(t[0] - stickyh)).toBeLessThanOrEqual(2);

  // Just past where block 2 takes over — block 2 pins at --stickyh, block 1 has released (never both stuck).
  await scrollPastStick(1, 20);
  t = await tops();
  expect(Math.abs(t[1] - stickyh)).toBeLessThanOrEqual(2);
  expect(t[0]).toBeLessThan(stickyh - 20);
});

test("CAS-763 AC5: an untinted \"Other\" block gets no lane strip and no wash", async ({ page }) => {
  const cascadeIds = await toWatchScreen(page);
  await rankCascades(page, cascadeIds);
  await addPausedClone(page, cascadeIds);
  await seedFilm(page, { id: 900763401, title: "CAS-763 Owned", status: "upcoming", cascadeId: cascadeIds[0] });
  // Pinned only to the paused clone — listedBy() still lists it, recomputeFound excludes it from ownership
  // (CAS-682's real "Other" divergence, reused by cas760's own addPausedClone).
  await seedFilm(page, { id: 900763402, title: "CAS-763 Other", status: "upcoming", cascadeId: PAUSED_CLONE_ID });
  await page.evaluate(() => render());
  await toStreamTab(page);

  const other = await page.evaluate(() => {
    const sub = [...document.querySelectorAll(".grouphead.sub")].find(el => el.textContent.trim() === "Other");
    const ablock = sub.closest(".ablock");
    const cs = getComputedStyle(ablock);
    return {
      hasTint: [...ablock.classList].some(c => c.startsWith("agrank-")),
      borderLeft: cs.borderLeftWidth,
      bg: cs.backgroundColor,
    };
  });
  expect(other.hasTint).toBe(false);
  expect(other.borderLeft).toBe("0px");
  expect(other.bg).toBe("rgba(0, 0, 0, 0)");
});

test("CAS-763 AC6: the card border and card text keep their own computed colours over the wash — the tint never leaks onto a card", async ({ page }) => {
  const cascadeIds = await toWatchScreen(page);
  await rankCascades(page, cascadeIds);
  await addPausedClone(page, cascadeIds);
  await seedFilm(page, { id: 900763501, title: "CAS-763 Tinted card", status: "upcoming", cascadeId: cascadeIds[0] });
  await seedFilm(page, { id: 900763502, title: "CAS-763 Other card", status: "upcoming", cascadeId: PAUSED_CLONE_ID });
  await page.evaluate(() => render());
  await toStreamTab(page);

  const styles = await page.evaluate(() => {
    const read = (ablock) => {
      const card = ablock.querySelector(".card");
      const title = card.querySelector(".titletext");
      return { border: getComputedStyle(card).borderColor, text: getComputedStyle(title).color };
    };
    const tinted = read(document.querySelector(".ablock.agrank-1"));
    const otherSub = [...document.querySelectorAll(".grouphead.sub")].find(el => el.textContent.trim() === "Other");
    const other = read(otherSub.closest(".ablock"));
    return { tinted, other };
  });
  expect(styles.tinted.border).toBe(styles.other.border);
  expect(styles.tinted.text).toBe(styles.other.text);
});
