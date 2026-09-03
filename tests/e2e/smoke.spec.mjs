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

// Mirrors cas565.spec.mjs's addSecondAgent — a second agent made from the deck's "New Agent" card stops at
// the Briefing hub instead of walking the splash flow, so it needs its own "Save agent" exit.
async function addSecondAgent(page, kind){
  const newCard = page.locator(".dcard.new");
  await newCard.locator(".dc-name").click();
  await expect(newCard).toHaveClass(/is-centre/);
  await newCard.locator('button[data-act="new"]').click();
  await expect(page.locator(".priobtn").first()).toBeVisible();
  await page.locator(kind === "stream" ? ".priobtn.str" : ".priobtn.cin").click();
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

  // An upcoming film's Premium level can never already be spent (CAS-725's own WINDOW_RUNG says so), so
  // ticking one there is a reliable way to place a film at Premium without hunting for an eligible row.
  const card = page.locator('#groups .group[data-g="upcoming"] .card').first();
  await expect(card).toBeVisible();
  const cardId = await card.getAttribute("id");
  await card.locator(".ctl.notify").click();
  await page.locator('.nopt[data-wk="premium"]').click();
  await page.keyboard.press("Escape");

  await premiumTab.click();
  await expect(page.locator(`#${cardId}`)).toBeVisible();
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

  await settleListing(page);
  const groups = await sectionCounts(page);
  expect(groups.some(g => (g.window === "rental" || g.window === "included_streaming") && g.count > 0),
    `no rental/included_streaming group in ${JSON.stringify(groups)}`).toBe(true);
});

// CAS-729: the Mission screen — one score track carrying the Watch On windows as draggable markers, plus
// the REQUIREMENTS section. Reaches it the same way a real edit does: Agents screen -> Edit -> the Mission
// door on the Briefing hub, on the FIRST agent onboarding's own roster already created (no extra "new agent"
// detour needed for a screen that only reads/edits an existing one).
async function openFirstAgentMission(page){
  await page.locator("#agentsBtn").click();
  await expect(page.locator("#agentsScreen")).toHaveClass(/open/);
  await page.locator(".ag-edit").first().click();
  await expect(page.locator(".eacard.msn")).toBeVisible();
  await page.locator(".eacard.msn").click();
  await expect(page.locator(".osh", { hasText: "Mission" })).toBeVisible();
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
  await page.locator("#onbStep .osback").click();   // Mission -> the Briefing hub
  await page.locator("#onbStep .osback").click();   // hub -> closes, discarding this (unsaved) visit
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
  // 390-wide iPhone 13 viewport (playwright.config.js), so no extra sizing is needed here.
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);

  // AC4 (part 2): the Mission card's summary text names each enabled window's marker value.
  const marks = await page.evaluate(() => {
    const c = onbFlow.draft;
    return WATCH_LEVEL_KEYS.filter(k => windowUsable(c, k)).map(k => c.watchMarkers[k]);
  });
  expect(marks.length).toBeGreaterThan(0);
  const cardText = await page.locator("#onbStep .eacard.msn").innerText();
  for(const v of marks) expect(cardText, cardText).toContain(String(v));

  // AC4 (part 1): back out to the hub and confirm there is no Watch On door — two doors (Mission, Style)
  // only, the windows now live on the score track instead.
  await page.locator("#onbStep .osback").click();
  await expect(page.locator(".eacard")).toHaveCount(2);
  await expect(page.locator(".eacard", { hasText: "Watch On" })).toHaveCount(0);
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
  await toShortlist(page, "stream");
  await finishFlow(page);
  await toListing(page);
  const before = await settleListing(page);
  expect(before).toBeGreaterThan(0);

  await page.locator("#navMenuBtn").click();
  await page.locator("#navMenu .navitem", { hasText: "My services" }).click();
  await expect(page.locator(".osh", { hasText: "My services" })).toBeVisible();

  await page.locator("#onbSvcOnly").click();
  await expect(page.locator("#onbSvcOnly")).toHaveClass(/on/);
  await ctaLocator(page).click();   // Done, back to the listing
  await expect(page.locator("#onbStep")).not.toHaveClass(/open/);

  await addSecondAgent(page, "stream");
  const after = await settleListing(page);
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
// splash's own "Sign up" tap already opened it. The fake's own getSession() is deliberately delayed so the
// test can reproduce that exact ordering deterministically rather than racing a real clock.
const CAS740_FAKE_SUPABASE_MODULE = `
  const SEEDED_CASCADE = { id: "740aaaa1-0000-4000-8000-000000000001", user_id: "cas740-user",
    name: "Existing agent", criteria: {}, created_at: "2020-01-01T00:00:00.000Z" };
  function chain(){
    return new Proxy(() => {}, {
      get: (_t, prop) => prop === "then" ? (resolve) => resolve({ data: [], error: null }) : () => chain(),
      apply: () => chain(),
    });
  }
  export function createClient(){
    return {
      auth: {
        getSession: () => new Promise(resolve => setTimeout(() => resolve({ data: { session: {
          user: { id: "cas740-user", email: "cas740@example.com" }, access_token: "fake" } } }), 600)),
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
  }
`;

