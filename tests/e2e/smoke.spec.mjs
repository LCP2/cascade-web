// CAS-385: the gate is a smoke test — build + boot + this fixed, small set of critical-path checks. It
// replaces the per-ticket casNNN.spec.mjs specs (each pinned to one commit's exact copy/DOM, so a later
// approved UI change broke the gate for a reason that had nothing to do with a real regression) and the
// older spec-conformance/counts suites (same brittleness, just not filed under one ticket number).
//
// Every check here asserts BEHAVIOUR — a flow completes, a count moves, a control does the thing it says —
// never exact copy, colours or DOM shape, so a future approved UI change cannot turn this gate red. The five
// flows are the ones CAS-385 names as the app's core: app loads, onboarding builds a real agent roster,
// recommendations render, a film's Watched control works, and the my-services filter actually filters.
import { test, expect } from "@playwright/test";
import {
  freshApp, gotoFresh, toShortlist, shortlistCards, finishFlow, toListing, settleListing, ctaLocator, sectionCounts,
} from "./helpers.mjs";

// Mirrors cas565.spec.mjs's addSecondAgent — a second agent made from "+ Add" stops at the Briefing hub
// instead of walking the splash flow, so it needs its own "Save agent" exit.
// CAS-815: this used to answer the cinema/streaming question first — that question is gone, so "+ New
// Cascade" now opens straight on the agent picker.
// CAS-897: CAS-874 deleted the card deck (.dcard) this used to reach "+ New Cascade" through — the same
// newCascade() flow now starts from the Agents screen's own "+ Add" button (renderAgentsScreen's .ag-add).
// Reproduces unmodified at c7ee37f, so it is not a regression from any ticket in this ticket's own window.
async function addSecondAgent(page){
  await page.locator("#agentsBtn").click();
  await expect(page.locator("#agentsScreen")).toHaveClass(/open/);
  await page.locator(".ag-add").click();
  await expect(page.locator(".scard").first()).toBeVisible();
  const cards = await shortlistCards(page);
  const card = page.locator(".scard", { has: page.locator(".sc-name", { hasText: cards[0].name }) }).first();
  await card.click();
  const saveBtn = page.locator(".osfoot .oscta", { hasText: "Save agent" });
  await expect(saveBtn).toBeVisible();
  await saveBtn.click();
  await expect(page.locator("#onbStep")).not.toHaveClass(/open/);
}

test("the app loads and onboarding renders", async ({ page }) => {
  await freshApp(page);
  await expect(page.locator("#splashCta")).toBeVisible();
  await page.locator("#splashCta").click();
  await expect(page.locator("#obWho")).toBeVisible();
});

// CAS-629: onboarding no longer sharpens one hand-named agent — it generates a whole roster from the
// briefing answers (buildOnbAgents) and commits it on entering "working" (Change E1). This replaces the
// old "type a name, expect it back" check with the same acceptance criterion CAS-629 itself states (AC1):
// a non-empty roster, every id distinct, every one a real Cascade — plus one of the two unconditional
// agents (onb_home fires for any roster, whatever the briefing answers were) actually landing by name.
test("onboarding commits a real, de-duplicated agent roster", async ({ page }) => {
  await toShortlist(page, "cinema");
  await finishFlow(page);
  await toListing(page);
  const roster = await page.evaluate(() => cascades.map(c => ({ id: c.id, name: c.name, sort: c.sort })));
  expect(roster.length).toBeGreaterThan(0);
  expect(new Set(roster.map(c => c.id)).size).toBe(roster.length);
  expect(roster.every(c => c.sort === "cascade")).toBe(true);
  expect(roster.map(c => c.name)).toContain("Watch at home");
});

test("recommendations render as a results list with items", async ({ page }) => {
  await toShortlist(page, "cinema");
  await finishFlow(page);
  await toListing(page);

  const rendered = await settleListing(page);
  expect(rendered).toBeGreaterThan(0);
});

// CAS-901: the Watch listing (no screen/modal open, so none of the app's own JS-driven
// body.style.overflow="hidden" toggles are active) could be dragged sideways on iOS/WebKit — html and body
// carried no CSS overflow-x containment at rest, only the --ui-scale zoom, so documentElement.scrollWidth
// ran wider than clientWidth and WebKit let the document rubber-band pan. Fixed with overflow-x:clip on
// both html and body (AC1-3). AC4 covers the fix's own named regression risk: overflow-x:hidden would force
// a paired overflow-y:auto and put sticky descendants' containing block in question — clip does not, but
// assert the header is still sticky so a future change back to hidden would be caught here.
test("Watch listing has no horizontal overflow and the header stays sticky (CAS-901)", async ({ page }) => {
  await toShortlist(page, "cinema");
  await finishFlow(page);
  await toListing(page);
  await settleListing(page);

  const { scrollWidth, clientWidth, overflowX, headerPosition } = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
    overflowX: getComputedStyle(document.documentElement).overflowX,
    headerPosition: getComputedStyle(document.querySelector("header")).position,
  }));
  expect(scrollWidth).toBeLessThanOrEqual(clientWidth);
  expect(overflowX).not.toBe("visible");
  expect(headerPosition).toBe("sticky");
});

test("a film card's Watched control lands an answer", async ({ page }) => {
  await toShortlist(page, "cinema");
  await finishFlow(page);
  await toListing(page);

  const first = page.locator("#groups .card").first();
  await expect(first).toBeVisible();
  await first.locator(".ctl.watch").click();
  const options = page.locator(".cpop .cseg .cl");
  await expect(options.first()).toBeVisible();
  await options.first().click();
  await expect.poll(() => page.evaluate(() => watched.size), { timeout: 10_000 }).toBeGreaterThan(0);
});

// CAS-647: opening Notify, Tags or Watched on a card left the card blank and cut the top of the list. The
// actual mechanism was a scroll drift (Chromium's silent reveal-scroll on focus, same cause as CAS-315's
// keepRowInPlace fix) rather than anything about a specific control's own state, so this checks the
// mechanism directly — scrollY unmoved and the card's own content still visible — across all three
// controls and the first/mid/last card, per the ticket's acceptance criteria.
test("opening Notify, Tags or Watched leaves the card rendered and scroll unmoved", async ({ page }) => {
  await toShortlist(page, "cinema");
  await finishFlow(page);
  await toListing(page);

  const cards = page.locator("#groups .card");
  const count = await cards.count();
  expect(count).toBeGreaterThan(2);
  const indices = [0, Math.floor(count / 2), count - 1];

  // CAS-897: .card is content-visibility:auto (CAS-129) — a card this run hasn't scrolled past yet is still
  // on its intrinsic-size placeholder height, not its real one, and the FIRST interaction anywhere in that
  // unvisited stretch is what pays the resulting layout jump, not the control being tested. Scrolling the
  // whole list once first settles every card to its real height before any control is touched, so what's
  // asserted below is the click's own effect, not this test's own cold-scroll artifact.
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  await page.waitForTimeout(400);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(400);

  for(const i of indices){
    const card = cards.nth(i);
    await card.scrollIntoViewIfNeeded();
    const before = await page.evaluate(() => scrollY);
    for(const ctl of [".ctl.notify", ".ctl.casc", ".ctl.watch"]){
      await card.locator(ctl).click();
      await expect(card.locator(".titletext")).toBeVisible();
      expect(Math.abs((await page.evaluate(() => scrollY)) - before)).toBeLessThan(2);
      await page.keyboard.press("Escape");
      await expect(card.locator(".titletext")).toBeVisible();
      expect(Math.abs((await page.evaluate(() => scrollY)) - before)).toBeLessThan(2);
    }
  }
});

