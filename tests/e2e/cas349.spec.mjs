// CAS-349: Watch/Watched taxonomy + relabel. The panel-mechanics and ladder/greying/cascade/Never coverage
// lives in cas245.spec.mjs (the control this ticket rebuilt); this file covers what's specific to the
// ticket's own two remaining claims — the Watched panel's new "Enjoyed" step, and the Watch panel's new
// press-drag-release gesture (it never had one before this ticket).
import { test, expect } from "@playwright/test";
import { toShortlist, shortlistCards, pickCard, finishFlow, toListing, settleListing } from "./helpers.mjs";

async function firstCard(page, kind = "cinema"){
  await toShortlist(page, kind);
  const cards = await shortlistCards(page);
  await pickCard(page, cards[0].name);
  await finishFlow(page);
  await toListing(page);
  await settleListing(page);
  const card = page.locator("#groups .card").first();
  await expect(card).toBeVisible();
  return card;
}

test("CAS-349: Enjoyed sits between Watch Again and So-so, and is its own answer", async ({ page }) => {
  const card = await firstCard(page);
  const id = Number((await card.getAttribute("id")).replace("card-", ""));
  await card.locator(".ctl.watch").click();
  const labels = (await page.locator(".cpop .cseg .cl").allTextContents()).map(s => s.trim());
  expect(labels).toEqual(["Wow!", "Watch Again", "Enjoyed", "So-so", "Disliked"]);

  await page.locator(".cpop .cseg").filter({ has: page.getByText("Enjoyed", { exact: true }) }).click();
  const state = await page.evaluate(i => ({
    opinion: opinionOf(i), watched: watched.has(i), enjoyed: enjoyed.has(i),
    liked: isLiked(i), wow: isWow(i),
  }), id);
  expect(state.opinion).toBe("enjoyed");
  expect(state.watched, "Enjoyed rides alongside watched, like every other answer").toBe(true);
  expect(state.enjoyed).toBe(true);
  expect(state.liked, "Enjoyed must not also read as Watch Again — different answers").toBe(false);
  expect(state.wow).toBe(false);

  // It survives a reload: stored, not just held in the session.
  await page.reload();
  await page.waitForFunction(() => Array.isArray(MOVIES));
  expect(await page.evaluate(i => opinionOf(i), id)).toBe("enjoyed");
});

test("CAS-349: Enjoyed is undoable from the stub, and the stub says Enjoyed", async ({ page }) => {
  const card = await firstCard(page);
  const id = Number((await card.getAttribute("id")).replace("card-", ""));
  await page.evaluate(i => setOpinion(i, "enjoyed"), id);
  await settleListing(page);
  const stub = page.locator(`#groups .stub[id="card-${id}"]`);
  await expect(stub).toContainText("Enjoyed");
  const lit = stub.locator(".actbtn.on.enjoyed");
  await expect(lit).toHaveCount(1);
  await lit.click();
  await settleListing(page);
  expect(await page.evaluate(i => opinionOf(i), id)).toBe("");
});

test("CAS-349: the Watch panel supports press-drag-release, same as the Watched panel", async ({ page }) => {
  const card = await firstCard(page, "stream");
  const id = Number((await card.getAttribute("id")).replace("card-", ""));
  await card.scrollIntoViewIfNeeded();
  await card.locator(".ctl.notify").click();
  const pop = card.locator(".cpop.npop");
  await expect(pop).toBeVisible();

  // The gesture owns the vertical axis here too, the same protection the Watched/Cascade panels already had.
  const ta = await pop.locator(".nopts").evaluate(el => getComputedStyle(el).touchAction);
  expect(ta).not.toBe("auto");

  const rows = pop.locator(".nopt[data-wk]:not(.spent)");
  const n = await rows.count();
  test.skip(n < 2, "this agent's first card has fewer than two live rows to slide across");
  const from = rows.nth(0), to = rows.nth(Math.min(1, n - 1));
  const a = await from.boundingBox(), b = await to.boundingBox();
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
  await page.mouse.down();
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2 + 10);
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 8 });
  await page.mouse.up();

  // The slide's own drop target ends up ticked — whichever row it was (a plain toggle or the auto-tick
  // cascade both leave the released-on row on).
  await expect(to).toHaveAttribute("aria-pressed", "true");
});

test("CAS-349: a plain tap on a Watch level ticks it but leaves the panel open", async ({ page }) => {
  const card = await firstCard(page, "stream");
  await card.scrollIntoViewIfNeeded();
  await card.locator(".ctl.notify").click();
  const pop = card.locator(".cpop.npop");
  const row = pop.locator(".nopt[data-wk]:not(.spent)").first();
  test.skip(await row.count() === 0, "this agent's first card has no live level to tap");
  await row.click();
  // Unlike the Watched panel (which folds the card and removes the popup on answer), a Watch tick is an
  // "adjust and keep going" gesture — the popup must still be there afterwards.
  await expect(pop).toBeVisible();
});

test("CAS-349: Never is reachable by press-drag-release too", async ({ page }) => {
  const card = await firstCard(page, "stream");
  const id = Number((await card.getAttribute("id")).replace("card-", ""));
  await card.scrollIntoViewIfNeeded();
  await card.locator(".ctl.notify").click();
  const pop = card.locator(".cpop.npop");
  const rows = pop.locator(".nopt[data-wk]:not(.spent)");
  const n = await rows.count();
  const never = pop.locator('.nopt[data-wk="never"]');
  const from = rows.nth(0);
  const a = await from.boundingBox(), b = await never.boundingBox();
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
  await page.mouse.down();
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2 + 10);
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 8 });
  await page.mouse.up();
  await settleListing(page);
  expect(await page.evaluate(i => opinionOf(i), id)).toBe("notfor");
});
