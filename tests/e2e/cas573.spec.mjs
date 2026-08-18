// CAS-573: the services warning's dismiss × sat on top of its own text. CAS-254's `.warnnote{padding-
// right:30px}` reserved the room, but a later, same-specificity base `.warnnote{padding:8px 10px}` rule
// (line ~1445) reset it on every render, so the reservation never took effect. The fix rides a modifier —
// `.warnnote.dismissible{padding-right:30px}` — applied only at the one render site that actually carries
// the × (renderCascadeBar's `data-svcnote="empty"` note); the other four `.warnnote` sites must not gain
// padding for a button they don't have.
//
// Reaching "a streaming agent scoped to my services, with no services picked" for real: the linear
// onboarding flow no longer asks about services at all (CAS-475/532 moved that account-wide), and the
// Briefing's own "Where & when" door was retired the same way — so the only per-window `myServices` scope
// control left anywhere in the UI is the legacy builder (openEditor/buildSpine), reachable only via the
// empty-deck "Watch tonight" quick start, which only ever appears at cascades.length===0. That path is
// enough to reach the SAME condition's non-dismissible sibling (#cMineWarn, inside the builder) safely, but
// committing it hits a pre-existing, unrelated bug: with zero cascades the deck has no active card to hold
// #sortCtl (see deckSync's reparenting, ~line 7875), so #sortCtl/#sort sits detached, and syncFilterUI()
// (called from commitDraft -> applyCascade with no such guard, unlike syncSortCtl's) throws setting
// `$("sort").value` on null — never reaching render(). Flagged to Lee separately; out of scope here. The
// deck's own dismissible note is instead reached by setting the one field a working Save would have set
// (`myServices.included_streaming`) on an agent created the normal way, then calling the app's own
// `saveCascades()+render()` — same render path the fix under test runs, without the unrelated crash.
import { test, expect } from "@playwright/test";
import { freshApp, toShortlist, shortlistCards, pickCard, finishFlow, toListing } from "./helpers.mjs";

test("CAS-573: the builder's own non-dismissible scope note carries no extra padding or close button", async ({ page }) => {
  // Empty-deck quick starts only ever appear once a first agent has existed and been deleted — the splash
  // always drives straight into the onboarding funnel, so a fresh guest session cannot land there directly.
  await toShortlist(page, "stream");
  const cards = await shortlistCards(page);
  await pickCard(page, cards[0].name);
  await finishFlow(page);
  await toListing(page);

  await page.locator('.dcard .ca-btn[data-act="edit"]').click();
  await expect(page.locator(".osdel")).toBeVisible();
  page.once("dialog", d => d.accept());
  await page.locator(".osdel").click();

  const watchTonightChip = page.locator(".cschip", { hasText: "Watch tonight" });
  await expect(watchTonightChip).toBeVisible();
  await watchTonightChip.click();

  // "Watch tonight" is pre-scoped to Stream (myServices.included_streaming:true) with no services picked —
  // the builder's own #cMineWarn note fires immediately, before Continue is ever pressed (which is exactly
  // as far as this test goes — see the file header on why).
  const mineWarn = page.locator("#cMineWarn .warnnote");
  await expect(mineWarn).toBeVisible();
  const mineStyle = await mineWarn.evaluate(el => ({
    paddingRight: getComputedStyle(el).paddingRight,
    hasDismissible: el.classList.contains("dismissible"),
    svcxCount: el.querySelectorAll(".svcx").length,
  }));
  expect(mineStyle.paddingRight).toBe("10px");
  expect(mineStyle.hasDismissible).toBe(false);
  expect(mineStyle.svcxCount).toBe(0);

  // Back out without saving — Continue hits the unrelated pre-existing bug described above.
  await page.locator("#builderClose").click();
});

test("CAS-573: the dismiss × does not overlap the note's own text, and dismissing still removes it", async ({ page }) => {
  await toShortlist(page, "stream");
  const cards = await shortlistCards(page);
  await pickCard(page, cards[0].name);
  await finishFlow(page);
  await toListing(page);

  // Set exactly the one field a working "scope to my services" Save would have written, on the agent that
  // real flow just created — see the file header for why the builder's own Continue can't be driven here.
  await page.evaluate(() => {
    const c = activeCascade();
    c.myServices.included_streaming = true;
    saveCascades();
    render();
  });

  const note = page.locator('[data-svcnote="empty"]');
  await expect(note).toBeVisible();
  await expect(note.locator(".svcx")).toBeVisible();

  // AC2: no client rect of the note's own text intersects the × button's rect, at the suite's 390px viewport.
  const overlaps = await note.evaluate(el => {
    const svcx = el.querySelector(".svcx");
    const svcxRect = svcx.getBoundingClientRect();
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, {
      acceptNode: n => (!svcx.contains(n) && n.textContent.trim()) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT,
    });
    let node, hit = false;
    while((node = walker.nextNode())){
      const range = document.createRange();
      range.selectNodeContents(node);
      for(const r of range.getClientRects()){
        if(!(r.right <= svcxRect.left || r.left >= svcxRect.right || r.bottom <= svcxRect.top || r.top >= svcxRect.bottom)){
          hit = true;
        }
      }
    }
    return hit;
  });
  expect(overlaps).toBe(false);

  // AC6 (grep-equivalent, live): only the dismissible modifier carries the reservation.
  const notePadding = await note.evaluate(el => getComputedStyle(el).paddingRight);
  expect(notePadding).toBe("30px");

  // AC5: dismissing still removes the note.
  await note.locator(".svcx").click();
  await expect(page.locator('[data-svcnote="empty"]')).toHaveCount(0);
});

test("CAS-573: the calmer .warnnote.info variant is untouched by the dismissible-modifier split", async ({ page }) => {
  await freshApp(page);   // no app state needed for this one — just the stylesheet loaded
  const style = await page.evaluate(() => {
    const el = document.createElement("div");
    el.className = "warnnote info";
    document.body.appendChild(el);
    const cs = getComputedStyle(el);
    const result = { position: cs.position, paddingRight: cs.paddingRight, color: cs.color };
    el.remove();
    return result;
  });
  expect(style.position).toBe("relative");
  expect(style.paddingRight).toBe("10px");   // no reservation — .info never carries the × button
  expect(style.color).toBe("rgb(197, 216, 255)");   // #c5d8ff, CAS-254's calmer-variant colour, unchanged
});