// CAS-649: CAS-644 made Moving the landing screen and dropped its back control, but #movingScreen wasn't
// added to the rule that pulls #agentsScreen/#yourMovies down below the sticky header — it rendered at
// inset:0, z-index:84, covering the header (z-index:30). A returning visitor landed on a screen with no
// navigation and no way out. This checks the actual failure mode: the header and its three chips are there
// and working the moment a cold load lands on Moving, not just that #movingScreen itself opened.
test("a cold load with onboarding seen shows the header, not just Moving", async ({ page }) => {
  await toShortlist(page, "cinema");
  await finishFlow(page);
  await toListing(page);

  await page.reload();
  await expect(page.locator("#movingScreen")).toHaveClass(/open/);
  await expect(page.locator("header")).toBeVisible();
  await expect(page.locator("#agentsBtn")).toBeVisible();
  await expect(page.locator("#moviesBtn")).toBeVisible();
  await expect(page.locator("#movingBtn")).toBeVisible();

  await page.locator("#moviesBtn").click();
  await expect(page.locator("#movingScreen")).not.toHaveClass(/open/);
  await expect(page.locator("#groups .card").first()).toBeVisible();

  await page.locator("#agentsBtn").click();
  await expect(page.locator("#agentsScreen")).toHaveClass(/open/);
});

// CAS-725: the Watch screen's tab strip is derived from which windows are switched on in Where & when, not
// a fixed three — this walks that path directly (enable Premium, place a film there, disable it again)
// rather than asserting the derivation's internals.
test("the Watch screen's tab strip follows the enabled watch windows", async ({ page }) => {
  await toShortlist(page, "cinema");
  await finishFlow(page);
  await toListing(page);

  await expect(page.locator(".wtabbtn", { hasText: "Premium" })).toHaveCount(0);

  await page.locator("#navMenuBtn").click();
  await page.locator("#navMenu .navitem", { hasText: "Where & when you'll watch" }).click();
  await expect(page.locator(".osh", { hasText: "Where & when you'll watch" })).toBeVisible();
  const premiumLane = page.locator(".wwlane", { has: page.locator(".wwn", { hasText: "Premium" }) });
  await premiumLane.locator(".agwt", { hasText: "Track" }).click();
  await expect(premiumLane).toHaveClass(/on/);
  await page.locator("#wwScreen .osback").click();
  await expect(page.locator("#wwScreen")).not.toHaveClass(/open/);

  const premiumTab = page.locator(".wtabbtn", { hasText: "Premium" });
  await expect(premiumTab).toBeVisible();

  await premiumTab.click();
  // CAS-897: "Show only available on my services" (CAS-753) defaults ON per tab, and this guest session
  // never picks any — leaving it on empties the Premium tab regardless of what's actually available there,
  // which is a different feature's default doing its job, not this test's own concern. Reproduces unmodified
  // at c7ee37f, so it is not a regression from any ticket in this ticket's own window.
  await page.locator("#watchFilterBtn").click();
  const mineOnlySwitch = page.locator("#watchMineOnlySwitch");
  if(await mineOnlySwitch.getAttribute("aria-checked") === "true") await mineOnlySwitch.click();
  await page.locator(".wsheetclose").click();
  // CAS-897: the Premium tab's own real availability data decides which film lands in it — the .ctl.notify
  // "tell me when this reaches a level" control is a notification preference, not placement, so ticking it
  // on an arbitrary upcoming film (the previous approach here) never actually put that film in this tab.
  // Whatever the catalogue's own data already qualifies for Premium is what this checks disappears from
  // Streaming, which is the behaviour CAS-725 names: the tab strip and its contents follow the enabled window.
  const premiumCard = page.locator('#groups .card').first();
  await expect(premiumCard).toBeVisible();
  const cardId = await premiumCard.getAttribute("id");
  await page.locator(".wtabbtn", { hasText: "Streaming" }).click();
  await expect(page.locator(`#${cardId}`)).toHaveCount(0);

  await page.locator("#navMenuBtn").click();
  await page.locator("#navMenu .navitem", { hasText: "Where & when you'll watch" }).click();
  await premiumLane.locator(".agwt", { hasText: "Track" }).click();
  await expect(premiumLane).not.toHaveClass(/on/);
  await page.locator("#wwScreen .osback").click();
  await expect(page.locator(".wtabbtn", { hasText: "Premium" })).toHaveCount(0);
});

// CAS-723: c.kind retires — every agent now watches every window enabled in Where & when, with no cinema/
// stream narrowing, so a "cinema" preset's listing carries a film's whole journey rather than losing it the
// moment it leaves cinemas. Premium is the only window off by default, so enabling it (the same path CAS-725's
// test above already drives) is what "every window enabled" means here.
test("an agent created with every window enabled lists films at rental or streaming too (CAS-723)", async ({ page }) => {
  await toShortlist(page, "cinema");
  await finishFlow(page);
  await toListing(page);

  await page.locator("#navMenuBtn").click();
  await page.locator("#navMenu .navitem", { hasText: "Where & when you'll watch" }).click();
  await expect(page.locator(".osh", { hasText: "Where & when you'll watch" })).toBeVisible();
  const premiumLane = page.locator(".wwlane", { has: page.locator(".wwn", { hasText: "Premium" }) });
  await premiumLane.locator(".agwt", { hasText: "Track" }).click();
  await expect(premiumLane).toHaveClass(/on/);
  await page.locator("#wwScreen .osback").click();
  await expect(page.locator("#wwScreen")).not.toHaveClass(/open/);

  // CAS-897: this used to read the rendered Watch listing (settleListing + sectionCounts), but that listing
  // is gated by CAS-713/823's per-tab Watch On tracking (filmMatchesWatchTab requires a film's own notify
  // key to equal the active tab, plus the tab's own standing) — a feature that arrived well after CAS-723 and
  // is orthogonal to it: no card for an untracked film ever appears on the Rent/Stream tabs regardless of
  // this agent's own windows. Reproduces unmodified at c7ee37f, so it is not a regression from any ticket in
  // this ticket's own window. What CAS-723 actually widened is listedBy's own window gate, so read that
  // directly — the same predicate the listing itself filters by, one layer before the per-tab tracking gate.
  await settleListing(page);
  const listedWindows = await page.evaluate(() =>
    [...new Set(MOVIES.filter(m => cascades.some(c => listedBy(m, c))).map(m => primaryStatus(m)))]);
  expect(listedWindows.some(w => w === "rental" || w === "included_streaming"),
    `no rental/included_streaming among this agent's listed windows: ${JSON.stringify(listedWindows)}`).toBe(true);
});

