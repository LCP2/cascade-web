// CAS-284: a real share on the film card.
import { test, expect } from "@playwright/test";
import { toShortlist, shortlistCards, pickCard, finishFlow, toListing } from "./helpers.mjs";

async function toOpenCard(page){
  await toShortlist(page, "cinema");
  const cards = await shortlistCards(page);
  await pickCard(page, cards[0].name);
  await finishFlow(page);
  await toListing(page);
  const card = page.locator("#groups .card").first();
  await card.scrollIntoViewIfNeeded();
  await card.locator(".title").click();
  await expect(card).toHaveClass(/expanded/);
  return card;
}

test("CAS-284: the share control is on the card, in expanded mode", async ({ page }) => {
  const card = await toOpenCard(page);
  const btn = card.locator(".exsharebtn");
  await expect(btn).toBeVisible();
  const box = await btn.boundingBox();
  expect(box.height, "a share you cannot hit is not an option").toBeGreaterThanOrEqual(32);
});

test("CAS-284: it is not in the way on a collapsed card", async ({ page }) => {
  await toShortlist(page, "cinema");
  const cards = await shortlistCards(page);
  await pickCard(page, cards[0].name);
  await finishFlow(page);
  await toListing(page);
  const card = page.locator("#groups .card").first();
  await expect(card).not.toHaveClass(/expanded/);
  // The whole expand region is clipped to zero height and faded out when the card is closed — the share
  // rides in there with the credits and trailers, so it is hidden exactly as much as they are. (Asserting
  // toBeHidden on the button itself is wrong: it keeps its own 36px box while the PARENT clips it.)
  const state = await card.locator(".expand").evaluate(el => {
    const cs = getComputedStyle(el);
    return { h: el.getBoundingClientRect().height, opacity: cs.opacity, overflow: cs.overflow };
  });
  expect(state.h, "the expand region is not collapsed").toBe(0);
  expect(state.opacity).toBe("0");
  expect(state.overflow).toBe("hidden");
});

test("CAS-284: it uses the platform share sheet when there is one", async ({ page }) => {
  const card = await toOpenCard(page);
  const id = Number((await card.getAttribute("id")).replace("card-", ""));
  await page.evaluate(() => {
    window.__shared = null;
    navigator.share = data => { window.__shared = data; return Promise.resolve(); };
  });
  await card.locator(".exsharebtn").click();
  const shared = await page.evaluate(() => window.__shared);
  expect(shared, "the share sheet was never called").not.toBeNull();

  const expected = await page.evaluate(i => {
    const m = MOVIES.find(x => x.tmdb_id === i);
    return { title: m.title, text: shareTextFor(m), url: shareUrlFor(m) };
  }, id);
  expect(shared.title).toBe(expected.title);
  expect(shared.text).toBe(expected.text);
  expect(shared.url).toBe(expected.url);
  expect(shared.url, "the link must be a real public page for the film").toMatch(/^https:\/\//);
});

test("CAS-284: a cancelled share sheet does not fall through to copying", async ({ page }) => {
  const card = await toOpenCard(page);
  await page.evaluate(() => {
    window.__copied = null;
    navigator.share = () => Promise.reject(Object.assign(new Error("cancelled"), { name: "AbortError" }));
    navigator.clipboard.writeText = t => { window.__copied = t; return Promise.resolve(); };
  });
  await card.locator(".exsharebtn").click();
  await page.waitForTimeout(400);
  expect(await page.evaluate(() => window.__copied),
    "backing out of the share sheet copied it anyway").toBeNull();
});

test("CAS-284: with no share sheet it copies, and says so on the button", async ({ page }) => {
  const card = await toOpenCard(page);
  await page.evaluate(() => {
    window.__copied = null;
    delete navigator.share;
    navigator.clipboard.writeText = t => { window.__copied = t; return Promise.resolve(); };
  });
  await card.locator(".exsharebtn").click();
  await expect(card.locator(".exsharebtn .sl")).toHaveText("Copied");
  const copied = await page.evaluate(() => window.__copied);
  expect(copied).toContain("https://");
  // …and the label goes back, so the card does not sit there claiming a copy forever.
  await expect(card.locator(".exsharebtn .sl")).toHaveText("Share", { timeout: 5000 });
});

test("CAS-284: it never shares a window Cascade has not confirmed", async ({ page }) => {
  await toShortlist(page, "cinema");
  const bad = await page.evaluate(() => {
    const out = [];
    for(const m of MOVIES){
      if(!isEstimated(m)) continue;
      const t = shareTextFor(m);
      // An estimated film has no read listing, so its share text must not name a window at all.
      for(const label of Object.values(STATUS_LABEL)) if(t.includes(label)) out.push(m.title + " -> " + t);
    }
    return out.slice(0, 5);
  });
  expect(bad, `estimated films passing a guess off as a fact: ${JSON.stringify(bad)}`).toEqual([]);
});

test("CAS-284: opening the share does not collapse the card", async ({ page }) => {
  const card = await toOpenCard(page);
  await page.evaluate(() => { navigator.share = () => Promise.resolve(); });
  await card.locator(".exsharebtn").click();
  await expect(card).toHaveClass(/expanded/);
});
