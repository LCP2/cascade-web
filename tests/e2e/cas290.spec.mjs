// CAS-290: answering a film shrinks its card, from the bottom, into a single line.
import { test, expect } from "@playwright/test";
import { toShortlist, shortlistCards, pickCard, finishFlow, toListing, settleListing } from "./helpers.mjs";

async function firstCard(page, kind = "cinema"){
  await toShortlist(page, kind);
  const cards = await shortlistCards(page);
  await pickCard(page, cards[0].name);
  await finishFlow(page);
  await toListing(page);
  const card = page.locator("#groups .card").first();
  await card.scrollIntoViewIfNeeded();
  await expect(card).toBeVisible();
  return card;
}

test("CAS-290: the card becomes a single line, and stays in the list", async ({ page }) => {
  const card = await firstCard(page);
  const id = Number((await card.getAttribute("id")).replace("card-", ""));
  const cardH = (await card.boundingBox()).height;

  await card.locator(".ctl.watch").click();
  await card.locator(".cpop .cseg").nth(1).click();
  await settleListing(page);

  const stub = page.locator(`#groups .stub[id="card-${id}"]`);
  await expect(stub, "the answered film left the cascade instead of folding").toHaveCount(1);
  const stubH = (await stub.boundingBox()).height;
  expect(stubH, `stub is ${stubH}px, card was ${cardH}px`).toBeLessThan(cardH / 2);
  // One line: tall enough to read, short enough that it cannot be two.
  expect(stubH).toBeLessThan(70);
});

test("CAS-290: it shrinks from the BOTTOM — the row's top does not move", async ({ page }) => {
  const card = await firstCard(page);
  const id = Number((await card.getAttribute("id")).replace("card-", ""));
  const topBefore = (await card.boundingBox()).y;

  await card.locator(".ctl.watch").click();
  await card.locator(".cpop .cseg").nth(1).click();
  await settleListing(page);
  await page.waitForTimeout(500);   // let the height animation settle

  const stub = page.locator(`#groups .stub[id="card-${id}"]`);
  const topAfter = (await stub.boundingBox()).y;
  // Shrinking from the bottom means the top edge holds its place on screen; shrinking from the top would
  // pull the row up under the finger that tapped it.
  expect(Math.abs(topAfter - topBefore), `top moved ${Math.abs(topAfter - topBefore)}px`).toBeLessThan(12);
});

test("CAS-290: the single line still says which film and which answer", async ({ page }) => {
  const card = await firstCard(page);
  const id = Number((await card.getAttribute("id")).replace("card-", ""));
  const title = (await card.locator(".title").textContent()).trim();

  await card.locator(".ctl.watch").click();
  await card.locator(".cpop .cseg").nth(1).click();
  await settleListing(page);

  const stub = page.locator(`#groups .stub[id="card-${id}"]`);
  await expect(stub.locator(".stubname")).toContainText(title.replace(/\s+\S+$/, "").slice(0, 12));
  await expect(stub.locator(".stubwhy")).toHaveText(/Watch Again/i);
});

test("CAS-290: the section count drops it, because a stub is not a result", async ({ page }) => {
  const card = await firstCard(page);
  const group = page.locator("#groups .group").first();
  const before = Number(await group.locator(".gcount").first().textContent());
  await card.locator(".ctl.watch").click();
  await card.locator(".cpop .cseg").nth(1).click();
  await settleListing(page);
  await expect.poll(async () => Number(await page.locator("#groups .group .gcount").first().textContent()))
    .toBe(before - 1);
});

test("CAS-290: answering does not scroll the page out from under you", async ({ page }) => {
  const card = await firstCard(page);
  await page.evaluate(() => window.scrollBy(0, 400));
  await page.waitForTimeout(200);
  const target = page.locator("#groups .card").first();
  await target.scrollIntoViewIfNeeded();
  const y = await page.evaluate(() => window.scrollY);
  await target.locator(".ctl.watch").click();
  await target.locator(".cpop .cseg").nth(1).click();
  await settleListing(page);
  await page.waitForTimeout(500);
  const y2 = await page.evaluate(() => window.scrollY);
  expect(Math.abs(y2 - y), "the view jumped when the card folded").toBeLessThan(60);
});