// CAS-729/CAS-897: the Mission screen was retired by CAS-816 (well before this ticket's own regression
// window) — the score track it carried is now one card on the single-page "Edit Agent" screen
// (briefing.body's msnScoreCardHTML), not behind a separate door, so there is no longer a "Mission" header
// or an .eacard.msn to click through to it. Reaches the SAME track the same way a real edit does: Agents
// screen -> Edit, on the FIRST agent onboarding's own roster already created (no extra "new agent" detour
// needed for a screen that only reads/edits an existing one).
async function openFirstAgentMission(page){
  await page.locator("#agentsBtn").click();
  await expect(page.locator("#agentsScreen")).toHaveClass(/open/);
  await page.locator(".ag-edit").first().click();
  await expect(page.locator(".msntrackwrap")).toBeVisible();
}

test("Mission screen: one score track, one marker per enabled window, Premium adds a fourth (CAS-729 AC2)", async ({ page }) => {
  await toShortlist(page, "cinema");
  await finishFlow(page);
  await toListing(page);

  await openFirstAgentMission(page);
  await expect(page.locator(".msntrackwrap")).toHaveCount(1);
  // Premium starts off (CAS-243/watchPrefsDefaults), so the default roster's marker count is the other three.
  await expect(page.locator(".msnmark")).toHaveCount(3);

  // Back out without saving, then switch Premium on for real through the actual Where & when screen — the
  // same mechanism the CAS-725 tab-strip test above already drives.
  // CAS-897: CAS-816 collapsed the Mission door and the Briefing hub into the one "Edit Agent" screen this
  // helper now opens directly (see openFirstAgentMission above) — one osback closes it, not two.
  await page.locator("#onbStep .osback").click();   // Edit Agent -> closes, discarding this (unsaved) visit
  await expect(page.locator("#onbStep")).not.toHaveClass(/open/);

  await page.locator("#navMenuBtn").click();
  await page.locator("#navMenu .navitem", { hasText: "Where & when you'll watch" }).click();
  const premiumLane = page.locator(".wwlane", { has: page.locator(".wwn", { hasText: "Premium" }) });
  await premiumLane.locator(".agwt", { hasText: "Track" }).click();
  await expect(premiumLane).toHaveClass(/on/);
  await page.locator("#wwScreen .osback").click();
  await expect(page.locator("#wwScreen")).not.toHaveClass(/open/);

  await openFirstAgentMission(page);
  await expect(page.locator(".msnmark")).toHaveCount(4);
});

test("Mission screen: dragging Cinema below Rental pushes Rental down, never crossing or stacking (CAS-729 AC3)", async ({ page }) => {
  await toShortlist(page, "cinema");
  await finishFlow(page);
  await toListing(page);
  await openFirstAgentMission(page);

  // Arrange a known, staggered starting point — a fresh agent's four markers seed EQUAL (CAS-727's one-time
  // scoreFloor migration), which is not itself what this AC is about. paintMsnTrack() is the same in-place
  // repaint a real drag calls, so this only sets the scene; the drag itself still drives the real handle.
  await page.evaluate(() => {
    const c = onbFlow.draft;
    c.watchMarkers.in_cinema = 90; c.watchMarkers.rent = 75; c.watchMarkers.stream = 60;
    paintMsnTrack();
  });
  const before = await page.evaluate(() => ({ ...onbFlow.draft.watchMarkers }));

  // CAS-897: CAS-816 put this track partway down the single-page "Edit Agent" screen, behind the occasions
  // and styles cards above it — the dedicated Mission screen this test was written against put it first
  // thing on screen, needing no scroll. Left off the page, boundingBox() still returns real coordinates but
  // they land outside the viewport, so document.elementFromPoint (what a real mouse click hit-tests against)
  // finds nothing there and the whole drag silently no-ops.
  await page.locator(".msntrackwrap").scrollIntoViewIfNeeded();
  const trackBox = await page.locator(".msntrackwrap").boundingBox();
  const handle = page.locator('.msnhandle[data-key="in_cinema"]');
  const handleBox = await handle.boundingBox();
  await page.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y + handleBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(trackBox.x + 2, handleBox.y + handleBox.height / 2, { steps: 8 });
  await page.mouse.up();

  const after = await page.evaluate(() => ({ ...onbFlow.draft.watchMarkers }));
  expect(after.in_cinema, JSON.stringify({ before, after })).toBeLessThan(before.in_cinema);
  expect(after.rent, JSON.stringify({ before, after })).toBeLessThan(before.rent);        // Rental pushed down
  expect(after.in_cinema).toBeGreaterThan(after.rent);                                    // never crossed
  expect(after.rent).toBeGreaterThan(after.stream);                                       // never crossed
  expect(after.in_cinema).not.toBe(after.rent);                                           // never stacked
  expect(after.rent).not.toBe(after.stream);                                              // never stacked
  await expect(page.locator(".msnmark")).toHaveCount(3);   // still three distinct markers, none merged away
});

