// CAS-294: no separate list of watch-status films at the bottom of a cascade.
import { test, expect } from "@playwright/test";
import { toShortlist, shortlistCards, pickCard, finishFlow, toListing, settleListing } from "./helpers.mjs";

async function agentListing(page, kind = "cinema"){
  await toShortlist(page, kind);
  const cards = await shortlistCards(page);
  await pickCard(page, cards[0].name);
  await finishFlow(page);
  await toListing(page);
}

async function answerFirst(page, seg = 1){
  const card = page.locator("#groups .card").first();
  await card.scrollIntoViewIfNeeded();
  const id = Number((await card.getAttribute("id")).replace("card-", ""));
  const title = (await card.locator(".title").textContent()).trim();
  await card.locator(".ctl.watch").click();
  await card.locator(".cpop .cseg").nth(seg).click();
  await settleListing(page);
  return { id, title };
}

// CAS-349: "Never" is reached through the Watch panel now, not a `.cseg` on the Watched one.
async function answerNever(page){
  const card = page.locator("#groups .card").first();
  await card.scrollIntoViewIfNeeded();
  const id = Number((await card.getAttribute("id")).replace("card-", ""));
  const title = (await card.locator(".title").textContent()).trim();
  await card.locator(".ctl.notify").click();
  await card.locator('.cpop .nopt[data-wk="never"]').click();
  await settleListing(page);
  return { id, title };
}

test("CAS-294: answering a film adds no group to the foot of the cascade", async ({ page }) => {
  await agentListing(page);
  const before = await page.locator("#listSaid .mlgroup").count();
  await answerFirst(page);
  await expect(page.locator("#listSaid .mlgroup")).toHaveCount(before);
  await expect(page.locator("#listSaid")).not.toContainText(/Watched ·/);
});

test("CAS-294: every watch answer stays out of the footer", async ({ page }) => {
  await agentListing(page);
  for(const seg of [0, 1, 2, 3, 4]){
    const rows = await page.locator("#groups .card").count();
    if(rows === 0) break;
    await answerFirst(page, seg);
  }
  // Never (CAS-349's relabelled/moved "Won't Watch") is on the Watch panel now, not one of these five `.cseg`
  // answers — exercised separately so this loop still covers the blocked path it always meant to.
  if(await page.locator("#groups .card").count() > 0) await answerNever(page);
  const text = (await page.locator("#listSaid").textContent()) || "";
  for(const heading of ["Watched · wow", "Watched · watch again", "Watched · so-so",
                        "Watched · didn't like", "Not for me"]){
    expect(text, `"${heading}" is still listed at the bottom`).not.toContain(heading);
  }
});

test("CAS-294: the film is not shown twice — once in the list and once below it", async ({ page }) => {
  await agentListing(page);
  const { id } = await answerFirst(page);
  const appearances = await page.evaluate(i =>
    document.querySelectorAll(`#listView [id="card-${i}"], #listSaid [data-mlid="${i}"]`).length +
    [...document.querySelectorAll("#listSaid .mlrow .mltitle")].length, id);
  // It is in the listing as its stub, and nowhere in the footer.
  await expect(page.locator(`#groups .stub[id="card-${id}"]`)).toHaveCount(1);
  expect(appearances, "the answered film appears twice on one screen").toBe(1);
});

test("CAS-294: the answer is still reachable — Your Movies owns it", async ({ page }) => {
  await agentListing(page);
  const { id } = await answerFirst(page);
  const inYourMovies = await page.evaluate(i => {
    const g = YM_GROUPS.find(x => x.key === "watched");
    return g.ids().includes(i);
  }, id);
  expect(inYourMovies, "removing the footer list must not orphan the answer").toBe(true);
});

test("CAS-294: the receipts that are NOT watch statuses survive", async ({ page }) => {
  await agentListing(page);
  // Taking a film off your Found list is a Pick override, not a watch status — it is the only undo for
  // that action, so it deliberately keeps its group.
  const kept = await page.evaluate(() => !SAID_HIDDEN.has("removed"));
  expect(kept).toBe(true);
});
