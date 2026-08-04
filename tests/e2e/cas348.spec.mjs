// CAS-348: card control-row layout redesign — exactly three equal-width controls (notify, agent, watch
// status), no standalone chevron and no service-list button in the row, and a per-film "Services" shortcut
// on the green Included-on bar itself.
import { test, expect } from "@playwright/test";
import { toShortlist, shortlistCards, pickCard, finishFlow, toListing, settleListing } from "./helpers.mjs";

const FAKE_STREAM_ID = 900348001;
const FAKE_RENT_ID = 900348002;

/** Past onboarding onto the plain "All" catalogue view (CAS-170's unscoped listing) — no active agent, which
 * is exactly the mixed view the per-film Services affordance has to be correct on. */
async function toAllCatalogue(page){
  await toShortlist(page, "stream");
  const cards = await shortlistCards(page);
  await pickCard(page, cards[0].name);
  await finishFlow(page);
  await toListing(page);
  await page.evaluate(() => {
    setActive(ALL_ID); settleFoundView(); clearFilters(); syncFilterUI(); render();
  });
  await settleListing(page);
}

async function seedFilms(page){
  await page.evaluate(({ streamId, rentId }) => {
    MOVIES.push({
      tmdb_id: streamId, title: "Green Bar Test Film", status: ["included_streaming"],
      offers: [{ type: "sub", service: "Netflix", price: null }],
    });
    MOVIES.push({
      tmdb_id: rentId, title: "Rent Only Test Film", status: ["rental"],
      offers: [{ type: "rent", service: "Apple TV Store", price: 5.99 }],
    });
    render();
  }, { streamId: FAKE_STREAM_ID, rentId: FAKE_RENT_ID });
}

test.afterEach(async ({ page }) => {
  await page.evaluate(ids => {
    ids.forEach(id => {
      const i = MOVIES.findIndex(m => m.tmdb_id === id);
      if(i >= 0) MOVIES.splice(i, 1);
    });
  }, [FAKE_STREAM_ID, FAKE_RENT_ID]);
});

test("CAS-348: exactly three equal-width controls, ordered notify / agent / watch, no chevron or service-list button", async ({ page }) => {
  await toShortlist(page, "cinema");
  const cards = await shortlistCards(page);
  await pickCard(page, cards[0].name);
  await finishFlow(page);
  await toListing(page);
  const card = page.locator("#groups .card").first();
  await expect(card).toBeVisible();

  const controls = card.locator(".actions > *");
  await expect(controls).toHaveCount(3);
  const classes = await controls.evaluateAll(els => els.map(el => el.className));
  expect(classes[0]).toMatch(/\bctl\b.*\bnotify\b|\bnotify\b.*\bctl\b/);
  expect(classes[1]).toMatch(/\bctl\b.*\bcasc\b|\bcasc\b.*\bctl\b/);
  expect(classes[2]).toMatch(/\bctl\b.*\bwatch\b|\bwatch\b.*\bctl\b/);
  await expect(card.locator(".actions .wtwbtn")).toHaveCount(0);

  // equal width, sharing one row
  const boxes = await controls.evaluateAll(els => els.map(el => el.getBoundingClientRect()));
  const tops = boxes.map(b => Math.round(b.top));
  expect(new Set(tops).size, "the three controls do not share a row").toBe(1);
  const widths = boxes.map(b => Math.round(b.width));
  expect(Math.abs(widths[0] - widths[1])).toBeLessThanOrEqual(1);
  expect(Math.abs(widths[1] - widths[2])).toBeLessThanOrEqual(1);
});

test("CAS-348: the control row hugs the availability block, not the card bottom", async ({ page }) => {
  await toShortlist(page, "cinema");
  const cards = await shortlistCards(page);
  await pickCard(page, cards[0].name);
  await finishFlow(page);
  await toListing(page);
  const card = page.locator("#groups .card").first();
  await expect(card).toBeVisible();

  // A collapsed card's services list takes no visual space, so nothing sits between whichever availability
  // line the card is showing and the control row directly beneath it.
  const wtwDisplay = await card.evaluate(el => {
    const wtw = el.querySelector(".wtw");
    return wtw ? getComputedStyle(wtw).display : "none";
  });
  expect(wtwDisplay).toBe("none");
});

test("CAS-348: a card with the green Included-on bar exposes a Services shortcut that expands the list", async ({ page }) => {
  await toAllCatalogue(page);
  await seedFilms(page);
  await settleListing(page);

  const card = page.locator(`#card-${FAKE_STREAM_ID}`);
  await expect(card).toBeVisible();
  const bar = card.locator(".saveline");
  await expect(bar).toBeVisible();
  await expect(bar).not.toHaveClass(/plain/);

  const svc = bar.locator(".svcbtn");
  await expect(svc).toHaveCount(1);
  const wtw = card.locator(".wtw");
  await expect(wtw).not.toHaveClass(/open/);
  await svc.click();
  await expect(wtw).toHaveClass(/open/);
  await expect(svc).toHaveClass(/open/);
  await svc.click();
  await expect(wtw).not.toHaveClass(/open/);
});

test("CAS-348: a rent-only card (no green bar) shows no Services affordance", async ({ page }) => {
  await toAllCatalogue(page);
  await seedFilms(page);
  await settleListing(page);

  const card = page.locator(`#card-${FAKE_RENT_ID}`);
  await expect(card).toBeVisible();
  const bar = card.locator(".saveline");
  await expect(bar).toHaveClass(/plain/);
  await expect(bar.locator(".svcbtn")).toHaveCount(0);
});