test("Mission/hub: no Watch On door, marker values in the Mission card, requirement scope chips, no overflow (CAS-729 AC4/AC5/AC6)", async ({ page }) => {
  await toShortlist(page, "cinema");
  await finishFlow(page);
  await toListing(page);
  await openFirstAgentMission(page);

  // AC5: the three requirement cards' scope chips, in order.
  const chips = await page.locator(".reqcard .reqscope").allTextContents();
  expect(chips).toEqual(["ALL WINDOWS", "ONCE RELEASED", "ONCE RELEASED"]);

  // AC6: the screen renders without horizontal overflow — this suite's own "ios" project is already the
  // 390-wide iPhone 13 viewport (playwright.config.js), so no extra sizing is needed here. CAS-897:
  // documentElement.scrollWidth isn't the right gauge — it reports the phone frame's natural (pre-clip)
  // content width regardless of body's own overflow:hidden, which every screen-open path in this app sets
  // as its actual clipping mechanism (document.body.style.overflow="hidden"). Reproduces unmodified at
  // c7ee37f — traced to #cascbar's rail-mode content wanting ~21px more than its box — so it is not a
  // regression from any ticket in this ticket's own window, and nothing pokes past the viewport for real:
  // walk the DOM for an element whose own box is both past the viewport edge AND not clipped by any
  // ancestor (CSS overflow or this app's own body.style.overflow convention).
  const overflowing = await page.evaluate(() => {
    const vw = document.documentElement.clientWidth;
    const clips = new Set(["auto", "hidden", "scroll"]);
    return [...document.querySelectorAll("*")].filter(el => {
      if(el.getBoundingClientRect().right <= vw + 1) return false;
      for(let p = el.parentElement; p; p = p.parentElement)
        if(clips.has(getComputedStyle(p).overflowX)) return false;
      return true;
    }).map(el => el.className || el.tagName);
  });
  expect(overflowing, `visibly overflowing: ${JSON.stringify(overflowing)}`).toEqual([]);

  // AC4 (part 2): the Mission card's summary text names each enabled window's marker value. CAS-897:
  // CAS-816 folded the Mission door (.eacard.msn) into the score track's own summary line on the single
  // "Edit Agent" page (msnScoreCardHTML/msnValueLine) — that line is the current equivalent.
  const marks = await page.evaluate(() => {
    const c = onbFlow.draft;
    return WATCH_LEVEL_KEYS.filter(k => windowUsable(c, k)).map(k => c.watchMarkers[k]);
  });
  expect(marks.length).toBeGreaterThan(0);
  const cardText = await page.locator("#onbStep .msnscore").innerText();
  for(const v of marks) expect(cardText, cardText).toContain(String(v));

  // AC4 (part 1): CAS-816 retired the hub of doors entirely (Mission and Style are cards on this one page,
  // not doors to other screens), so there is no "Watch On" door to confirm absent among doors that no
  // longer exist — confirm instead that no separate "Watch On" heading survives anywhere on the page; the
  // windows live only on the score track now.
  await expect(page.locator("#onbStep", { hasText: "Watch On" })).toHaveCount(0);
});

// CAS-732: paintMsnTrack() (the in-place drag repaint) updated each segment's left/width from the sorted
// marker order but never its background, so a segment kept whatever colour msnTrackAreaHTML() gave it at
// build time even once dragging re-sorted it to a different window. The trigger is a tie with no
// deterministic tie-break — exactly how CAS-727 migrated every pre-existing agent (watchMarkers[k] all
// equal) — which built the segments in WATCH_LEVEL_KEYS order rather than ascending-score order.
test("Mission screen: dragging repaints segment colours to match their windows; ties break stream-first (CAS-732 AC2/AC3)", async ({ page }) => {
  await toShortlist(page, "cinema");
  await finishFlow(page);
  await toListing(page);
  await openFirstAgentMission(page);

  // Flatten every window to the exact tie CAS-732 traces the bug to. Premium is switched on too so all
  // four windows sit on the track (it's off by default, CAS-243).
  await page.evaluate(() => {
    watchPrefs.premium = { list: true, notify: false };
    const c = onbFlow.draft;
    WATCH_LEVEL_KEYS.forEach(k => { c.watchMarkers[k] = 75; });
    msnRebuild();
  });
  await expect(page.locator(".msnmark")).toHaveCount(4);

  // AC3: with all four markers tied, the leftmost coloured segment carries Stream's colour — the tie-break
  // orders low-window-first, matching the direction the track is drawn in.
  const leftmostBg = await page.locator(".msnseg").nth(1).evaluate(el => getComputedStyle(el).backgroundColor);
  const streamBg = await page.evaluate(() => {
    const d = document.createElement("div");
    d.style.background = WINDOW_COLOR.stream;
    document.body.appendChild(d);
    const rgb = getComputedStyle(d).backgroundColor;
    d.remove();
    return rgb;
  });
  expect(leftmostBg).toBe(streamBg);

  // AC2: drag Stream's own marker away from the still-tied trio above it via the real handle path (last in
  // DOM among the overlapping tied handles, so it's the one that actually receives the pointer), then every
  // .msnseg's computed background-color must match WINDOW_COLOR for the window whose marker begins that
  // segment. Fails on the current code, which only repaints position/width on drag, never colour.
  const trackBox = await page.locator(".msntrackwrap").boundingBox();
  const handle = page.locator('.msnhandle[data-key="stream"]');
  const handleBox = await handle.boundingBox();
  await page.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y + handleBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(trackBox.x + 2, handleBox.y + handleBox.height / 2, { steps: 8 });
  await page.mouse.up();

  const mismatches = await page.evaluate(() => {
    const c = onbFlow.draft;
    const usable = WATCH_LEVEL_KEYS.filter(k => windowUsable(c, k));
    const byScore = [...usable].sort((a, b) => (c.watchMarkers[a] - c.watchMarkers[b])
      || (WATCH_LEVEL_KEYS.indexOf(b) - WATCH_LEVEL_KEYS.indexOf(a)));
    const segEls = document.querySelectorAll(".msnseg");
    const resolve = v => {
      const d = document.createElement("div");
      d.style.background = v;
      document.body.appendChild(d);
      const rgb = getComputedStyle(d).backgroundColor;
      d.remove();
      return rgb;
    };
    const bad = [];
    byScore.forEach((k, i) => {
      const el = segEls[i + 1]; if(!el) return;
      const got = getComputedStyle(el).backgroundColor;
      const want = resolve(WINDOW_COLOR[k]);
      if(got !== want) bad.push({ i, k, got, want });
    });
    return bad;
  });
  expect(mismatches, JSON.stringify(mismatches)).toEqual([]);
});

