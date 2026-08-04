// CAS-278: Watch Status is a five-point scale, ordered best-first, on a colour ramp.
import { test, expect } from "@playwright/test";
import { toShortlist, shortlistCards, pickCard, finishFlow, toListing } from "./helpers.mjs";

// CAS-349: "Won't Watch" moved off this ladder entirely (it's "Never" on the Watch panel now); "Enjoyed" is
// the new fifth step, between Watch Again and So-so.
const ORDER = ["Wow!", "Watch Again", "Enjoyed", "So-so", "Disliked"];

async function openWatchPanel(page){
  await toShortlist(page, "cinema");
  const cards = await shortlistCards(page);
  await pickCard(page, cards[0].name);
  await finishFlow(page);
  await toListing(page);
  const card = page.locator("#groups .card").first();
  await card.locator(".ctl.watch").click();
  await expect(page.locator(".cpop .cseg").first()).toBeVisible();
  return card;
}

test("CAS-278: the five options read top to bottom in the ticket's order", async ({ page }) => {
  await openWatchPanel(page);
  const labels = (await page.locator(".cpop .cseg .cl").allTextContents()).map(s => s.trim());
  expect(labels).toEqual(ORDER);
});

test("CAS-278: they are stacked vertically, best at the top", async ({ page }) => {
  await openWatchPanel(page);
  const boxes = await page.locator(".cpop .cseg").evaluateAll(els =>
    els.map(e => { const b = e.getBoundingClientRect(); return { t: b.top, b: b.bottom }; }));
  expect(boxes.length).toBe(5);
  for(let i = 1; i < boxes.length; i++){
    expect(boxes[i].t, `option ${i} is beside option ${i - 1}, not below it`)
      .toBeGreaterThanOrEqual(boxes[i - 1].b - 1);
  }
});

test("CAS-278: the colours form a ramp, and it is visible before anything is chosen", async ({ page }) => {
  await openWatchPanel(page);
  const colours = await page.locator(".cpop .cseg").evaluateAll(els =>
    els.map(e => getComputedStyle(e).borderLeftColor));
  expect(colours.length).toBe(5);
  expect(new Set(colours).size, "the five steps must not share colours").toBe(5);
  for(const c of colours){
    expect(c, "a step has no colour, so there is no ramp to read").not.toBe("rgba(0, 0, 0, 0)");
  }
  // Greatness increases upward: green at the top, red at the bottom.
  const rgb = s => s.match(/\d+/g).map(Number);
  const [tr, tg] = rgb(colours[0]);
  const [br, bg] = rgb(colours[4]);
  expect(tg, "the top of the scale should be the greenest").toBeGreaterThan(tr);
  expect(br, "the bottom of the scale should be the reddest").toBeGreaterThan(bg);
});

test("CAS-278: Wow! is a real fifth answer that persists, not a relabelled Watch Again", async ({ page }) => {
  const card = await openWatchPanel(page);
  const id = Number((await card.getAttribute("id")).replace("card-", ""));
  await page.locator(".cpop .cseg").filter({ has: page.getByText("Wow!", { exact: true }) }).click();

  const state = await page.evaluate(i => ({
    opinion: opinionOf(i),
    watched: watched.has(i),
    wow: wowed.has(i),
    liked: isLiked(i),
  }), id);
  expect(state.opinion).toBe("wow");
  expect(state.wow).toBe(true);
  expect(state.watched, "Wow! rides alongside watched, like every other answer").toBe(true);
  expect(state.liked, "Wow! must not also read as Watch Again — they are different answers").toBe(false);

  // It survives a reload: it is stored, not just held in the session.
  await page.reload();
  await page.waitForFunction(() => Array.isArray(MOVIES));
  expect(await page.evaluate(i => opinionOf(i), id)).toBe("wow");
});

test("CAS-278: the chip's fill tracks greatness, not list position", async ({ page }) => {
  const card = await openWatchPanel(page);
  const id = Number((await card.getAttribute("id")).replace("card-", ""));
  const fillFor = key => page.evaluate(([i, k]) => {
    setOpinion(i, k);
    const html = watchChipHTML(i);
    const m = html.match(/width:([\d.]+)%/);
    return m ? Number(m[1]) : null;
  }, [id, key]);

  const wow = await fillFor("wow");
  const soso = await fillFor("soso");
  // CAS-349: "notfor" is no longer on this ladder (moved to the Watch panel's "Never") — a blocked film never
  // reaches this chip at all (taggedOut() sends it to the stub) — so the worst rank to test against here is
  // now Disliked, the ladder's actual last step.
  const worst = await fillFor("disliked");
  expect(wow, "the best answer should draw the fullest bar").toBe(100);
  expect(wow).toBeGreaterThan(soso);
  expect(soso).toBeGreaterThan(worst);
});

test("CAS-278: a Wow! film still appears in the receipts rather than vanishing", async ({ page }) => {
  const card = await openWatchPanel(page);
  const id = Number((await card.getAttribute("id")).replace("card-", ""));
  await page.locator(".cpop .cseg").filter({ has: page.getByText("Wow!", { exact: true }) }).click();
  const inGroup = await page.evaluate(i => {
    const g = TAG_GROUPS.find(x => x.key === "wow");
    return !!g && g.set().has(i);
  }, id);
  expect(inGroup, "praising a film must not make it disappear from Your Movies").toBe(true);
});
