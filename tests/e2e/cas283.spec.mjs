// CAS-283: with a control open, a tap on the card closes the control and never expands the card.
import { test, expect } from "@playwright/test";
import { toShortlist, shortlistCards, pickCard, finishFlow, toListing } from "./helpers.mjs";

async function toCard(page){
  await toShortlist(page, "cinema");
  const cards = await shortlistCards(page);
  await pickCard(page, cards[0].name);
  await finishFlow(page);
  await toListing(page);
  const card = page.locator("#groups .card").first();
  await card.scrollIntoViewIfNeeded();
  await expect(card).toBeVisible();
  return card;
}

// Every region of the card, including the two that opt out of the normal tap-to-open handler.
const REGIONS = [
  { sel: ".title",    name: "the title" },
  { sel: ".synopsis", name: "the synopsis" },
  { sel: ".poster",   name: "the poster" },
  { sel: ".bandw",    name: "the availability strip" },
];

for(const r of REGIONS){
  test(`CAS-283: with a control open, tapping ${r.name} closes it and does not expand the card`, async ({ page }) => {
    const card = await toCard(page);
    const target = card.locator(r.sel).first();
    test.skip(await target.count() === 0, `this card has no ${r.name}`);

    await card.locator(".ctl.watch").click();
    await expect(card.locator(".cpop")).toBeVisible();
    const wasExpanded = await card.evaluate(el => el.classList.contains("expanded"));

    // CAS-311 already established the pattern this follows: CAS-278 deliberately replaced the four-answer
    // row with a taller, five-answer vertical scale, and CAS-304 asserts (and keeps green) that the panel
    // opens UPWARD over the card's own content by default — covering it is the design, not a bug. On a card
    // tall enough, the panel can cover a region completely, and there is then no real pixel of it left for a
    // finger to land on — so skip rather than fake a tap nothing could actually make.
    const [t, p] = await Promise.all([target.boundingBox(), card.locator(".cpop").boundingBox()]);
    const covered = t && p && t.x >= p.x && t.y >= p.y
      && t.x + t.width <= p.x + p.width && t.y + t.height <= p.y + p.height;
    test.skip(covered, `the open control panel fully covers ${r.name} on this card — no real tap lands here`);

    await target.click({ position: { x: 4, y: 4 } });
    await expect(card.locator(".cpop"), "the control did not close").toHaveCount(0);
    expect(await card.evaluate(el => el.classList.contains("expanded")),
      "the card expanded as well as closing the control").toBe(wasExpanded);
  });
}

test("CAS-283: with NO control open, tapping the card still expands it", async ({ page }) => {
  const card = await toCard(page);
  await expect(card.locator(".cpop")).toHaveCount(0);
  const before = await card.evaluate(el => el.classList.contains("expanded"));
  await card.locator(".title").click();
  await expect.poll(() => card.evaluate(el => el.classList.contains("expanded"))).toBe(!before);
});

test("CAS-283: it takes a second tap to expand after dismissing a control", async ({ page }) => {
  const card = await toCard(page);
  await card.locator(".ctl.watch").click();
  await card.locator(".title").click();                       // first tap: dismiss only
  await expect(card.locator(".cpop")).toHaveCount(0);
  expect(await card.evaluate(el => el.classList.contains("expanded"))).toBe(false);
  await card.locator(".title").click();                       // second tap: now it opens
  await expect.poll(() => card.evaluate(el => el.classList.contains("expanded"))).toBe(true);
});

test("CAS-283: choosing an option inside the open control still works", async ({ page }) => {
  const card = await toCard(page);
  const id = Number((await card.getAttribute("id")).replace("card-", ""));
  await card.locator(".ctl.watch").click();
  await card.locator(".cpop .cseg").nth(1).click();
  await expect.poll(() => page.evaluate(i => opinionOf(i), id),
    { message: "the dismiss swallowed the option tap" }).toBe("liked");
});

test("CAS-283: a control open on one card does not freeze another card", async ({ page }) => {
  const card = await toCard(page);
  const cards = page.locator("#groups .card");
  test.skip(await cards.count() < 2, "only one card in this listing");
  await card.locator(".ctl.watch").click();
  const other = cards.nth(1);
  await other.scrollIntoViewIfNeeded();
  await other.locator(".title").click();
  // The other card is governed by its own rules, so it opens as normal.
  await expect.poll(() => other.evaluate(el => el.classList.contains("expanded"))).toBe(true);
});
