// CAS-241: the Watch-status collapse control is a thumb target and points back the way it collapses.
// CAS-374 removed that dedicated in-panel chevron for both Watch and Watched — the chip that opened the
// panel is the only collapse control left, so this file's own coverage now lives in cas374.spec.mjs. What
// stays here is CAS-311's answer-count regression guard, which was never about the chevron.
import { test, expect } from "@playwright/test";
import { toShortlist, shortlistCards, pickCard, finishFlow, toListing, settleListing } from "./helpers.mjs";

async function openWatchPanel(page){
  await toShortlist(page, "stream");
  const cards = await shortlistCards(page);
  await pickCard(page, cards[0].name);
  await finishFlow(page);
  await toListing(page);
  await settleListing(page);
  const card = page.locator("#groups .card").first();
  await card.locator(".ctl.watch").click();
  await expect(card.locator(".cpop")).toBeVisible();
  return card;
}

// CAS-311: CAS-278 replaced the four-answer row with a five-answer, best-first, top-to-bottom scale
// (WATCH_STEPS) — a deliberate design change, not a regression. The invariant this test guards is still
// "no answer is truncated at 360px"; it just checks it against today's five answers instead of the
// original four.
test("CAS-311: the five answers are not squeezed at 360px", async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 800 });
  const card = await openWatchPanel(page);
  const segs = card.locator(".cpop .cseg");
  await expect(segs).toHaveCount(5);
  const labels = await segs.locator(".cl").evaluateAll(els => els.map(e => ({
    text: e.textContent.trim(), clipped: e.scrollWidth > e.clientWidth + 1,
  })));
  // CAS-349: "Won't Watch" moved to the Watch panel's "Never"; "Enjoyed" is the new fifth answer here.
  expect(labels.map(l => l.text)).toEqual(["Wow!", "Watch Again", "Enjoyed", "So-so", "Disliked"]);
  for(const l of labels) expect(l.clipped, `"${l.text}" is being truncated at 360px`).toBe(false);
});

// CAS-374 superseded this file's own close-button contrast test — Watch and Watched no longer have one, so
// there is nothing left to point one way or the other. The chip's own open/closed state is covered by
// cas374.spec.mjs; this just confirms opening one never leaves the other marked open too.
test("CAS-374: only the panel's own chip ever carries the open state", async ({ page }) => {
  const card = await openWatchPanel(page);
  await expect(card.locator(".ctl.watch")).toHaveClass(/open/);
  await expect(card.locator(".ctl.notify")).not.toHaveClass(/open/);
  await page.keyboard.press("Escape");
  await card.locator(".ctl.notify").click();
  await expect(card.locator(".ctl.notify")).toHaveClass(/open/);
  await expect(card.locator(".ctl.watch")).not.toHaveClass(/open/);
});
