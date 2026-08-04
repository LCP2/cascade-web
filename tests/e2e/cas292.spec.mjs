// CAS-292: a watch status can be taken back, and the card returns to normal.
import { test, expect } from "@playwright/test";
import { toShortlist, shortlistCards, pickCard, finishFlow, toListing, settleListing } from "./helpers.mjs";

async function agentListing(page, kind = "cinema"){
  await toShortlist(page, kind);
  const cards = await shortlistCards(page);
  await pickCard(page, cards[0].name);
  await finishFlow(page);
  await toListing(page);
}

/** Answer the first card, return its id and the height it had as a card. */
async function answerFirst(page, seg){
  const card = page.locator("#groups .card").first();
  await card.scrollIntoViewIfNeeded();
  const id = Number((await card.getAttribute("id")).replace("card-", ""));
  const h = (await card.boundingBox()).height;
  await card.locator(".ctl.watch").click();
  await card.locator(".cpop .cseg").nth(seg).click();
  await settleListing(page);
  await expect(page.locator(`#groups .stub[id="card-${id}"]`)).toHaveCount(1);
  return { id, h };
}

// CAS-349: "Won't Watch" is no longer one of the Watched panel's `.cseg` answers — it moved to the Watch
// panel's "Never" row, same `blocked` flag, different control. Reached via `.ctl.notify` + `.nopt[data-wk]`.
async function answerNever(page){
  const card = page.locator("#groups .card").first();
  await card.scrollIntoViewIfNeeded();
  const id = Number((await card.getAttribute("id")).replace("card-", ""));
  const h = (await card.boundingBox()).height;
  await card.locator(".ctl.notify").click();
  await card.locator('.cpop .nopt[data-wk="never"]').click();
  await settleListing(page);
  await expect(page.locator(`#groups .stub[id="card-${id}"]`)).toHaveCount(1);
  return { id, h };
}

// Every answer must be cancellable, not just the friendly ones.
const ANSWERS = [
  { seg: 0, key: "wow",      name: "Wow!" },
  { seg: 1, key: "liked",    name: "Watch Again" },
  { seg: 2, key: "enjoyed",  name: "Enjoyed" },
  { seg: 3, key: "soso",     name: "So-so" },
  { seg: 4, key: "disliked", name: "Disliked" },
];

for(const a of ANSWERS){
  test(`CAS-292: ${a.name} can be switched off and the card comes back`, async ({ page }) => {
    await agentListing(page);
    const { id, h } = await answerFirst(page, a.seg);
    expect(await page.evaluate(i => opinionOf(i), id)).toBe(a.key);

    // Press the lit answer again — the stub's own buttons carry the same set.
    await page.evaluate(([i, k]) => setOpinion(i, k), [id, a.key]);
    await settleListing(page);

    expect(await page.evaluate(i => opinionOf(i), id), "the answer did not clear").toBe("");
    const card = page.locator(`#groups .card[id="card-${id}"]`);
    await expect(card, "the card did not come back").toHaveCount(1);
    await expect(page.locator(`#groups .stub[id="card-${id}"]`)).toHaveCount(0);
    const back = (await card.boundingBox()).height;
    expect(Math.abs(back - h), `card was ${h}px, came back ${back}px`).toBeLessThan(40);
  });
}

// "Never" is the ticket's own example, and it's reached through the Watch panel now, not the Watched one —
// same underlying `notfor`/`blocked` flag, so it still has to be cancellable the same way as every answer above.
test("CAS-292: Never can be switched off and the card comes back", async ({ page }) => {
  await agentListing(page);
  const { id, h } = await answerNever(page);
  expect(await page.evaluate(i => opinionOf(i), id)).toBe("notfor");

  await page.evaluate(i => setOpinion(i, "notfor"), id);
  await settleListing(page);

  expect(await page.evaluate(i => opinionOf(i), id), "the answer did not clear").toBe("");
  const card = page.locator(`#groups .card[id="card-${id}"]`);
  await expect(card, "the card did not come back").toHaveCount(1);
  await expect(page.locator(`#groups .stub[id="card-${id}"]`)).toHaveCount(0);
  const back = (await card.boundingBox()).height;
  expect(Math.abs(back - h), `card was ${h}px, came back ${back}px`).toBeLessThan(40);
});

test("CAS-292: cancelling from the stub's own control works, not just from the API", async ({ page }) => {
  await agentListing(page);
  const { id } = await answerNever(page);          // Never, the ticket's example
  const stub = page.locator(`#groups .stub[id="card-${id}"]`);
  // The lit button in the stub's row is the undo.
  const lit = stub.locator(".actbtn.on");
  await expect(lit, "the stub does not show which answer is lit").toHaveCount(1);
  await lit.click();
  await settleListing(page);
  expect(await page.evaluate(i => opinionOf(i), id)).toBe("");
  await expect(page.locator(`#groups .card[id="card-${id}"]`)).toHaveCount(1);
});

test("CAS-292: the restored card has its controls back and works again", async ({ page }) => {
  await agentListing(page);
  const { id } = await answerFirst(page, 1);
  await page.evaluate(i => setOpinion(i, "liked"), id);
  await settleListing(page);
  const card = page.locator(`#groups .card[id="card-${id}"]`);
  await card.scrollIntoViewIfNeeded();
  await expect(card.locator(".ctl.watch")).toHaveCount(1);
  await expect(card.locator(".ctl.casc")).toHaveCount(1);
  await expect(card.locator(".ctl.notify")).toHaveCount(1);
  // And it can be answered again.
  await card.locator(".ctl.watch").click();
  await card.locator(".cpop .cseg").nth(0).click();
  await expect.poll(() => page.evaluate(i => opinionOf(i), id)).toBe("wow");
});

test("CAS-292: cancelling puts the film back in the section count", async ({ page }) => {
  await agentListing(page);
  const before = Number(await page.locator("#groups .group .gcount").first().textContent());
  const { id } = await answerFirst(page, 1);
  await expect.poll(async () => Number(await page.locator("#groups .group .gcount").first().textContent()))
    .toBe(before - 1);
  await page.evaluate(i => setOpinion(i, "liked"), id);
  await settleListing(page);
  await expect.poll(async () => Number(await page.locator("#groups .group .gcount").first().textContent()))
    .toBe(before);
});

test("CAS-292: cancelling survives a reload — it really cleared, it did not just repaint", async ({ page }) => {
  await agentListing(page);
  const { id } = await answerFirst(page, 4);
  await page.evaluate(i => setOpinion(i, "disliked"), id);
  await settleListing(page);
  await page.reload();
  await settleListing(page);
  expect(await page.evaluate(i => opinionOf(i), id)).toBe("");
  await expect(page.locator(`#groups .card[id="card-${id}"]`)).toHaveCount(1);
});
