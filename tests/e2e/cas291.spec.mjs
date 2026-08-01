// CAS-291: the collapsed watch-status card persists in the cascade and sits in sort order.
import { test, expect } from "@playwright/test";
import { toShortlist, shortlistCards, pickCard, finishFlow, toListing, settleListing } from "./helpers.mjs";

async function agentListing(page, kind = "cinema"){
  await toShortlist(page, kind);
  const cards = await shortlistCards(page);
  await pickCard(page, cards[0].name);
  await finishFlow(page);
  await toListing(page);
}

/** Answer the nth card in the listing; returns its id and title. */
async function answer(page, n = 0, seg = 1){
  const card = page.locator("#groups .card").nth(n);
  await card.scrollIntoViewIfNeeded();
  const id = Number((await card.getAttribute("id")).replace("card-", ""));
  const title = (await card.locator(".title").textContent()).trim();
  await card.locator(".ctl.watch").click();
  await card.locator(".cpop .cseg").nth(seg).click();
  await settleListing(page);
  return { id, title };
}

test("CAS-291: the stub is still there after a repaint", async ({ page }) => {
  await agentListing(page);
  const { id } = await answer(page);
  await page.evaluate(() => { recomputeFound(); render(); });
  await settleListing(page);
  await expect(page.locator(`#groups .stub[id="card-${id}"]`), "a repaint dropped the stub").toHaveCount(1);
});

test("CAS-291: it survives a reload", async ({ page }) => {
  await agentListing(page);
  const { id } = await answer(page);
  await page.reload();
  await settleListing(page);
  await expect(page.locator(`#groups .stub[id="card-${id}"]`)).toHaveCount(1);
  expect(await page.evaluate(i => opinionOf(i), id)).toBe("liked");
});

test("CAS-291: it sits in the section its window puts it in, not at the end", async ({ page }) => {
  await agentListing(page);
  const { id } = await answer(page);
  const placed = await page.evaluate(i => {
    const stub = document.querySelector(`#groups .stub[id="card-${i}"]`);
    const group = stub && stub.closest(".group");
    const m = MOVIES.find(x => x.tmdb_id === i);
    return { section: group && group.dataset.g, window: primaryStatus(m) };
  }, id);
  expect(placed.section, "the stub was moved out of its own availability section").toBe(placed.window);
});

test("CAS-291: under the availability sort it keeps its neighbours' order", async ({ page }) => {
  await agentListing(page);
  const { id } = await answer(page);
  const ok = await page.evaluate(i => {
    const group = document.querySelector(`#groups .stub[id="card-${i}"]`).closest(".group");
    const ids = [...group.querySelectorAll(".card, .stub")].map(e => Number(e.id.replace("card-", "")));
    const c = activeCascade();
    // The order the engine says this section should be in, stubs included.
    const want = MOVIES.filter(m => listedBy(m, c) && primaryStatus(m) === group.dataset.g)
      .sort(sortFor(group.dataset.g)).map(m => m.tmdb_id);
    return JSON.stringify(ids) === JSON.stringify(want.slice(0, ids.length));
  }, id);
  expect(ok, "the stub is not in the sort's own order").toBe(true);
});

test("CAS-291: it moves with the film as the film progresses, still collapsed", async ({ page }) => {
  // A STREAM agent, because the journey this ticket describes (rent -> stream) has to be inside the windows
  // the agent actually lists. On a cinema agent the same film correctly LEAVES when it reaches streaming —
  // that is the agent's scope doing its job, not the stub failing to follow.
  await agentListing(page, "stream");
  const target = await page.evaluate(() => {
    const c = activeCascade();
    const m = MOVIES.find(x => listedBy(x, c) && primaryStatus(x) === "rental");
    return m ? m.tmdb_id : null;
  });
  test.skip(target === null, "this stream agent lists nothing in the Rent window today");

  // Answer it where it stands.
  await page.evaluate(i => setOpinion(i, "liked"), target);
  await settleListing(page);
  const before = await page.evaluate(i => {
    const s = document.querySelector(`#groups .stub[id="card-${i}"]`);
    return s && s.closest(".group") ? s.closest(".group").dataset.g : null;
  }, target);
  expect(before, "the answered film is not in the Rent section").toBe("rental");

  // Now let it progress, as a later poll would leave it.
  const after = await page.evaluate(i => {
    const m = MOVIES.find(x => x.tmdb_id === i);
    m.status = ["included_streaming"];
    render();
    const s = document.querySelector(`#groups .stub[id="card-${i}"]`);
    return { section: s && s.closest(".group") ? s.closest(".group").dataset.g : null,
             stillAStub: !!s, isFullCard: !!document.querySelector(`#groups .card[id="card-${i}"]`) };
  }, target);
  expect(after.section, "the collapsed card did not follow its film down the journey").toBe("included_streaming");
  expect(after.stillAStub, "it stopped being collapsed on the way").toBe(true);
  expect(after.isFullCard, "it came back as a full card").toBe(false);
});

test("CAS-291: several answered films all persist", async ({ page }) => {
  await agentListing(page);
  const a = await answer(page, 0, 0);
  const b = await answer(page, 0, 2);
  for(const x of [a, b]){
    await expect(page.locator(`#groups .stub[id="card-${x.id}"]`)).toHaveCount(1);
  }
});
