// CAS-761: the Watch listing's per-agent sub-heading (.grouphead.sub, CAS-717) pins under the sticky chrome
// for as long as its own agent block is on screen, and releases (never overlapping the next block's own
// heading in a stuck state) once that block scrolls past.
// CAS-763: the mechanism this rests on changed. .grouphead.sub and .list used to be flat siblings inside
// one .group, so the release came from the classic "consecutive position:sticky siblings push each other
// out" arrangement. CAS-763 wraps each heading + its .list in one .ablock (so a rank tint can paint a
// continuous lane behind the whole block) — the headings are no longer siblings, but the same release still
// happens: a sticky element can never stick past the end of its own containing block, so each heading pins
// within its .ablock and lets go exactly at that block's bottom. Same visible behaviour, cleaner
// containment, no JS involved either way. The offset it pins to, --stickyh (header + #cascbar's measured
// height), is published by syncHeaderHeight() the same place --hdrh already is, and jumpToSection now reads
// that same value instead of re-measuring the chrome itself.
//
// Real onboarding roster (toShortlist/finishFlow, same technique cas751-754/760 use), films pinned in
// (CAS-709: a pin always outranks criteria — cas753/754/760's technique) so there is no dependency on
// catalogue-derived taste matching. Two of the roster's cascades are given explicit, well-separated .order
// values (cas760's rankCascades technique) so which agent's block comes first is deterministic. Absolute
// scroll targets are computed from LIVE measurements taken immediately before each scroll (never a fixed
// pixel guess), the same "measured, not guessed" discipline jumpToSection's own re-aim logic already follows
// — content-visibility:auto cards can still grow once they first enter the viewport.
import { test, expect } from "@playwright/test";
import { toShortlist, finishFlow, toListing, settleListing } from "./helpers.mjs";

const N_BLOCK1 = 10, N_BLOCK2 = 10, N_NEXTGROUP = 2;
const ALL_FILMS = [];

async function toWatchScreen(page){
  await toShortlist(page, "stream");
  await finishFlow(page);
  await toListing(page);
  return page.evaluate(() => cascades.slice(0, 2).map(c => c.id));
}

/** Rank the two cascades used here 1/2 (order 10/20) so block order is deterministic — same technique
 * cas760.spec.mjs's rankCascades uses. */
async function rankCascades(page, cascadeIds){
  await page.evaluate((cascadeIds) => {
    cascades.find(c => c.id === cascadeIds[0]).order = 10;
    cascades.find(c => c.id === cascadeIds[1]).order = 20;
  }, cascadeIds);
}

async function seedFilm(page, { id, title, status, cascadeId }){
  ALL_FILMS.push(id);
  await page.evaluate(({ id, title, status, cascadeId }) => {
    MOVIES.push({ tmdb_id: id, title, status: [status], offers: [] });
    const e = entryFor(id);
    e.pinnedTo = [cascadeId];
    e.wins = { stream: true };
    e.winsSource = { stream: "manual" };
  }, { id, title, status, cascadeId });
}

async function toStreamTab(page){
  await page.evaluate(() => setWatchTab("stream"));
  await settleListing(page);
}

/** Scroll so `el`'s natural ("static") position sits `offset` px past where it would first become stuck at
 * --stickyh — computed from THIS MOMENT's live layout, not a value captured earlier. */
async function scrollPastStick(page, sel, nth, offset){
  await page.evaluate(({ sel, nth, offset }) => {
    const el = document.querySelectorAll(sel)[nth];
    const stickyh = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--stickyh")) || 0;
    const absTop = window.scrollY + el.getBoundingClientRect().top;
    window.scrollTo(0, Math.max(0, absTop - stickyh + offset));
  }, { sel, nth, offset });
  await page.waitForTimeout(300);   // let content-visibility:auto reveal + sticky settle before reading rects
}

const stickyState = sel => page => page.evaluate((sel) => {
  const stickyh = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--stickyh")) || 0;
  const subs = [...document.querySelectorAll(sel)];
  return { stickyh, tops: subs.map(el => el.getBoundingClientRect().top) };
}, sel);

test.afterEach(async ({ page }) => {
  await page.evaluate(ids => { ids.forEach(id => {
    const i = MOVIES.findIndex(m => m.tmdb_id === id);
    if(i >= 0) MOVIES.splice(i, 1);
    delete notify[id];
  }); }, ALL_FILMS.splice(0));
});