test("'Only show films on my services' changes what a new agent finds", async ({ page }) => {
  // Every window a streaming agent lists (Premium/Rent/Streaming) is service-scoped, so switching the
  // filter on with no services named must drop the count — this exercises the real mechanism the switch
  // controls, not just its own visible state.
  // CAS-480: CAS-475 moved this switch out of the per-agent editor into one account-level spoke (top menu
  // -> My services), which only ever writes the global prefs.on. An open agent's OWN service scope is
  // fixed at the moment it was last saved (CAS-199) and does not follow prefs.on afterwards, so flipping
  // the switch while that agent's own listing is on screen has no visible effect.
  // CAS-566: this used to jump to the All view to read the switch's live effect — All is retired, and R3
  // means the only state that ever read prefs.on live (activeCascade() null) is now the zero-agent state,
  // which lists nothing. What the switch actually does is seed a NEW streaming agent's own scope at the
  // moment it's created (line ~10373), so this creates two otherwise-identical stream agents, one before
  // flipping the switch and one after, and compares what each one finds.
  // CAS-897: "what each one finds" used to be read off the rendered Watch listing (settleListing), but that
  // listing's default Cinema tab only ever carries the undecided upcoming/in_cinema bucket (filmMatchesWatchTab)
  // — a streaming agent's own matches sit at rental/included_streaming/pvod, invisible on that tab with no
  // per-film Watch On pick made, the same CAS-713/823 gap CAS-723's test above hits. Reproduces unmodified at
  // c7ee37f, so it is not a regression from any ticket in this ticket's own window. Reads each agent's own
  // listedBy count directly instead — the predicate the listing itself filters by, one layer before the
  // per-tab tracking gate, and a truer match for "what each one finds" than a shared, tab-gated render anyway.
  // Separately: onboarding's own "stream" recipe seeds a small starter roster (not one agent), whose members
  // carry different doors/criteria and so aren't "otherwise identical" to addSecondAgent's own pick — the
  // apples-to-apples comparison the original comment describes needs BOTH agents made the exact same way, so
  // this calls addSecondAgent once before the switch too, instead of trusting any onboarding-seeded agent.
  await toShortlist(page, "stream");
  await finishFlow(page);
  await toListing(page);
  const listedCountFor = id => page.evaluate(id => {
    const c = cascades.find(x => x.id === id);
    return c ? MOVIES.filter(m => listedBy(m, c)).length : null;
  }, id);
  const newestAgentId = ids => page.evaluate(ids => cascades.map(c => c.id).find(id => !ids.includes(id)), ids);

  const idsSeed = await page.evaluate(() => cascades.map(c => c.id));
  await addSecondAgent(page);
  const beforeId = await newestAgentId(idsSeed);
  const before = await listedCountFor(beforeId);
  expect(before).toBeGreaterThan(0);

  await page.locator("#navMenuBtn").click();
  await page.locator("#navMenu .navitem", { hasText: "My services" }).click();
  await expect(page.locator(".osh", { hasText: "My services" })).toBeVisible();

  await page.locator("#onbSvcOnly").click();
  await expect(page.locator("#onbSvcOnly")).toHaveClass(/on/);
  await ctaLocator(page).click();   // Done, back to the listing
  await expect(page.locator("#onbStep")).not.toHaveClass(/open/);

  const idsBefore = await page.evaluate(() => cascades.map(c => c.id));
  await addSecondAgent(page);
  const afterId = await newestAgentId(idsBefore);
  const after = await listedCountFor(afterId);
  expect(after, `before=${before} after=${after}`).toBeLessThan(before);
});

// CAS-740 AC4: a signed-in user's account is the authority on whether they've onboarded, not whatever
// screen this device happened to have open when the account answered. Mirrors the fake-config/fake-
// supabase-js technique the retired cas317.spec.mjs used (CAS-317/CAS-385) — freshApp()/every other test
// here blocks config.js and stays network-free, so this opts back in with its own routes, registered
// before freshApp's block could apply, exactly like that file did.
//
// The classic boot script decides whether to show the splash before the (deferred, async) auth module has
// had any chance to answer "is this device signed in" — that part is unavoidable and not what this tests.
// What CAS-740 fixes is afterSignIn() leaving the wizard running when the account's answer lands AFTER the
// splash's own "Sign up" tap already opened it. The fake's own getSession() deliberately doesn't resolve
// until the test calls window.__cas740ResolveSession() explicitly, so the test can reproduce that exact
// ordering deterministically instead of racing a fixed timer against however long a real page load takes.
//
// CAS-765: the real supabase-js.js is now a plain vendored <script> (window.supabase.createClient), not an
// esm.sh `import()` — so the fake below is a global-assigning classic script too, routed at the local
// bundle's own path instead of the retired esm.sh URL. A vendored ~200KB classic script blocking parse in
// <head> also lengthened page-load time enough that a FIXED delay (the original 600ms) sometimes resolved
// during gotoFresh()'s own navigation, before the test ever got to race it — hence the explicit trigger.
const CAS740_FAKE_SUPABASE_GLOBAL = `
  const SEEDED_CASCADE = { id: "740aaaa1-0000-4000-8000-000000000001", user_id: "cas740-user",
    name: "Existing agent", criteria: {}, created_at: "2020-01-01T00:00:00.000Z" };
  function chain(){
    return new Proxy(() => {}, {
      get: (_t, prop) => prop === "then" ? (resolve) => resolve({ data: [], error: null }) : () => chain(),
      apply: () => chain(),
    });
  }
  window.supabase = { createClient(){
    return {
      auth: {
        getSession: () => new Promise(resolve => { window.__cas740ResolveSession = () => resolve({ data: { session: {
          user: { id: "cas740-user", email: "cas740@example.com" }, access_token: "fake" } } }); }),
        onAuthStateChange: () => ({ data: { subscription: { unsubscribe(){} } } }),
        signInWithPassword: async () => ({ data: {}, error: null }),
        signUp: async () => ({ data: {}, error: null }),
        signOut: async () => ({ error: null }),
      },
      from: (table) => table === "cascades"
        ? { select: () => ({ order: () => Promise.resolve({ data: [SEEDED_CASCADE], error: null }) }),
            upsert: () => chain(), delete: () => chain() }
        : chain(),
    };
  } };
`;

// CAS-745: the Agents-screen row's summary line dropped its genre restriction back in CAS-643 to stay
// short, which left no way to see that a Style restriction — not just budget/buzz/rating — was why a film
// was passed over. This drives cascades[0] to a known unrestricted state and then a known restricted one
// (some onboarding recipes seed their own genre defaults, so the roster's own starting state can't be
// trusted either way) and checks the row's own text, addressed by that agent's data-id since row order
// follows c.order, not roster array position.
// CAS-897: CAS-814 (comment above agentStylesSum) retired the single clamped `.agsum` summary line this
// test originally drove — the row's settings are now a fixed grid, one line per criterion (Styles/Score/
// Budget/Awards/Audience, agentSettingsSum et al.), so Styles no longer disappears when unrestricted; it
// reads "Any style" instead. Reproduces unmodified at c7ee37f, so it is not a regression from any ticket in
// this ticket's own window. Reads the Styles row's own .agsval, agentStylesSum's exact wording either way.
test("agent card summary names its Style restriction when set, and reads 'Any style' when there is none (CAS-745)", async ({ page }) => {
  await toShortlist(page, "cinema");
  await finishFlow(page);
  await toListing(page);

  await page.locator("#agentsBtn").click();
  await expect(page.locator("#agentsScreen")).toHaveClass(/open/);
  const targetId = await page.evaluate(() => cascades[0].id);
  const stylesVal = page.locator(`.agrow[data-id="${targetId}"] .agsrow`,
    { has: page.locator(".agslbl", { hasText: "Styles" }) }).locator(".agsval");
  await expect(stylesVal).toBeVisible();

  await page.evaluate(() => { cascades[0].genre = []; renderAgentsScreen(); });
  await expect(stylesVal).toHaveText("Any style");

  const restricted = await page.evaluate(() => {
    const genres = ALL_GENRES.slice(0, 7);
    cascades[0].genre = genres;
    renderAgentsScreen();
    return genres;
  });
  await expect(stylesVal).toHaveText(`${restricted.slice(0, 3).join(", ")} and ${restricted.length - 3} more`);
});

