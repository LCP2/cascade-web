// CAS-293: searching a cascade finds films that carry a watch status.
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

test("CAS-293: a film you have answered is still findable by name", async ({ page }) => {
  await agentListing(page);
  const { id, title } = await answerFirst(page);
  const found = await page.evaluate(([i, t]) => {
    filt.search = t.toLowerCase().slice(0, 10);
    const hit = scopeRows().some(m => m.tmdb_id === i);
    filt.search = "";
    return hit;
  }, [id, title]);
  expect(found, `"${title}" was answered and then could not be found in its own cascade`).toBe(true);
});

test("CAS-293: it is findable for every answer, including Won't Watch", async ({ page }) => {
  for(const seg of [0, 4]){          // Wow! and Won't Watch — the two stored differently
    await agentListing(page);
    const { id, title } = await answerFirst(page, seg);
    const found = await page.evaluate(([i, t]) => {
      filt.search = t.toLowerCase().slice(0, 10);
      const hit = scopeRows().some(m => m.tmdb_id === i);
      filt.search = "";
      return hit;
    }, [id, title]);
    expect(found, `answer ${seg} made "${title}" unfindable`).toBe(true);
  }
});

test("CAS-293: the search UI shows it, as its collapsed line", async ({ page }) => {
  await agentListing(page);
  const { id, title } = await answerFirst(page);
  await page.evaluate(t => { filt.search = t.toLowerCase().slice(0, 10); render(); },
    title);
  await settleListing(page);
  await expect(page.locator(`#groups [id="card-${id}"]`), "the search results dropped it").toHaveCount(1);
  await expect(page.locator(`#groups .stub[id="card-${id}"]`), "it should still be collapsed").toHaveCount(1);
});

test("CAS-293: searching still narrows — an unrelated term does not return it", async ({ page }) => {
  await agentListing(page);
  const { id } = await answerFirst(page);
  const found = await page.evaluate(i => {
    filt.search = "zzzznotarealtitle";
    const hit = scopeRows().some(m => m.tmdb_id === i);
    filt.search = "";
    return hit;
  }, id);
  expect(found, "the search stopped filtering").toBe(false);
});

test("CAS-293: an answered film is findable in the All view too", async ({ page }) => {
  await agentListing(page);
  const { id, title } = await answerFirst(page);
  await page.evaluate(() => { setActive(ALL_ID); render(); });
  await settleListing(page);
  const found = await page.evaluate(([i, t]) => {
    filt.search = t.toLowerCase().slice(0, 10);
    const hit = scopeRows().some(m => m.tmdb_id === i);
    filt.search = "";
    return hit;
  }, [id, title]);
  expect(found).toBe(true);
});
