// CAS-375: a film whose active status is Premium used to render no Services row at all — savingsHTML fell
// through to "" for buy-only (and premium-priced rent-only) offers, so there was no line and no Services
// button to open the provider list. It now gets the same one-line + Services affordance as the other statuses.
//
// The real catalogue currently carries no CONFIRMED (non-estimated) title with a buy-type offer (see
// tests/js/data-integrity.test.mjs's own note on this pattern for CAS-342) — every Premium title in it today
// is estimated, which savingsHTML skips entirely (CAS-110) and is not what this ticket is about. So this
// seeds one synthetic confirmed Premium film straight past deriveStatus, the same way cas342/cas348 do, and
// drives it through the actual shipped savingsHTML/cardHTML and DOM.
import { test, expect } from "@playwright/test";
import { toShortlist, shortlistCards, pickCard, finishFlow, toListing, settleListing } from "./helpers.mjs";

const FAKE_ID = 900375001;

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

async function seedFilm(page, { status, offers }){
  await page.evaluate(({ id, status, offers }) => {
    MOVIES.push({ tmdb_id: id, title: "Premium Test Film", status, offers });
    render();
  }, { id: FAKE_ID, status, offers });
}
const seedPremiumFilm = (page, offers) => seedFilm(page, { status: ["pvod"], offers });

test.afterEach(async ({ page }) => {
  await page.evaluate(id => {
    const i = MOVIES.findIndex(m => m.tmdb_id === id);
    if(i >= 0) MOVIES.splice(i, 1);
  }, FAKE_ID);
});

test("CAS-375: a buy-only Premium card shows the Services row with a working Services button", async ({ page }) => {
  await toAllCatalogue(page);
  await seedPremiumFilm(page, [{ type: "buy", service: "Apple TV", price: 24.99 }]);
  await settleListing(page);

  const card = page.locator(`#card-${FAKE_ID}`);
  await expect(card).toBeVisible();

  const saveline = card.locator(".saveline");
  await expect(saveline, "a Premium card must still show its where-to-get-it row").toHaveCount(1);
  await expect(saveline).toContainText(/Buy for \$24\.99/);

  const svcBtn = saveline.locator(".svcbtn");
  await expect(svcBtn, "a Premium card must offer the same Services affordance as other statuses").toBeVisible();

  const wtw = card.locator(".wtw");
  await expect(wtw).not.toHaveClass(/open/);
  await svcBtn.click();
  await expect(wtw, "tapping Services must open the provider list").toHaveClass(/open/);
  await expect(wtw.locator(".wtwrow")).toHaveCount(1);
  await expect(wtw).toContainText("Apple TV");
});

test("CAS-375: a premium-priced rent-only card (no standard rental, no subscription) also shows the row", async ({ page }) => {
  await toAllCatalogue(page);
  await seedPremiumFilm(page, [{ type: "rent", service: "Prime Video", price: 19.99 }]);
  await settleListing(page);

  const saveline = page.locator(`#card-${FAKE_ID} .saveline`);
  await expect(saveline).toHaveCount(1);
  await expect(saveline).toContainText(/Rent for \$19\.99/);
  await expect(saveline.locator(".svcbtn")).toBeVisible();
});

test("CAS-375: the Premium services line stays single-line, per CAS-373", async ({ page }) => {
  await toAllCatalogue(page);
  await seedPremiumFilm(page, [{ type: "buy", service: "Apple TV", price: 24.99 }]);
  await settleListing(page);

  const wrapped = await page.locator(`#card-${FAKE_ID} .saveline .savetxt`).evaluate(el => {
    const lh = parseFloat(getComputedStyle(el).lineHeight) || 16;
    return el.scrollHeight > lh * 1.4;
  });
  expect(wrapped, "the Premium services line wrapped onto a second line").toBe(false);
});

test("CAS-375: a genuine standard-priced Rent-status card is unaffected — no new Services button", async ({ page }) => {
  await toAllCatalogue(page);
  await seedFilm(page, { status: ["rental"], offers: [{ type: "rent", service: "Prime Video", price: 5.99 }] });
  await settleListing(page);

  const saveline = page.locator(`#card-${FAKE_ID} .saveline`);
  await expect(saveline).toHaveCount(1);
  await expect(saveline).toContainText(/Rent for \$5\.99/);
  await expect(saveline.locator(".svcbtn"), "the standard Rent row must keep its existing no-button behaviour").toHaveCount(0);
});