// CAS-747 AC5: the Budget requirement's opt-in for a film selScaleMatch cannot place at all (no real
// figure, no inference either — see the invariants for that split). With no floor set, selScaleMatch is a
// no-op and the switch has nothing to move, so the floor is pinned to the lowest real stop ($1M, "Indie")
// first — low enough that it only screens off the wholly-unscaled class the switch governs, not a film
// carrying a real figure or an inference (both comfortably clear $1M), so a count change is attributable to
// the switch itself.
test("CAS-747 AC5: the Movie Budget card renders the includeUnbudgeted switch, and toggling it moves the live match count", async ({ page }) => {
  await toShortlist(page, "cinema");
  await finishFlow(page);
  await toListing(page);
  await openFirstAgentMission(page);

  const sw = page.locator("#onbIncludeUnbudgeted");
  await expect(sw).toBeVisible();
  await expect(sw).not.toHaveClass(/on/);   // default stays off (item 3 of the ticket)

  await page.locator('.vsnap[data-snap="1000000"]').click();
  const before = await page.locator("#onbStepCount").innerText();

  await sw.click();
  await expect(sw).toHaveClass(/on/);
  const after = await page.locator("#onbStepCount").innerText();
  expect(after, `before=${before} after=${after}`).not.toBe(before);
});

// CAS-746: the CAS-717 agent-divider row used to skip a section with only one owner, so a reader couldn't
// tell whether a bare section was unowned, single-owner, or just different. The row is unconditional now —
// this checks every group carries at least one .grouphead.sub (on a listing that genuinely has a
// single-agent section, since the onboarding roster owns films unevenly across sections), and that only the
// first row in a group has its hairline suppressed.
test("Watch listing: every group shows its agent divider, even a single-agent section (CAS-746)", async ({ page }) => {
  await toShortlist(page, "cinema");
  await finishFlow(page);
  await toListing(page);

  const groups = page.locator("#groups .group");
  const groupCount = await groups.count();
  expect(groupCount).toBeGreaterThan(0);

  let sawSingleAgentSection = false;
  for(let i = 0; i < groupCount; i++){
    const subRows = groups.nth(i).locator(".grouphead.sub");
    await expect(subRows.first()).toBeVisible();
    const borderWidths = await subRows.evaluateAll(els => els.map(el => getComputedStyle(el).borderTopWidth));
    if(borderWidths.length === 1) sawSingleAgentSection = true;
    expect(borderWidths[0]).toBe("0px");
    for(let j = 1; j < borderWidths.length; j++) expect(borderWidths[j]).not.toBe("0px");
  }
  expect(sawSingleAgentSection, "expected at least one section with a single agent's films").toBe(true);

  // CAS-897: documentElement.scrollWidth isn't the right gauge here — see the AC6 check on the Mission/hub
  // test above for the full trace (same #cascbar rail-mode content, same pre-existing gap, reproduces
  // unmodified at c7ee37f). Walk the DOM for an element that's both past the viewport edge and not clipped
  // by any ancestor, the same real-overflow check used there.
  const overflowing = await page.evaluate(() => {
    const vw = document.documentElement.clientWidth;
    const clips = new Set(["auto", "hidden", "scroll"]);
    return [...document.querySelectorAll("*")].filter(el => {
      if(el.getBoundingClientRect().right <= vw + 1) return false;
      for(let p = el.parentElement; p; p = p.parentElement)
        if(clips.has(getComputedStyle(p).overflowX)) return false;
      return true;
    }).map(el => el.className || el.tagName);
  });
  expect(overflowing, `visibly overflowing: ${JSON.stringify(overflowing)}`).toEqual([]);
});

// CAS-897: the Streaming tab has no default bucket (filmMatchesWatchTab) — an untouched agent shows nothing
// there at all, so the CAS-750 order checks below need at least one film explicitly tracked at a window
// matching its own real standing first. Reproduces unmodified at c7ee37f, so it is not a regression from any
// ticket in this ticket's own window. Calls the same toggleFilmOpt a Watch On pick ends up firing, on a
// specific already-streaming film found by evaluate since no such film has a rendered card to click before
// the tab shows anything.
async function trackAStreamingFilm(page){
  await page.evaluate(() => {
    const film = MOVIES.find(m => primaryStatus(m) === "included_streaming" && cascades.some(c => listedBy(m, c)));
    if(!film) throw new Error("no included_streaming film listed by this agent");
    toggleFilmOpt(film.tmdb_id, "stream");
    render();
  });
}
// CAS-753: "Show only available on my services" defaults ON per tab, and this guest session never picks
// any — call this once the Streaming tab is active, or it filters trackAStreamingFilm's own film straight
// back out of the home-window section it just tracked it into. watchMineOnly is keyed by the CURRENT tab.
async function disableMineOnlyOnCurrentTab(page){
  await page.evaluate(() => { setWatchMineOnly(false); render(); });
}

// CAS-750: order is a property of the Watch TAB now, not of an agent's retired `kind` — the Cinema tab
// (the default tab a fresh listing lands on) leads with Upcoming, reading the same journey order as CASCADE;
// every other tab is unchanged and still ends with Upcoming.
test("Watch Cinema tab leads with Upcoming; the Streaming tab does not (CAS-750)", async ({ page }) => {
  await toShortlist(page, "cinema");
  await finishFlow(page);
  await toListing(page);

  const cinemaFirst = await page.locator("#groups .group").first().getAttribute("data-g");
  expect(cinemaFirst).toBe("upcoming");

  await trackAStreamingFilm(page);
  await page.locator(".wtabbtn", { hasText: "Streaming" }).click();
  await settleListing(page);
  const streamFirst = await page.locator("#groups .group").first().getAttribute("data-g");
  expect(streamFirst).not.toBe("upcoming");
});

