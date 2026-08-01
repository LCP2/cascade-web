// CAS-282: press-then-slide on the Watch Status and Cascade controls.
import { test, expect } from "@playwright/test";
import { toShortlist, shortlistCards, pickCard, finishFlow, toListing, settleListing } from "./helpers.mjs";

async function oneAgent(page){
  await toShortlist(page, "cinema");
  const cards = await shortlistCards(page);
  await pickCard(page, cards[0].name);
  await finishFlow(page);
  await toListing(page);
  return page.locator("#groups .card").first();
}

async function twoAgents(page){
  const card = await oneAgent(page);
  await page.evaluate(() => {
    const src = activeCascade();
    cascades.push(normCascade({ ...src, id: cascadeNewId(), name: "Second Cascade", icon: "🎬" }));
    saveCascades(); render();
  });
  await settleListing(page);
  return page.locator("#groups .card").first();
}

/** Bring the whole control stack into view — a slide can only cross options the viewport is showing. */
async function showPanel(card, opener){
  await card.scrollIntoViewIfNeeded();
  await card.locator(opener).click();
  const pop = card.locator(".cpop");
  await expect(pop).toBeVisible();
  // Centre the panel in the viewport. elementFromPoint — which is what a slide reads — returns null outside
  // it, so a panel hanging off the bottom of the screen cannot be dragged across in a test or by a thumb.
  const page = card.page();
  await page.evaluate(() => {
    const r = document.querySelector("#groups .card .cpop").getBoundingClientRect();
    window.scrollBy(0, r.top + r.height / 2 - window.innerHeight / 2);
  });
  await page.waitForTimeout(150);
  const clipped = await page.evaluate(() =>
    [...document.querySelectorAll("#groups .card .cpop .cseg, #groups .card .cpop .nopt")]
      .filter(el => { const b = el.getBoundingClientRect();
                      return b.top < 0 || b.bottom > window.innerHeight; }).length);
  expect(clipped, "an option is off-screen, so a slide could not reach it").toBe(0);
}

/** Press on `from`, drag to `to`, release — one continuous gesture. */
async function slide(page, from, to){
  const a = await from.boundingBox(), b = await to.boundingBox();
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
  await page.mouse.down();
  // Several steps, so the move clears the wobble threshold the way a finger does.
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2 + 10);
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 8 });
  await page.mouse.up();
}

test("CAS-282: sliding down the Watch Status options picks the one you release on", async ({ page }) => {
  const card = await oneAgent(page);
  const id = Number((await card.getAttribute("id")).replace("card-", ""));
  await showPanel(card, ".ctl.watch");
  const segs = card.locator(".cpop .cseg");
  await expect(segs).toHaveCount(5);
  await slide(page, segs.nth(0), segs.nth(3));      // Wow! -> Disliked
  await expect.poll(() => page.evaluate(i => opinionOf(i), id)).toBe("disliked");
});

test("CAS-282: the option under the finger is highlighted on the way", async ({ page }) => {
  const card = await oneAgent(page);
  await showPanel(card, ".ctl.watch");
  const segs = card.locator(".cpop .cseg");
  const a = await segs.nth(0).boundingBox(), b = await segs.nth(2).boundingBox();
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
  await page.mouse.down();
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2 + 10);
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 6 });
  await expect(segs.nth(2)).toHaveClass(/sliding/);
  await page.mouse.up();
  // The cue is transient — it says "this is what you'd get", not "this is chosen".
  await expect(card.locator(".cpop .sliding")).toHaveCount(0);
});

test("CAS-282: a plain tap still works and is not applied twice", async ({ page }) => {
  const card = await oneAgent(page);
  const id = Number((await card.getAttribute("id")).replace("card-", ""));
  await showPanel(card, ".ctl.watch");
  // These controls TOGGLE, so a double-fire would select and then undo — leaving no answer at all.
  await card.locator(".cpop .cseg").nth(1).click();
  await expect.poll(() => page.evaluate(i => opinionOf(i), id)).toBe("liked");
});

test("CAS-282: a slide that goes nowhere leaves the tap alone", async ({ page }) => {
  const card = await oneAgent(page);
  const id = Number((await card.getAttribute("id")).replace("card-", ""));
  await showPanel(card, ".ctl.watch");
  const seg = card.locator(".cpop .cseg").nth(0);
  const b = await seg.boundingBox();
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
  await page.mouse.down();
  await page.mouse.move(b.x + b.width / 2 + 2, b.y + b.height / 2 + 2);   // under the wobble threshold
  await page.mouse.up();
  await expect.poll(() => page.evaluate(i => opinionOf(i), id)).toBe("wow");
});

test("CAS-282: the Cascade control slides too", async ({ page }) => {
  const card = await oneAgent(page);
  // Two targets, so the slide has somewhere to travel — with one option there is nothing to traverse.
  await page.evaluate(() => {
    const src = activeCascade();
    cascades.push(normCascade({ ...src, id: cascadeNewId(), name: "Second Cascade", icon: "🎬" }));
    cascades.push(normCascade({ ...src, id: cascadeNewId(), name: "Third Cascade", icon: "🎥" }));
    saveCascades(); render();
  });
  await settleListing(page);
  const first = page.locator("#groups .card").first();
  const id = Number((await first.getAttribute("id")).replace("card-", ""));
  await showPanel(first, ".ctl.casc");
  const opts = first.locator(".cpop.kpop .nopt[data-cid]");
  await expect(opts).toHaveCount(2);

  // Press on the first option, run down onto the second, release there.
  await slide(page, opts.nth(0), opts.nth(1));
  const thirdId = await page.evaluate(() => cascades.find(c => c.name === "Third Cascade").id);
  await expect.poll(() => page.evaluate(i => (notify[i] || {}).pinnedTo || [], id))
    .toContain(thirdId);
});

test("CAS-282: the gesture owns the vertical axis so the page cannot scroll under it", async ({ page }) => {
  const card = await oneAgent(page);
  await showPanel(card, ".ctl.watch");
  const ta = await page.evaluate(() =>
    getComputedStyle(document.querySelector("#groups .card .cpop .csegs")).touchAction);
  expect(ta).not.toBe("auto");
});