// CAS-745: the Agents-screen row's summary line dropped its genre restriction back in CAS-643 to stay
// short, which left no way to see that a Style restriction — not just budget/buzz/rating — was why a film
// was passed over. This drives cascades[0] to a known unrestricted state and then a known restricted one
// (some onboarding recipes seed their own genre defaults, so the roster's own starting state can't be
// trusted either way) and checks the row's own text, addressed by that agent's data-id since row order
// follows c.order, not roster array position. Also checks that — since the row is a fixed-width, 2-line-
// clamped card — restoring the line never forces the page wider (AC3).
test("agent card summary names its Style restriction when set, and omits it when there is none (CAS-745)", async ({ page }) => {
  await toShortlist(page, "cinema");
  await finishFlow(page);
  await toListing(page);

  await page.locator("#agentsBtn").click();
  await expect(page.locator("#agentsScreen")).toHaveClass(/open/);
  const targetId = await page.evaluate(() => cascades[0].id);
  const summary = page.locator(`.agrow[data-id="${targetId}"] .agsum`);
  await expect(summary).toBeVisible();

  await page.evaluate(() => { cascades[0].genre = []; renderAgentsScreen(); });
  await expect(summary).not.toContainText("styles");

  const restricted = await page.evaluate(() => {
    const genres = ALL_GENRES.slice(0, 7);
    cascades[0].genre = genres;
    renderAgentsScreen();
    return { count: genres.length, total: ALL_GENRES.length };
  });
  await expect(summary).toContainText(`${restricted.count} of ${restricted.total} styles`);

  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
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

  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
});

// CAS-750: order is a property of the Watch TAB now, not of an agent's retired `kind` — the Cinema tab
// (the default tab a fresh listing lands on) leads with Upcoming, reading the same journey order as CASCADE;
// every other tab is unchanged and still ends with Upcoming.
test("Watch Cinema tab leads with Upcoming; the Streaming tab does not (CAS-750)", async ({ page }) => {
  await toShortlist(page, "cinema");
  await finishFlow(page);
  await toListing(page);

  const cinemaFirst = await page.locator("#groups .group").first().getAttribute("data-g");
  expect(cinemaFirst).toBe("upcoming");

  await page.locator(".wtabbtn", { hasText: "Streaming" }).click();
  await settleListing(page);
  const streamFirst = await page.locator("#groups .group").first().getAttribute("data-g");
  expect(streamFirst).not.toBe("upcoming");
});

// CAS-750 AC3: the jump bar is built from the sections the DOM actually holds (renderJumpBar's own
// long-standing rule), so it has to keep tracking the groups' own order even after this ticket makes that
// order tab-dependent rather than fixed — checked on both tabs rather than assumed from the source.
test("Watch jump bar entries follow the groups' own order, on both the Cinema and Streaming tabs (CAS-750)", async ({ page }) => {
  await toShortlist(page, "cinema");
  await finishFlow(page);
  await toListing(page);

  const readOrder = async () => ({
    groupOrder: await page.locator("#groups .group").evaluateAll(gs => gs.map(g => g.dataset.g)),
    jumpOrder: await page.locator("#jumpBar .jchip").evaluateAll(chips => chips.map(c => c.dataset.jump)),
  });

  const cinema = await readOrder();
  expect(cinema.groupOrder.length).toBeGreaterThan(1);
  expect(cinema.jumpOrder).toEqual(cinema.groupOrder);

  await page.locator(".wtabbtn", { hasText: "Streaming" }).click();
  await settleListing(page);
  const stream = await readOrder();
  expect(stream.groupOrder.length).toBeGreaterThan(1);
  expect(stream.jumpOrder).toEqual(stream.groupOrder);
});

test("CAS-740 AC4: a signed-in user whose account already holds agents is never left in the onboarding flow", async ({ page }) => {
  await page.route("**/config.js", route => route.fulfill({
    contentType: "application/javascript",
    body: `window.CASCADE_CONFIG = { SUPABASE_URL: "https://fake-project.supabase.test", SUPABASE_ANON_KEY: "fake-anon-key-not-a-real-secret" };`,
  }));
  await page.route("https://esm.sh/@supabase/supabase-js@2", route => route.fulfill({
    contentType: "application/javascript",
    body: CAS740_FAKE_SUPABASE_MODULE,
  }));
  await gotoFresh(page);
  // The module has imported supabase-js and created its client — about to call the delayed getSession()
  // above, but hasn't yet. This is the instant to race against.
  await page.waitForFunction(() => window.CascadeAuth && window.CascadeAuth.client);

  await expect(page.locator("#splashCta")).toBeVisible();
  await page.locator("#splashCta").click();
  await expect(page.locator("#obWho")).toBeVisible();
  expect(await page.evaluate(() => flowOn)).toBe(true);   // genuinely inside the wizard before the race resolves

  // The delayed session restore now resolves to an account that already holds an agent.
  await page.waitForFunction(() => window.CascadeAuth.status === "signed-in", null, { timeout: 5000 });
  await expect(page.locator("#onbStep")).not.toHaveClass(/open/);
  const state = await page.evaluate(() => ({ flowOn, names: cascades.map(c => c.name) }));
  expect(state.flowOn, "the wizard must be exited once the account is known to already have agents").toBe(false);
  expect(state.names, "the account's own roster must be shown, not a second one built by the wizard")
    .toEqual(["Existing agent"]);
});