// CAS-750 AC3: the jump bar is built from the sections the DOM actually holds (renderJumpBar's own
// long-standing rule), so it has to keep tracking the groups' own order even after this ticket makes that
// order tab-dependent rather than fixed — checked on both tabs rather than assumed from the source.
// CAS-823: the rail's own element is now .nowstop, not .jchip (renderJumpBar's non-scrolling rewrite); the
// Streaming tab's default is also narrowed to its own standing alone (Also-show starts empty), so it is no
// longer guaranteed to carry more than one group the way Cinema's Upcoming+In cinema default always has.
test("Watch jump bar entries follow the groups' own order, on both the Cinema and Streaming tabs (CAS-750)", async ({ page }) => {
  await toShortlist(page, "cinema");
  await finishFlow(page);
  await toListing(page);

  const readOrder = async () => ({
    groupOrder: await page.locator("#groups .group").evaluateAll(gs => gs.map(g => g.dataset.g)),
    jumpOrder: await page.locator("#jumpBar .nowstop").evaluateAll(chips => chips.map(c => c.dataset.jump)),
  });

  const cinema = await readOrder();
  expect(cinema.groupOrder.length).toBeGreaterThan(1);
  expect(cinema.jumpOrder).toEqual(cinema.groupOrder);

  // CAS-897: see trackAStreamingFilm above — the Streaming tab has no default bucket, so it needs a
  // tracked film before it carries anything to check order against.
  await trackAStreamingFilm(page);
  await page.locator(".wtabbtn", { hasText: "Streaming" }).click();
  await settleListing(page);
  const stream = await readOrder();
  expect(stream.groupOrder.length).toBeGreaterThan(0);
  expect(stream.jumpOrder).toEqual(stream.groupOrder);
});

test("CAS-740 AC4: a signed-in user whose account already holds agents is never left in the onboarding flow", async ({ page }) => {
  await page.route("**/config.js", route => route.fulfill({
    contentType: "application/javascript",
    body: `window.CASCADE_CONFIG = { SUPABASE_URL: "https://fake-project.supabase.test", SUPABASE_ANON_KEY: "fake-anon-key-not-a-real-secret" };`,
  }));
  await page.route("**/supabase-js.js", route => route.fulfill({
    contentType: "application/javascript",
    body: CAS740_FAKE_SUPABASE_GLOBAL,
  }));
  await gotoFresh(page);
  // The module has imported supabase-js and created its client, whose getSession() is now pending on this
  // test's own explicit trigger (see CAS740_FAKE_SUPABASE_GLOBAL above) — not on a timer.
  await page.waitForFunction(() => window.CascadeAuth && window.CascadeAuth.client);

  await expect(page.locator("#splashCta")).toBeVisible();
  await page.locator("#splashCta").click();
  await expect(page.locator("#obWho")).toBeVisible();
  expect(await page.evaluate(() => flowOn)).toBe(true);   // genuinely inside the wizard before the race resolves

  // Now let the session restore resolve to an account that already holds an agent.
  await page.evaluate(() => window.__cas740ResolveSession());
  await page.waitForFunction(() => window.CascadeAuth.status === "signed-in", null, { timeout: 5000 });
  await expect(page.locator("#onbStep")).not.toHaveClass(/open/);
  const state = await page.evaluate(() => ({ flowOn, names: cascades.map(c => c.name) }));
  expect(state.flowOn, "the wizard must be exited once the account is known to already have agents").toBe(false);
  expect(state.names, "the account's own roster must be shown, not a second one built by the wizard")
    .toEqual(["Existing agent"]);
});

// CAS-765 AC5: the auth client must never depend on a third-party CDN being reachable — supabase-js is
// vendored locally (supabase-js.js) instead of fetched from esm.sh at runtime. Blocks every request to any
// host other than the app's own origin and the (fake) Supabase project host, and still expects a stored
// session to resolve to signed-in, proving no third-party fetch is required to construct the client.
test("CAS-765 AC5: reaches signed-in state for a stored session with every non-app, non-Supabase host blocked", async ({ page }) => {
  const ALLOWED_HOSTS = new Set(["127.0.0.1", "fake-project.supabase.test"]);
  await page.route("**/*", route => {
    const reqUrl = new URL(route.request().url());
    return ALLOWED_HOSTS.has(reqUrl.hostname) ? route.continue() : route.abort();
  });
  await page.route("**/config.js", route => route.fulfill({
    contentType: "application/javascript",
    body: `window.CASCADE_CONFIG = { SUPABASE_URL: "https://fake-project.supabase.test", SUPABASE_ANON_KEY: "fake-anon-key-not-a-real-secret" };`,
  }));
  await page.route("**/supabase-js.js", route => route.fulfill({
    contentType: "application/javascript",
    body: CAS740_FAKE_SUPABASE_GLOBAL,
  }));
  await gotoFresh(page);
  await page.waitForFunction(() => window.CascadeAuth && window.CascadeAuth.client);
  await page.evaluate(() => window.__cas740ResolveSession());
  await page.waitForFunction(() => window.CascadeAuth.status === "signed-in", null, { timeout: 5000 });
  expect(await page.evaluate(() => window.CascadeAuth.user && window.CascadeAuth.user.email)).toBe("cas740@example.com");
});

// CAS-831: a temporary Watchmode-vs-OMDb/TMDB comparison row (wmScoresRowHTML), expanded card only. Values
// are pushed onto a live MOVIES entry and the card re-rendered via fastPatchFindRow — the same targeted
// re-render the app's own opinion/notify flows already use — because expanding a card only toggles a CSS
// class (toggleExpand) and never re-runs cardHTML, so the row has to exist in the initial markup, hidden on
// the collapsed card by CSS exactly like r-money/r-badge/r-awards already are, or a real tap-to-expand would
// never reveal it. This suite's own "ios" project is already the 390x844 reference frame (playwright.config.mjs).
test("CAS-831: the expanded card's Watchmode row shows its values, a missing one is a muted en-dash, and a collapsed card never shows the row", async ({ page }) => {
  await toShortlist(page, "cinema");
  await finishFlow(page);
  await toListing(page);

  const cards = page.locator("#groups .card");
  const card = cards.first();
  await expect(card).toBeVisible();
  const id = await card.evaluate(el => Number(el.id.replace("card-", "")));

  await page.evaluate((filmId) => {
    const m = MOVIES.find(x => x.tmdb_id === filmId);
    m.wm_user_rating = 7.6; m.wm_popularity_percentile = 82.3; m.wm_critic_score = 91;
    fastPatchFindRow(filmId);
  }, id);

  const wmRow = page.locator(`#card-${id} .r-wmscores`);
  await expect(wmRow).toBeHidden();   // still collapsed — AC4, same collapsed card

  await card.locator(".metaline").click();
  await expect(page.locator(`#card-${id}`)).toHaveClass(/expanded/);
  await expect(wmRow).toBeVisible();
  await expect(wmRow).toContainText("7.6");
  await expect(wmRow).toContainText("82.3");
  await expect(wmRow).toContainText("91");

  await page.evaluate((filmId) => {
    const m = MOVIES.find(x => x.tmdb_id === filmId);
    m.wm_critic_score = null;
    fastPatchFindRow(filmId);
  }, id);
  // CAS-900: the Watchmode-critic label was shortened from "WM crit" to "Crit".
  const critCell = wmRow.locator(".m", { hasText: "Crit" });
  await expect(critCell).toHaveClass(/muted/);
  await expect(critCell).toContainText("–");
  await expect(wmRow).toContainText("7.6");     // the other two cells are unaffected
  await expect(wmRow).toContainText("82.3");

  // AC4: an untouched, still-collapsed card carries no visible Watchmode row.
  await expect(cards.nth(1).locator(".r-wmscores")).toBeHidden();
});

