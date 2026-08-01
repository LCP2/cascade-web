// CAS-286: one Upcoming colour token, applied everywhere the status appears.
import { test, expect } from "@playwright/test";
import { freshApp, toShortlist, shortlistCards, pickCard, finishFlow, toListing } from "./helpers.mjs";

const rgb = s => (s.match(/\d+/g) || []).map(Number);
/** Violet — more blue than red, and clearly not the grey it used to be. */
function expectViolet(colour, where){
  const [r, g, b] = rgb(colour);
  expect(b, `${where}: expected violet, got ${colour}`).toBeGreaterThan(r);
  expect(r, `${where}: expected violet, got ${colour}`).toBeGreaterThan(g);
  const grey = Math.abs(r - g) < 20 && Math.abs(g - b) < 20;
  expect(grey, `${where} is still grey (${colour})`).toBe(false);
}

test("CAS-286: the token exists and is the value the ticket names", async ({ page }) => {
  await freshApp(page);
  const v = await page.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue("--upcoming").trim());
  expect(v.toUpperCase()).toBe("#7C5CFF");
});

test("CAS-286: the splash pill uses it", async ({ page }) => {
  await freshApp(page);
  const dot = page.locator(".splashpill", { hasText: "Upcoming" }).locator(".splashdot");
  await expect(dot).toHaveCount(1);
  expectViolet(await dot.evaluate(el => getComputedStyle(el).backgroundColor), "splash dot");
});

test("CAS-286: the listing's Upcoming section dot uses it", async ({ page }) => {
  await freshApp(page);
  const colour = await page.evaluate(() => {
    const d = document.createElement("div");
    d.className = "gdot upcoming";
    document.body.appendChild(d);
    const c = getComputedStyle(d).backgroundColor;
    d.remove();
    return c;
  });
  expectViolet(colour, "section dot");
});

test("CAS-286: the availability strip's Upcoming lozenge uses it", async ({ page }) => {
  await freshApp(page);
  const colours = await page.evaluate(() => {
    const wrap = document.createElement("div");
    wrap.innerHTML = `<div class="win w-cin-upcoming on"><div class="wpill">Upcoming</div></div>`;
    document.body.appendChild(wrap);
    const p = wrap.querySelector(".wpill");
    const cs = getComputedStyle(p);
    const out = { border: cs.borderColor, bg: cs.backgroundColor, fg: cs.color };
    wrap.remove();
    return out;
  });
  expectViolet(colours.border, "strip border");
  expectViolet(colours.bg, "strip background");
});

test("CAS-286: the status pill and the filter chip use it", async ({ page }) => {
  await freshApp(page);
  const out = await page.evaluate(() => {
    const wrap = document.createElement("div");
    wrap.innerHTML = `<span class="pill upcoming">Upcoming</span><span class="chip on st-upcoming">Upcoming</span>`;
    document.body.appendChild(wrap);
    const r = {
      pill: getComputedStyle(wrap.querySelector(".pill")).borderColor,
      chip: getComputedStyle(wrap.querySelector(".chip")).borderColor,
    };
    wrap.remove();
    return r;
  });
  expectViolet(out.pill, "status pill");
  expectViolet(out.chip, "filter chip");
});

test("CAS-286: the Your Movies row lozenge uses it — and every window's lozenge is a real colour now", async ({ page }) => {
  await freshApp(page);
  const map = await page.evaluate(() => WIN_COLOUR);
  expect(map.upcoming.toUpperCase()).toBe("#7C5CFF");
  // The lozenge builds its background by appending an alpha suffix to this value. A var() reference makes
  // that invalid CSS and paints nothing, which is what it used to do for every one of the six.
  for(const [k, v] of Object.entries(map)){
    expect(v, `${k} must be a hex the alpha suffix can extend`).toMatch(/^#[0-9a-fA-F]{6}$/);
  }
  const painted = await page.evaluate(() => {
    const wrap = document.createElement("div");
    wrap.innerHTML = `<span class="mlwin" style="background:${WIN_COLOUR.upcoming}22;border:1px solid ${WIN_COLOUR.upcoming}88;color:${WIN_COLOUR.upcoming}">Upcoming</span>`;
    document.body.appendChild(wrap);
    const cs = getComputedStyle(wrap.querySelector(".mlwin"));
    const out = { bg: cs.backgroundColor, border: cs.borderColor };
    wrap.remove();
    return out;
  });
  expect(painted.bg, "the lozenge background is still transparent").not.toBe("rgba(0, 0, 0, 0)");
  expectViolet(painted.border, "Your Movies lozenge");
});

test("CAS-286: an upcoming film in a real listing is not painted grey", async ({ page }) => {
  await toShortlist(page, "cinema");
  const cards = await shortlistCards(page);
  await pickCard(page, cards[0].name);
  await finishFlow(page);
  await toListing(page);
  const has = await page.locator('#groups .group[data-g="upcoming"]').count();
  test.skip(has === 0, "this agent lists no upcoming films today");
  const colour = await page.locator('#groups .group[data-g="upcoming"] .gdot')
    .first().evaluate(el => getComputedStyle(el).backgroundColor);
  expectViolet(colour, "listing section dot");
});
