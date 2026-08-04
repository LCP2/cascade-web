// CAS-350: the card's Cascade control always reads "Agent" — never the cascade's name or a "N cascades" count.
import { test, expect } from "@playwright/test";
import { toShortlist, shortlistCards, pickCard, finishFlow, toListing, settleListing } from "./helpers.mjs";

async function oneAgent(page){
  await toShortlist(page, "cinema");
  const cards = await shortlistCards(page);
  await pickCard(page, cards[0].name);
  await finishFlow(page);
  await toListing(page);
}

const cardLabel = (page, id) =>
  page.locator(`#card-${id} .ctl.casc .clab`).textContent();

test("CAS-350: the control reads \"Agent\" when the film is in this one cascade", async ({ page }) => {
  await oneAgent(page);
  const card = page.locator("#groups .card").first();
  const id = Number((await card.getAttribute("id")).replace("card-", ""));
  expect((await cardLabel(page, id)).trim()).toBe("Agent");
});

test("CAS-350: the control still reads \"Agent\" when the film sits in two cascades", async ({ page }) => {
  await oneAgent(page);
  const card = page.locator("#groups .card").first();
  const id = Number((await card.getAttribute("id")).replace("card-", ""));

  await page.evaluate(i => {
    const src = activeCascade();
    const twin = normCascade({ ...src, id: cascadeNewId(), name: "Second Cascade", icon: "🎬" });
    cascades.push(twin);
    saveCascades();
    notify[i] = notify[i] || {};
    notify[i].cascadeIds = [...new Set([...(notify[i].cascadeIds || []), src.id, twin.id])];
    render();
  }, id);
  await settleListing(page);

  expect((await cardLabel(page, id)).trim()).toBe("Agent");
});
