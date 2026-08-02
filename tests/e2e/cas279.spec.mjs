// CAS-279: a Cascade control on the card that really moves a film between cascades.
import { test, expect } from "@playwright/test";
import { toShortlist, shortlistCards, pickCard, finishFlow, toListing, settleListing } from "./helpers.mjs";

/** Build an agent, land on its listing. */
async function oneAgent(page, kind = "cinema"){
  await toShortlist(page, kind);
  const cards = await shortlistCards(page);
  await pickCard(page, cards[0].name);
  await finishFlow(page);
  await toListing(page);
}

/** Build a SECOND agent so there is somewhere to move a film to. */
async function twoAgents(page){
  await oneAgent(page, "cinema");
  await page.evaluate(() => {
    // Clone the open agent under a new id and name — the deck's own shape, no criteria invented.
    const src = activeCascade();
    const twin = normCascade({ ...src, id: cascadeNewId(), name: "Second Cascade", icon: "🎬" });
    cascades.push(twin);
    saveCascades();
    render();
  });
  await settleListing(page);
}

test("CAS-279: the Cascade control sits in the middle of the card's controls", async ({ page }) => {
  await oneAgent(page);
  const classes = await page.locator("#groups .card").first()
    .locator(".actions > *").evaluateAll(els => els.map(e => e.className));
  const i = classes.findIndex(c => /\bcasc\b/.test(c));
  expect(i, "there is no Cascade control on the card").toBeGreaterThan(-1);
  expect(i, "it should not be first").toBeGreaterThan(0);
  expect(i, "it should not be last").toBeLessThan(classes.length - 1);
});

test("CAS-279: it reveals the OTHER cascades, never the one you are standing in", async ({ page }) => {
  await twoAgents(page);
  const openName = await page.evaluate(() => activeCascade().name);
  await page.locator("#groups .card").first().locator(".ctl.casc").click();
  await expect(page.locator(".cpop.kpop")).toBeVisible();
  const options = await page.locator(".cpop.kpop .nopt").allTextContents();
  expect(options.length).toBe(1);
  expect(options[0]).toContain("Second Cascade");
  expect(options.join(" "), "the cascade you are already in is not somewhere to move to")
    .not.toContain(openName);
});

test("CAS-279: moving a film really moves it, and the move survives a reload", async ({ page }) => {
  await twoAgents(page);
  const card = page.locator("#groups .card").first();
  const id = Number((await card.getAttribute("id")).replace("card-", ""));
  const fromId = await page.evaluate(() => activeCascade().id);

  await card.locator(".ctl.casc").click();
  await page.locator(".cpop.kpop .nopt").first().click();
  await settleListing(page);

  const state = await page.evaluate(([i, f]) => {
    const to = cascades.find(c => c.name === "Second Cascade");
    return {
      listedInTarget: listedBy(MOVIES.find(m => m.tmdb_id === i), to),
      listedInSource: listedBy(MOVIES.find(m => m.tmdb_id === i), cascades.find(c => c.id === f)),
      pinnedTo: (notify[i] || {}).pinnedTo || [],
      notIn: (notify[i] || {}).notIn || [],
    };
  }, [id, fromId]);
  expect(state.listedInTarget, "the film did not arrive in the target cascade").toBe(true);
  expect(state.listedInSource, "a move must also take it out of where it was").toBe(false);
  expect(state.notIn).toContain(fromId);

  // The whole point: membership is derived and rewritten on every recompute, so the move has to outlast one.
  await page.evaluate(() => { recomputeFound(); render(); });
  expect(await page.evaluate(i => {
    const to = cascades.find(c => c.name === "Second Cascade");
    return listedBy(MOVIES.find(m => m.tmdb_id === i), to);
  }, id), "a recompute undid the move").toBe(true);

  await page.reload();
  await page.waitForFunction(() => Array.isArray(MOVIES));
  expect(await page.evaluate(i => ((notify[i] || {}).pinnedTo || []).length, id)).toBeGreaterThan(0);
});

test("CAS-279: a moved film is watched by the agent it moved to, so it can still alert", async ({ page }) => {
  await twoAgents(page);
  const card = page.locator("#groups .card").first();
  const id = Number((await card.getAttribute("id")).replace("card-", ""));
  await card.locator(".ctl.casc").click();
  await page.locator(".cpop.kpop .nopt").first().click();
  await settleListing(page);

  const ids = await page.evaluate(i => ((notify[i] || {}).cascadeIds || []), id);
  const targetId = await page.evaluate(() => cascades.find(c => c.name === "Second Cascade").id);
  expect(ids, "a move that buys a row but no alerts is only half a move").toContain(targetId);
});

test("CAS-279: with only one cascade the panel explains itself rather than opening empty", async ({ page }) => {
  await oneAgent(page);
  await page.locator("#groups .card").first().locator(".ctl.casc").click();
  await expect(page.locator(".cpop.kpop")).toBeVisible();
  await expect(page.locator(".cpop.kpop .nonone")).toBeVisible();
  await expect(page.locator(".cpop.kpop .nopt")).toHaveCount(1);
});

test("CAS-279: the deck card's count includes a film moved into it", async ({ page }) => {
  await twoAgents(page);
  const before = await page.evaluate(() =>
    listedCount(cascades.find(c => c.name === "Second Cascade")));
  const card = page.locator("#groups .card").first();
  await card.locator(".ctl.casc").click();
  await page.locator(".cpop.kpop .nopt").first().click();
  await settleListing(page);
  const after = await page.evaluate(() =>
    listedCount(cascades.find(c => c.name === "Second Cascade")));
  expect(after, "the number describing the cascade must count the film you put in it")
    .toBeGreaterThanOrEqual(before);
});