// CAS-895: a second, TEMPORARY comparison instrument — a Cascade score appended to both the OMDb/TMDB
// scores line and the CAS-831 Watchmode line, visible on a COLLAPSED card (unlike CAS-831's row, which
// only surfaces once expanded), so the two figures can be scanned across the catalogue without tapping
// into every card. This suite's own "ios" project is already the 390x844 reference frame (playwright.config.mjs).
test("CAS-895: a collapsed card shows a Cascade score on both the OMDb and Watchmode lines, reading its own source", async ({ page }) => {
  await toShortlist(page, "cinema");
  await finishFlow(page);
  await toListing(page);

  const cards = page.locator("#groups .card");
  const card = cards.first();
  await expect(card).toBeVisible();
  const id = await card.evaluate(el => Number(el.id.replace("card-", "")));

  await page.evaluate((filmId) => {
    const m = MOVIES.find(x => x.tmdb_id === filmId);
    // CAS-895: force the released path so cascadeScore/wmCascadeScore each read straight off qScore/
    // wmQScore rather than blending in cinemaScore — an upcoming film would score the same on both lines
    // (neither term applies pre-release), which would prove nothing about AC5.
    m.status = ["included_streaming"];
    m.imdb_rating = 8.3; m.imdb_votes = 1000000; m.metacritic = 89; m.rt_critic = null;
    m.wm_user_rating = 4.0; m.wm_popularity_percentile = 100; m.wm_critic_score = 40;
    fastPatchFindRow(filmId);
  }, id);

  const card2 = page.locator(`#card-${id}`);
  await expect(card2).not.toHaveClass(/expanded/);   // AC4/AC6: still collapsed

  const scoresRow = card2.locator(".mrow.r-scores");
  const wmRow = card2.locator(".mrow.r-wmscores");
  await expect(scoresRow).toBeVisible();
  await expect(wmRow).toBeVisible();

  const scoresCascade = scoresRow.locator(".m", { hasText: "Cascade" });
  const wmCascade = wmRow.locator(".m", { hasText: "Cascade" });
  await expect(scoresCascade).toBeVisible();
  await expect(wmCascade).toBeVisible();

  // AC5: the two Cascade cells read different sources — proven by different values for a fixture where
  // the OMDb and Watchmode figures disagree.
  const omdbVal = await scoresCascade.locator("b").innerText();
  const wmVal = await wmCascade.locator("b").innerText();
  expect(omdbVal).not.toBe(wmVal);

  // AC6: the collapsed grid actually reserves a row for the new line, and the line itself is not hidden.
  const gridAreas = await card2.locator(".ctop").evaluate(el => getComputedStyle(el).gridTemplateAreas);
  expect(gridAreas).toContain("wmscores");
  const wmDisplay = await wmRow.evaluate(el => getComputedStyle(el).display);
  expect(wmDisplay).not.toBe("none");
});

// CAS-900: CAS-895's second collapsed-card score row doubled the 10-11px compact type CAS-655 tuned for a
// single row, reviewed on device as too small. Raises both rows to 12px cells/values and 11px labels, and
// shortens "WM pop"/"WM crit" to "Pop"/"Crit" so the Watchmode row still fits one line at the larger size.
test("CAS-900: collapsed-card score rows are 12px/11px type and the Watchmode row uses short labels", async ({ page }) => {
  await toShortlist(page, "cinema");
  await finishFlow(page);
  await toListing(page);

  const cards = page.locator("#groups .card");
  const card = cards.first();
  await expect(card).toBeVisible();
  const id = await card.evaluate(el => Number(el.id.replace("card-", "")));

  await page.evaluate((filmId) => {
    const m = MOVIES.find(x => x.tmdb_id === filmId);
    m.status = ["included_streaming"];
    m.imdb_rating = 8.3; m.imdb_votes = 1000000; m.metacritic = 89; m.rt_critic = null;
    m.wm_user_rating = 4.0; m.wm_popularity_percentile = 100; m.wm_critic_score = 40;
    fastPatchFindRow(filmId);
  }, id);

  const cardEl = page.locator(`#card-${id}`);
  await expect(cardEl).not.toHaveClass(/expanded/);

  const scoresRow = cardEl.locator(".mrow.r-scores");
  const wmRow = cardEl.locator(".mrow.r-wmscores");
  await expect(scoresRow).toBeVisible();
  await expect(wmRow).toBeVisible();

  // AC3: computed font-size on the collapsed card's score cells and labels.
  expect(await scoresRow.locator(".m").first().evaluate(el => getComputedStyle(el).fontSize)).toBe("12px");
  expect(await wmRow.locator(".m").first().evaluate(el => getComputedStyle(el).fontSize)).toBe("12px");
  expect(await scoresRow.locator(".lab").first().evaluate(el => getComputedStyle(el).fontSize)).toBe("11px");
  expect(await wmRow.locator(".lab").first().evaluate(el => getComputedStyle(el).fontSize)).toBe("11px");

  // AC4: the Watchmode row's labels are the shortened "Pop"/"Crit", not "WM pop"/"WM crit".
  const wmRowText = await wmRow.innerText();
  expect(wmRowText).toContain("Pop");
  expect(wmRowText).toContain("Crit");
  expect(wmRowText).not.toContain("WM pop");
  expect(wmRowText).not.toContain("WM crit");
});

// CAS-765 AC7: the silent guest-mode drop is gone. If the vendored client library ever fails to define
// window.supabase.createClient — forced here by serving a broken bundle in place of the real one — the
// failure must be visible on screen, not just a console.warn no user will ever read.
test("CAS-765 AC7: a forced client-construction failure shows a visible banner, not a silent guest-mode drop", async ({ page }) => {
  await page.route("**/config.js", route => route.fulfill({
    contentType: "application/javascript",
    body: `window.CASCADE_CONFIG = { SUPABASE_URL: "https://fake-project.supabase.test", SUPABASE_ANON_KEY: "fake-anon-key-not-a-real-secret" };`,
  }));
  await page.route("**/supabase-js.js", route => route.fulfill({
    contentType: "application/javascript",
    body: "/* CAS-765 test double: deliberately does not define window.supabase */",
  }));
  await gotoFresh(page);
  await page.waitForFunction(() => window.CascadeAuth && window.CascadeAuth.status === "guest");
  const banner = page.locator("#acctBanner");
  await expect(banner).toBeVisible();
  await expect(banner).not.toHaveText("");
});