test("CAS-761 AC1/AC2/AC3/AC4: sub-heading pins at --stickyh, the next agent's heading displaces it with no stuck overlap, and it releases (never pinning over the next section) at its own group's end — opaque throughout", async ({ page }) => {
  const cascadeIds = await toWatchScreen(page);
  expect(cascadeIds.length).toBe(2);
  await rankCascades(page, cascadeIds);
  for(let i = 0; i < N_BLOCK1; i++)
    await seedFilm(page, { id: 900761100 + i, title: `CAS-761 B1-${i}`, status: "upcoming", cascadeId: cascadeIds[0] });
  for(let i = 0; i < N_BLOCK2; i++)
    await seedFilm(page, { id: 900761200 + i, title: `CAS-761 B2-${i}`, status: "upcoming", cascadeId: cascadeIds[1] });
  for(let i = 0; i < N_NEXTGROUP; i++)
    await seedFilm(page, { id: 900761300 + i, title: `CAS-761 Next-${i}`, status: "opening_week", cascadeId: cascadeIds[0] });
  await page.evaluate(() => render());
  await toStreamTab(page);

  const subsSel = '#groups .group[data-g="upcoming"] .grouphead.sub';
  const state = stickyState(subsSel);

  // AC1: scroll well into block 1 (its own .list still has many cards below the fold) — its sub-heading
  // sits at --stickyh.
  await scrollPastStick(page, subsSel, 0, 200);
  let s = await state(page);
  expect(s.tops.length).toBe(2);   // exactly the two agent blocks in this group
  expect(Math.abs(s.tops[0] - s.stickyh)).toBeLessThanOrEqual(2);

  // AC4: nothing paints over it (topmost element at its own midpoint is itself), and its background is
  // fully opaque — a card scrolling underneath is never visible through it.
  const topmostIsSub = await page.evaluate((sel) => {
    const sub = document.querySelectorAll(sel)[0];
    const r = sub.getBoundingClientRect();
    const hit = document.elementFromPoint(Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2));
    return sub === hit || sub.contains(hit);
  }, subsSel);
  expect(topmostIsSub).toBe(true);
  const bgAlpha = await page.evaluate((sel) => {
    const c = getComputedStyle(document.querySelectorAll(sel)[0]).backgroundColor;
    const m = c.match(/rgba?\(([^)]+)\)/)[1].split(",").map(s => s.trim());
    return m.length === 4 ? Number(m[3]) : 1;
  }, subsSel);
  expect(bgAlpha).toBe(1);

  // AC2: scroll on to just past where block 2's heading takes over — block 1's heading has released
  // (moved clear off the pinned line) while block 2's sits at --stickyh; they are never both stuck at once.
  await scrollPastStick(page, subsSel, 1, 20);
  s = await state(page);
  expect(Math.abs(s.tops[1] - s.stickyh)).toBeLessThanOrEqual(2);
  expect(s.tops[0]).toBeLessThan(s.stickyh - 20);

  // AC3: scroll on to where the NEXT status section's own (non-sticky) heading arrives — block 2's
  // sub-heading has released too, rather than pinning on over "opening_week"'s .grouphead.
  await scrollPastStick(page, '#groups .group[data-g="opening_week"] .grouphead:not(.sub)', 0, 10);
  s = await state(page);
  expect(s.tops[1]).toBeLessThan(s.stickyh - 20);
});

test("CAS-761 AC5: --stickyh equals the measured header+cascbar chrome height, and jumpToSection still lands its target clear of it", async ({ page }) => {
  const cascadeIds = await toWatchScreen(page);
  await seedFilm(page, { id: 900761401, title: "CAS-761 target", status: "opening_week", cascadeId: cascadeIds[0] });
  await seedFilm(page, { id: 900761402, title: "CAS-761 other", status: "upcoming", cascadeId: cascadeIds[0] });
  await page.evaluate(() => render());
  await toStreamTab(page);

  const measured = await page.evaluate(() => {
    const stickyh = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--stickyh")) || 0;
    const hdr = document.querySelector("header").getBoundingClientRect().height;
    const bar = document.getElementById("cascbar").getBoundingClientRect().height;
    return { stickyh, chrome: hdr + bar };
  });
  expect(Math.abs(measured.stickyh - measured.chrome)).toBeLessThanOrEqual(1);

  await page.evaluate(() => window.jumpToSection("opening_week"));
  await page.waitForTimeout(1200);   // smooth scroll + the settle loop's re-aim corrections
  const landed = await page.evaluate(() => {
    const stickyh = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--stickyh")) || 0;
    const top = document.querySelector('#groups .group[data-g="opening_week"]').getBoundingClientRect().top;
    return top - stickyh;
  });
  // Clear of the chrome (not hidden under it) and not overshot far past it — jumpToSection's own "-8" aim.
  expect(landed).toBeGreaterThanOrEqual(-2);
  expect(landed).toBeLessThanOrEqual(20);
});
