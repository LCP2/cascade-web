// CAS-255: the defect classes Lee has been finding by hand, turned into assertions.
//
// invariants.test.mjs proves the engine's ARITHMETIC is coherent — a count equals its set, narrowing never
// widens. That was enough for the counting bugs of v0.8, and it is not enough for what came after: every
// defect in the v0.8.2 queue is a claim about a FILM rather than about a number. "Dr Doom has no budget so
// the scale dial dropped it." "Only show films on my services shows 111 films with no services picked."
// "This card says In Cinema and the data says rental." None of those move a count off its set, so none of
// them could fail an invariant.
//
// So these assertions run over the catalogue, film by film, through the same functions the listing calls.
// Same rule as the older file: nothing here pins a number, because main refreshes the catalogue daily. Where
// a defect class genuinely needs a threshold (a share of the catalogue missing a field), the threshold is a
// RATCHET with today's measurement written into the failure message, so it catches the data getting worse
// and never fails for standing still.
//
// Run: node --test tests/js/data-integrity.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { loadEngine, pickInLane } from "./engine.mjs";

const E = loadEngine();

const LANES = ["cinema", "stream"];
const CASES = LANES.flatMap(kind => E.startersFor(kind).map(s => ({ kind, s, label: `${kind}/${s.key}` })));
const ISO = /^\d{4}-\d{2}-\d{2}$/;
const SHOWABLE = E.MOVIES.filter(E.showable);

/** Every film any recipe in the app can put in front of a person, with the recipe that did it. */
function everyListing(){
  return CASES.map(c => {
    pickInLane(E, c.kind, c.s.key);
    const d = E.onbApply();
    return { ...c, d, listed: E.MOVIES.filter(m => E.listedBy(m, d)) };
  });
}

test("the harness is holding the real, built catalogue", () => {
  assert.ok(E.MOVIES.length > 500, `only ${E.MOVIES.length} films — index.html looks unbuilt`);
  assert.ok(SHOWABLE.length > 100, `only ${SHOWABLE.length} showable films`);
  assert.ok(ISO.test(E.TODAY), `TODAY is ${E.TODAY}, which is not a date`);
});

// ---- 1. EVERY LISTED FILM HAS A RESOLVED WINDOW ---------------------------------------------------------
// The listing groups by primaryStatus() and prints STATUS_LABEL for the group. A film whose window is empty,
// unknown or unlabelled therefore lands in a section with no name, or in none at all — the "still cannot see
// an In-cinema section" class of report. This asserts the window is resolved for every film, not just the
// ones today's recipes happen to reach.
test("status: every film resolves to one labelled window that it actually holds", () => {
  const order = new Map(E.CASCADE.map((w, i) => [w, i]));
  for(const m of E.MOVIES){
    const st = m.status || [];
    assert.ok(st.length > 0, `${m.title} holds no window at all`);
    for(const w of st) assert.ok(order.has(w), `${m.title} holds unknown window ${w}`);
    // Compared as a string, not with deepEqual: `m.status` is an array built inside the vm realm, so its
    // prototype is not the host's Array.prototype and a strict deep-equal of two identical arrays fails.
    const idx = st.map(w => order.get(w));
    assert.equal(idx.join(","), [...idx].sort((a, b) => a - b).join(","),
      `${m.title} holds its windows out of journey order (${st.join(",")}) — primaryStatus reads the last one`);
    const p = E.primaryStatus(m);
    assert.ok(st.includes(p), `${m.title} prints ${p}, which is not a window it holds`);
    assert.ok(E.STATUS_LABEL[p], `${m.title} prints ${p}, which has no label — its section would be nameless`);
  }
});

// The same claim from the listing's side: whatever a recipe puts on screen carries a window the recipe lists.
test("listing: every listed film carries a window the agent lists, with a label to print", () => {
  for(const { label, d, listed } of everyListing()){
    for(const m of listed){
      const p = E.primaryStatus(m);
      assert.ok(E.STATUS_LABEL[p], `${label}: lists ${m.title} under the unlabelled window ${p}`);
      assert.ok(d.status.includes(p), `${label}: lists ${m.title} from ${p}, a window the agent does not watch`);
    }
  }
});

// A preset on the pick-agent screen is an offer, and an offer that lists nothing is a dead end. One did —
// cinema/prestige, 0 films — which was the CAS-231 KNOWN GAP: an awards rung nobody could see, on a lane
// with no awards dial, emptying the agent. CAS-261 closed it by taking that preset out of the cinema lane
// altogether, so the ratchet comes down to zero. Every offer on both shortlists now lists something.
const EMPTY_OFFERS_TODAY = 0;
test("listing: no more offers go dark than the ones already known to be", () => {
  const empty = everyListing().filter(x => x.listed.length === 0).map(x => x.label);
  assert.ok(empty.length <= EMPTY_OFFERS_TODAY,
    `${empty.length} of the offered recipes list nothing (${empty.join(", ")}) — was ${EMPTY_OFFERS_TODAY}. ` +
    `See the CAS-231 KNOWN GAP beside MISSION_DIALS_USED.`);
});

// CAS-170 from the listing's side: an estimated title is a guess, and a listing is not the place for one —
// with the single exception CAS-237 opened, and it has to stay single. A film in a CINEMA window whose
// opening is still inside the run is the one estimate backed by something checkable (its own date, and the
// fact that cinemas publish no offers for anyone to check against). Every other estimated window is a claim
// about a service we cannot name, and those stay out.
test("listing: an estimate only reaches the screen from a cinema run", () => {
  for(const { label, listed } of everyListing()){
    for(const m of listed){
      assert.ok(E.showable(m), `${label}: lists ${m.title}, which nothing backs`);
      if(!E.isEstimated(m)) continue;
      assert.ok(E.inCinemaWindow(m),
        `${label}: lists ${m.title} from ${E.primaryStatus(m)} on an estimate — only a cinema run may be estimated`);
      assert.ok(E.inCinemaRun(m),
        `${label}: lists ${m.title} as in a cinema on an estimate, but it opened ${m.cinema_date}`);
      assert.equal((m.offers || []).length, 0,
        `${label}: ${m.title} is estimated into a cinema while holding digital offers that could have been read`);
    }
  }
});

// CAS-481: "DE4TH DRIVE" — cinema_release: false, cinema_date over a year past, no offers ever found in AU —
// stayed stuck at claimedStatus ["upcoming"] with availability_confidence "estimated" (derive_from_providers'
// offer-less fallback for a title past its run has nowhere else honest to put it). Nothing in the pipeline
// invented this shape from nothing: it is a title the pipeline never confirmed AND is not still ahead of us,
// so it is not a real anticipation — the exact thing the invariant above already refuses for every OTHER
// estimated window. This is the regression test for the gate that closes the gap: listWindowOK must not let
// an estimated "upcoming" claim into any agent's listing, cinema or streaming.
test("listing: a stuck-upcoming, estimated title with no cinema run never reaches a listing (CAS-481)", () => {
  const stuck = {
    title: "CAS-481 Test Film", cinema_date: daysAgo(400), cinema_release: false,
    claimedStatus: ["upcoming"], availability_confidence: "estimated", offers: [],
  };
  stuck.status = E.deriveStatus(stuck);
  assert.equal(E.primaryStatus(stuck), "upcoming", "setup: the pipeline's own claim for this shape is upcoming");
  assert.ok(E.isEstimated(stuck), "setup: this shape is only ever estimated");
  for(const kind of ["cinema", "stream"]){
    pickInLane(E, kind, kind === "cinema" ? "cinema" : "custom");
    const d = E.onbApply();
    assert.equal(E.listWindowOK(stuck, d), false,
      `${kind}: an estimated, stuck-upcoming title with no confirmed cinema run must not satisfy an agent's Upcoming window`);
  }
});

// ---- 1b. THE IN-CINEMA SECTION ACTUALLY POPULATES (CAS-237) ---------------------------------------------
// The bug: a cinema agent listed 33 films of which 2 were not Upcoming, because the catalogue held no film
// in a cinema at all — the window estimator had learned a 1-day cinema-to-streaming offset from an
// observation log and filed 1,614 of 1,961 titles onto streaming. These are the assertions that would have
// caught it, and neither of them pins a number: the first says the window exists, the second says nothing
// silently falls out of it between the catalogue and the screen.
test("in cinema: the catalogue holds films that are on a screen right now", () => {
  const onScreen = E.MOVIES.filter(m => E.showable(m) && E.inCinemaWindow(m));
  assert.ok(onScreen.length > 0,
    "not one film in the whole catalogue is in a cinema window — the window estimator has collapsed (CAS-237)");
  for(const m of onScreen) assert.ok(E.inCinemaRun(m),
    `${m.title} is filed In Cinema on an opening date of ${m.cinema_date}, outside the run`);
});

// CAS-476: two real, currently-showing wide releases (Toy Story 5, 55 days into its run; The Odyssey, 27
// days in) were being deleted from every listing. Past CAS-289's old two-week cap, deriveStatus's CAS-318
// correction filed a still-in-cinema estimate onto "pvod" with zero offers, and showable()'s
// hasConfirmedOffer requires a real, priced offer before anything estimated may show there — so the film was
// not moved to a visible next window, it was made permanently unshowable. This proves an estimated,
// offer-less in-cinema film now survives for a realistic run, not just fourteen days.
function daysAgo(n){
  const d = new Date(`${E.TODAY}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}
test("in cinema: an estimated wide release with no offers stays showable for a realistic run (CAS-476)", () => {
  const wideRelease = cinemaDate => ({
    title: "CAS-476 Test Film", cinema_date: cinemaDate,
    claimedStatus: ["in_cinema"], availability_confidence: "estimated", offers: [],
  });
  for(const days of [27, 55, 74]){
    const m = wideRelease(daysAgo(days));
    m.status = E.deriveStatus(m);
    assert.ok(E.showable(m), `a film ${days} days into its cinema run with no offers must stay showable`);
    assert.equal(E.primaryStatus(m), "in_cinema",
      `a film ${days} days into its cinema run was moved off in_cinema to ${E.primaryStatus(m)}`);
  }
  // Well past a realistic run the film still moves on — CAS-318's own "next window" behaviour, deliberately
  // left in force; this run-length raise is not licence to trust an estimate forever.
  const stale = wideRelease(daysAgo(120));
  stale.status = E.deriveStatus(stale);
  assert.equal(E.primaryStatus(stale), "pvod",
    "a film 120 days past its cinema opening with no offers should still have moved off in_cinema");
});

test("in cinema: a wide-open cinema agent loses none of them, and is not a wall of Upcoming", () => {
  pickInLane(E, "cinema", "custom");
  const d = E.onbApply();
  const eligible = E.MOVIES.filter(m => E.showable(m) && E.inCinemaWindow(m) && E.matchesTaste(m, d));
  const listed = E.MOVIES.filter(m => E.listedBy(m, d));
  const onScreen = listed.filter(m => E.inCinemaWindow(m));
  assert.equal(onScreen.length, eligible.length,
    `the widest cinema recipe lists ${onScreen.length} of the ${eligible.length} films it should have on screen`);
  assert.ok(onScreen.length > 0, "the widest cinema recipe lists nothing that is on a screen (CAS-237)");
  // "Not a wall of Upcoming" as the loosest assertion that still means it. Today the widest cinema recipe
  // is 40% Upcoming; the bug was 100%. The ceiling catches the collapse coming back, not ordinary drift.
  // CAS-314: the guard is about a POPULATED in-cinema section collapsing, not about an honestly-empty one.
  // "Confirmed" has to mean the PIPELINE POLL itself put the film in a cinema window — m.claimedStatus, read
  // before deriveStatus() ever touches it — not m.status/primaryStatus. CAS-227's date-correction promotes an
  // unestimated title with no offers into in_cinema/opening_week purely from its own opening date once it has
  // sat unpolled for a while, which is the same kind of calendar-only inference CAS-289 caps for estimated
  // titles; it is not evidence a provider actually confirmed the film is on a screen. Today every onScreen
  // title with m.availability_confidence !== "estimated" got there via that correction (claimedStatus is
  // still ["upcoming"]) — there is no title left that the pipeline itself ever claimed into a cinema window,
  // so the in-cinema section is honestly empty of real confirmation, and is allowed to skew Upcoming.
  const rawConfirmedOnScreen = onScreen.filter(m =>
    !E.isEstimated(m) && (m.claimedStatus || []).some(w => ["opening_week", "in_cinema"].includes(w))).length;
  if(rawConfirmedOnScreen === 0){
    return;
  }
  const upcoming = listed.filter(m => E.isUpcoming(m)).length;
  const share = 100 * upcoming / Math.max(1, listed.length);
  assert.ok(share <= 90,
    `the widest cinema recipe is ${share.toFixed(0)}% Upcoming (${upcoming} of ${listed.length}) — a wall, not a listing`);
});

// The listing leads with what you can watch, and keeps Upcoming as the tail. Asserted on the shipped order
// rather than on the rendering, because the reveal and the listing must walk the same sequence (CAS-176).
test("the listing leads with what is out and ends with what is not — on the STREAMING lane", () => {
  // CAS-295 split this rule by lane. On streaming it is unchanged and still load-bearing: an unreleased film
  // is the least actionable thing on the page, so it belongs at the tail.
  assert.equal(E.LISTING_ORDER[E.LISTING_ORDER.length - 1], "upcoming",
    `the listing leads with ${E.LISTING_ORDER[0]} and would put unreleased films above watchable ones`);
  assert.deepEqual([...E.LISTING_ORDER].sort(), [...E.CASCADE].sort(),
    "the listing order and the journey order are not the same six windows");
  pickInLane(E, "stream", "custom");
  const d = E.onbApply();
  const seq = E.listingOrder(E.MOVIES.filter(m => E.listedBy(m, d)), d.sort || "availability", d);
  const firstUpcoming = seq.findIndex(m => E.isUpcoming(m));
  const lastReleased = seq.map(m => !E.isUpcoming(m)).lastIndexOf(true);
  if(firstUpcoming >= 0 && lastReleased >= 0) assert.ok(firstUpcoming > lastReleased,
    `an Upcoming film sits at ${firstUpcoming}, above a released one at ${lastReleased}`);
});

// CAS-394: reverses CAS-295. The cinema lane now leads with what is out (same shape as the streaming lane
// above) and ends with Upcoming, but the in-section timeline runs the other way: oldest cinema date first,
// so a released film sits above one that opened more recently, and Upcoming's soonest release leads its
// furthest-out one. This applies to the cinema lane only.
test("in cinema: the cinema lane leads with what is out, ends with Upcoming, oldest cinema date first", () => {
  // Spread into a LOCAL array first: the engine runs in a vm realm, so its Array has a different prototype
  // and deepStrictEqual compares that too. Every other array assertion in this file does the same.
  assert.equal(E.CINEMA_LISTING_ORDER[E.CINEMA_LISTING_ORDER.length - 1], "upcoming",
    `the cinema lane ends with ${E.CINEMA_LISTING_ORDER[E.CINEMA_LISTING_ORDER.length - 1]}, not upcoming`);
  assert.deepEqual([...E.CINEMA_LISTING_ORDER].sort(), [...E.CASCADE].sort(),
    "the cinema order and the journey order are not the same six windows");
  pickInLane(E, "cinema", "custom");
  const d = E.onbApply();
  assert.equal(E.orderFor(d), E.CINEMA_LISTING_ORDER, "a cinema agent is not using the cinema order");
  const seq = E.listingOrder(E.MOVIES.filter(m => E.listedBy(m, d)), d.sort || "availability", d);
  const lastReleased = seq.map(m => !E.isUpcoming(m)).lastIndexOf(true);
  const firstUpcoming = seq.findIndex(m => E.isUpcoming(m));
  if(lastReleased >= 0 && firstUpcoming >= 0) assert.ok(lastReleased < firstUpcoming,
    `an Upcoming film sits at ${firstUpcoming}, above a released one at ${lastReleased}`);
  // …and within any one section, the oldest cinema date leads — the opposite direction from the streaming
  // lane's timeline.
  const dated = seq.filter(m => m.cinema_date);
  for(let i = 1; i < dated.length; i++){
    if(E.primaryStatus(dated[i]) !== E.primaryStatus(dated[i - 1])) continue;   // only within one section
    assert.ok(dated[i].cinema_date >= dated[i - 1].cinema_date,
      `${dated[i - 1].title} (${dated[i - 1].cinema_date}) sits above ${dated[i].title} (${dated[i].cinema_date}) — the cinema lane should read oldest first`);
  }
  // …and a streaming agent is untouched by it.
  pickInLane(E, "stream", "custom");
  assert.equal(E.orderFor(E.onbApply()), E.LISTING_ORDER, "the streaming lane picked up the cinema order");
});

// ---- 2. THE DATES THE CARD SHOWS ------------------------------------------------------------------------
// stageDate() is what the card prints under each availability lozenge, and it answers in one of two voices:
// a real observation (est:false) or an offset off the opening date (est:true). Both have to be well formed,
// and the real ones have to be dates the film could actually have reached — nothing at home before it opened.
test("dates: every stage date is a real date, and a real one never precedes the opening", () => {
  const STAGES = ["cinema", "pvod", "rental", "included_streaming"];
  for(const m of SHOWABLE){
    for(const key of STAGES){
      const got = E.stageDate(m, key);
      if(got == null) continue;
      assert.ok(ISO.test(got.d), `${m.title}: ${key} date is ${got.d}`);
      assert.equal(typeof got.est, "boolean", `${m.title}: ${key} date does not say whether it is an estimate`);
      // An estimate is only ever the opening date plus a fixed offset, so it cannot exist without an opening
      // date — and if it did, it would be an invented date, which the honesty guardrail forbids outright.
      if(got.est) assert.ok(m.cinema_date, `${m.title}: ${key} shows an estimated date with nothing to estimate from`);
      if(!got.est && key !== "cinema" && m.cinema_date){
        assert.ok(got.d >= m.cinema_date,
          `${m.title}: observed at ${key} on ${got.d}, before it opened on ${m.cinema_date}`);
      }
    }
  }
});

// A film the app has put on a screen has to have a screening date behind it — that date is the only evidence
// the window rests on, and CAS-155 is what happens when a window is asserted without one.
test("dates: a film in a cinema window has an opening date, and knows which side of it we are on", () => {
  for(const m of SHOWABLE){
    if(!E.inCinemaWindow(m)) continue;
    assert.ok(ISO.test(m.cinema_date || ""), `${m.title} is in a cinema window dated ${m.cinema_date}`);
    const state = E.cinemaState(m);
    assert.ok(["upcoming", "opening", "cinema"].includes(state.key),
      `${m.title} is in an unknown cinema state ${state.key}`);
  }
  // …and the mirror: an unreleased film is never described as already showing.
  for(const m of E.MOVIES){
    if(!E.isUpcoming(m)) continue;
    assert.equal(E.inCinemaWindow(m), false, `${m.title} is Upcoming and in a cinema window at once`);
  }
});

// ---- 3. THE SCALE DIAL LEANS AT EVERY RUNG (CAS-238) ----------------------------------------------------
// invariants.test.mjs checks the top rung. The defect Lee reported is about a specific film at a specific
// setting, so the assertion has to hold at EVERY setting the dial can be left on: a film whose scale we do
// not hold must survive all of them, or the dial is a filter on our own data gaps rather than on films.
test("scale: no rung of the dial drops a film for having no money figure on it", () => {
  const unknown = E.MOVIES.filter(m => !(m.budget > 0) && !(m.worldwide_gross > 0));
  assert.ok(unknown.length > 0, "every film carries a money figure — this test would prove nothing");
  for(const { d } of E.SCALE_REF.map(r => ({ d: r.d }))){
    for(const m of unknown){
      assert.notEqual(E.selScaleMatch(m, { selScale: d }), false,
        `${m.title} has neither budget nor gross and was cut at the $${Math.round(d / 1e6)}M rung`);
    }
  }
});

// The same film, through the whole recipe rather than the one dial. CAS-661 made the Mission dials OR
// routes, and CAS-674 fixed the Budget route's leak: under OR it now takes an AFFIRMATIVE selScaleMatch to
// clear, so a money-unknown film that qualified ONLY by riding the old `!==false` leak legitimately falls
// out once scale is the sole route that admits it and is leaned all the way up. The "never removes"
// guarantee still holds when another OR route independently admits the SAME film — mirrors matchesCriteria's
// own OR clauses (minus scale) rather than just checking whether the agent has another dial set, because
// CAS-663 zeroes out selCrowd/selCritScore/selAwards for a pre-release film specifically — an agent carrying
// a People's-vote/Critics dial does not mean an upcoming film in `blind` is actually admitted by it. CAS-678
// moves Buzz out of that pre-release exclusion: its ladder is defined ONLY over upcoming-and-in-cinema films,
// so selBuzzOK is evaluated unconditionally here too, exactly as matchesCriteria now does.
const isPreReleaseM = m => ["upcoming", "in_cinema"].includes(E.primaryStatus(m));
test("scale: raising the lean only drops a money-unknown film when scale is its sole qualifying Mission route (CAS-674)", () => {
  for(const { kind, s, label } of CASES){
    pickInLane(E, kind, s.key);
    const base = E.onbApply();
    const otherRouteAdmits = m => {
      const preRel = isPreReleaseM(m);
      return (!preRel && base.selCrowd && E.selCrowdOK(m, base))
        || (!preRel && (base.selCritScore || base.selAwards) && E.selCriticsOK(m, base))
        || (base.selBuzz && E.selBuzzOK(m, base))
        || (base.cinemaReleaseOnly && !!m.cinema_release);
    };
    const open = E.MOVIES.filter(m => E.watchesFilm(m, E.normCascade({ ...base, selScale: 0 })));
    const blind = open.filter(m => !(m.budget > 0) && !(m.worldwide_gross > 0));
    if(!blind.length) continue;
    const top = E.SCALE_REF[E.SCALE_REF.length - 1].d;
    const leaned = new Set(E.MOVIES.filter(m => E.watchesFilm(m, E.normCascade({ ...base, selScale: top }))));
    for(const m of blind){
      if(otherRouteAdmits(m)){
        assert.ok(leaned.has(m),
          `${label}: ${m.title} fell out at the top scale rung despite another OR route that should still admit it`);
      } else {
        assert.ok(!leaned.has(m),
          `${label}: ${m.title} (no money figure, scale the only route admitting it) stayed listed at the top scale rung — the Budget OR route should require an affirmative match (CAS-674)`);
      }
    }
  }
});

// ---- 3b. AN INFERRED SCALE AFFIRMS, AND NEVER DENIES (CAS-238) ------------------------------------------
// The complaint was that a tentpole with no budget yet — Avengers: Doomsday carries none — reads as the
// smallest thing in the catalogue. The inference has to do two jobs without doing a third: place the film
// under a high lean, say so on its card, and never once become a reason to drop something.
test("inferred scale: an anticipated film with no budget is placed, not left blank", () => {
  const inferred = E.MOVIES.filter(m => E.inferredScale(m));
  assert.ok(inferred.length > 0, "not one film has an inferred scale — the inference is dead");
  for(const m of inferred){
    const inf = E.inferredScale(m);
    // Always a named stop on the track. A band is the claim; a figure would be the fake precision the
    // honesty guardrail forbids.
    assert.ok(E.SCALE_REF.some(r => r.d === inf.d && r.label === inf.label),
      `${m.title} was inferred to ${inf.label} $${inf.d}, which is not a stop on the scale track`);
    assert.equal(E.selScaleMatch(m, { selScale: inf.d }), true,
      `${m.title} is inferred ${inf.label} and does not clear its own band`);
    // …and the inference is a LOWER bound, so a floor beyond it is unknown, never denied.
    assert.equal(E.selScaleMatch(m, { selScale: inf.d * 10 }), null,
      `${m.title} was DENIED by a floor its inference simply does not reach`);
  }
});

test("inferred scale: only anticipation is ever read as scale, and only before release", () => {
  for(const m of E.MOVIES){
    if(!E.inferredScale(m)) continue;
    // CAS-169's decision, kept: popularity spikes on availability, so a released film with no money figure
    // has no scale evidence and must not borrow one.
    assert.ok(E.isUpcoming(m), `${m.title} is released and was still handed an inferred scale`);
    assert.ok(!(m.budget > 0) && !(m.worldwide_gross > 0),
      `${m.title} has real money on it and was inferred anyway — the figure must win`);
  }
});

test("inferred scale: the card says a band and never a dollar figure", () => {
  const inferred = E.MOVIES.filter(m => E.inferredScale(m));
  for(const m of inferred.slice(0, 20)){
    const cell = E.budgetCell(m);
    const why = E.inferScaleWhy(m);
    assert.ok(cell.includes("≈"), `${m.title}: the budget cell does not mark itself as an estimate`);
    assert.ok(cell.includes(E.inferredScale(m).label), `${m.title}: the budget cell names no band`);
    assert.ok(!/\$\s*[\d.]/.test(cell), `${m.title}: the budget cell prints a dollar figure it does not hold`);
    assert.ok(!/\$\s*[\d.]/.test(why), `${m.title}: the explanation prints a dollar figure it does not hold`);
    assert.ok(why.length > 40, `${m.title}: the explanation says nothing about where the band came from`);
  }
  // A film whose budget IS known prints the figure, unchanged.
  const known = E.MOVIES.find(m => m.budget > 0);
  assert.ok(!E.budgetCell(known).includes("≈"), `${known.title} has a real budget and is being hedged`);
});

// ---- 3c. A BELL ONLY PROMISES WHAT THE MONITOR CAN FIRE (CAS-242) ---------------------------------------
// Two new Upcoming moments landed with this ticket, and the property that has to hold for all seven is the
// one CAS-103 established: an alert key is a promise, so it must map to a moment the daily job computes, be
// reachable for the agent's own scope, and be settable from the screen that claims to set it.
test("alerts: every alert key has a name, a moment and a place in the defaults", () => {
  for(const k of Object.keys(E.ALERT_DEFAULTS)){
    assert.ok(E.ALERT_SHORT[k], `alert ${k} has no short name — the summary line would print undefined`);
    assert.ok(E.ALERT_MOMENT[k], `alert ${k} has no moment phrase — the agent's promise would be unsayable`);
  }
  for(const k of Object.keys(E.ALERT_SHORT)) assert.ok(k in E.ALERT_DEFAULTS,
    `alert ${k} is named but has no default — normCascade would never fill it in`);
});

test("alerts: an Upcoming moment is only reachable for an agent that watches Upcoming", () => {
  const cinema = E.normCascade({ status: ["upcoming", "opening_week", "in_cinema"] });
  const later  = E.normCascade({ status: ["rental", "included_streaming"] });
  for(const k of ["announced", "opens_soon"]){
    assert.ok(E.reachableRows(cinema).has(k), `${k} is unreachable for an agent watching Upcoming`);
    assert.ok(!E.reachableRows(later).has(k),
      `${k} is offered to a streaming agent, which has never met the film before it opens`);
  }
});

test("alerts: a sub-moment writes an alert only when its own bell is on", () => {
  const win = E.agentWindow("upcoming", "cinema");
  assert.ok(win && win.subs && win.subs.length === 2, "the Upcoming window lost its finer moments");
  for(const s of win.subs){
    assert.ok(s.alerts && Object.keys(s.alerts).length === 1, `${s.key} arms no alert`);
    const key = Object.keys(s.alerts)[0];
    assert.ok(key in E.ALERT_DEFAULTS, `${s.key} arms ${key}, which is not an alert the app knows`);
    assert.equal(E.ALERT_DEFAULTS[key], false,
      `${key} defaults ON — an agent built in the editor would start emailing about it unasked`);
    assert.ok(s.sub && s.sub.length > 20, `${s.key} does not say what it actually fires on`);
  }
  // CAS-427: a new cinema agent Lists Upcoming but does not alert on it — no Notify option is ticked by
  // default, sub-moments included, until the person turns the bell on for themselves.
  const seed = E.PRIORITY_WATCH.cinema.upcoming;
  assert.ok(seed.list, "a new cinema agent does not list Upcoming");
  assert.ok(!seed.notify, "a new cinema agent starts with the Upcoming bell on, against CAS-427's default-off rule");
  assert.ok(!seed.subs, "a new cinema agent starts with pre-armed sub-moments, against CAS-427's default-off rule");
});

test("alerts: a saved agent from before this screen is never armed on its behalf", () => {
  // migrateWatch is the only door an old agent comes through, and it must not invent a sub-moment: the
  // person asked for one bell and would start receiving three.
  const old = E.migrateWatch({ upcoming: { list: true, notify: true } });
  assert.deepEqual(Object.keys(old.upcoming).sort().join(","), "list,notify",
    `an agent saved before CAS-242 came back carrying ${JSON.stringify(old.upcoming)}`);
  // …and one saved since round-trips exactly.
  const now = E.migrateWatch({ upcoming: { list: true, notify: true, subs: { announced: true, opens_soon: false } } });
  assert.equal(now.upcoming.subs.announced, true);
  assert.equal(now.upcoming.subs.opens_soon, false);
});

// ---- 3d. THE PAY-PER-FILM WINDOWS ARE TWO, NOT ONE (CAS-243) --------------------------------------------
test("windows: a streaming agent is offered Premium, Standard Rent and Streaming, one status each", () => {
  // Joined rather than deep-equalled: these arrays are built inside the vm realm, so their prototype is not
  // the host's and a strict deep-equal of two identical arrays fails (the same trap as the status order).
  const wins = E.AGENT_WINDOWS.stream;
  assert.equal(wins.map(w => w.key).join(","), "premium,rent,stream");
  assert.equal(wins.map(w => w.label).join(","), "Premium,Standard Rent,Streaming");
  // Each window owns its own status and its own bell — the split is only real if nothing overlaps.
  const seen = new Set();
  for(const w of wins){
    assert.equal(w.status.length, 1, `${w.key} covers ${w.status.length} windows`);
    for(const st of w.status){
      assert.ok(!seen.has(st), `${st} is claimed by two windows — a film would be listed twice`);
      seen.add(st);
    }
    const keys = Object.keys(w.alerts || {});
    assert.equal(keys.length, 1, `${w.key} arms ${keys.length} alerts`);
    assert.ok(keys[0] in E.ALERT_DEFAULTS, `${w.key} arms ${keys[0]}, which is not an alert the app knows`);
  }
  assert.equal([...seen].sort().join(","), "included_streaming,pvod,rental");
});

test("windows: a new streaming agent takes rent and streaming, and is never opted into $30", () => {
  const seed = E.PRIORITY_WATCH.stream;
  assert.ok(seed.rent && seed.rent.list, "Standard Rent is not listed for a new agent");
  assert.ok(seed.stream && seed.stream.list, "Streaming is not listed for a new agent");
  // CAS-427: List is still automatic; Notify is not — nothing is ticked until the person taps it themselves.
  assert.ok(!seed.rent.notify, "Standard Rent's bell is on by default, against CAS-427's default-off rule");
  assert.ok(!seed.stream.notify, "Streaming's bell is on by default, against CAS-427's default-off rule");
  assert.ok(!seed.premium, "a new streaming agent is opted into Premium, which costs ~$30 a film");
  // …and the window is still OFFERED, or it could never be switched on.
  assert.ok(E.agentWindow("premium", "stream"), "Premium is not on the screen at all");
});

test("windows: an agent that asked for premium under the old model gets the premium window", () => {
  // `purchase` was the premium option and had nowhere of its own to land, so it was folded into rent.
  assert.equal(JSON.stringify(E.migrateWatch({ rent: ["purchase"] })),
    JSON.stringify({ premium: { list: true, notify: true } }));
  assert.equal(JSON.stringify(E.migrateWatch({ rent: ["rent"] })),
    JSON.stringify({ rent: { list: true, notify: true } }));
  // A bare lane tick meant the whole pay-per-film lane, so it opens both.
  assert.equal(Object.keys(E.migrateWatch({ rent: [] })).sort().join(","), "premium,rent");
});

// ---- 3e. CRITICS AND AWARDS ARE TWO QUESTIONS (CAS-249) -------------------------------------------------
// The score is continuous now and the awards rungs count nominations. The property that had to be designed
// for, rather than discovered: the rungs must NEST, or pushing the dial right would widen the set. On this
// catalogue 3+ nominations catches 24 films and Winner catches 36, so a naive ladder with Winner on top
// would take the count UP on its last step — a dial that widens as you get pickier is the exact class of
// defect this release is about.
test("critics: the awards rungs nest, so pushing the dial right can only narrow", () => {
  const base = { selCritScore: 0, selAwards: 0 };
  const sets = E.AWARD_STOPS.map((_, i) =>
    new Set(E.MOVIES.filter(m => E.selCriticsOK(m, { ...base, selAwards: i }))));
  for(let i = 1; i < sets.length; i++){
    for(const m of sets[i]) assert.ok(sets[i - 1].has(m),
      `${m.title} clears ${E.AWARD_STOPS[i].label} but not ${E.AWARD_STOPS[i - 1].label} — the rungs do not nest`);
    assert.ok(sets[i].size <= sets[i - 1].size,
      `${E.AWARD_STOPS[i].label} catches ${sets[i].size}, more than ${E.AWARD_STOPS[i - 1].label}'s ${sets[i - 1].size}`);
  }
  assert.ok(sets[sets.length - 1].size > 0, "no film in the catalogue clears the top awards rung");
  // …and the reason it nests: a winner outranks every nomination count.
  const winner = E.MOVIES.find(m => m.award === "won");
  assert.ok(winner, "no winners in the catalogue — this test would prove nothing");
  for(let i = 1; i < E.AWARD_STOPS.length; i++)
    assert.equal(E.selCriticsOK(winner, { ...base, selAwards: i }), true,
      `a winner fails the ${E.AWARD_STOPS[i].label} rung`);
});

test("critics: the awards ladder is read off the film's own award line, never invented", () => {
  for(const m of E.MOVIES){
    const r = E.awardRank(m);
    if(!m.award){ assert.equal(r, 0, `${m.title} has no award and was ranked ${r}`); continue; }
    assert.ok(r >= 1, `${m.title} carries an award and ranked ${r}`);
    const a = E.parseAwards(m.award_text) || {};
    const named = Math.max(a.oscN || 0, a.oscW || 0);
    // A nomination we cannot count still counts as one — the rung says "nomination", not "Oscar nomination".
    assert.ok((r % 1000) >= Math.max(named, 1),
      `${m.title}: ranked ${r} against an award line reading "${m.award_text}"`);
  }
});

test("critics: the score floor is continuous and only judges a film that has a score", () => {
  // Continuous means every value in between is a real, different filter — not four disguised presets.
  const counts = [50, 55, 60, 65, 70, 75, 80].map(v =>
    E.MOVIES.filter(m => E.selCriticsOK(m, { selCritScore: v, selAwards: 0 })).length);
  for(let i = 1; i < counts.length; i++) assert.ok(counts[i] <= counts[i - 1],
    `the score floor widened between rungs: ${counts.join(" → ")}`);
  assert.ok(new Set(counts).size > E.CRIT_MARKS.length,
    `only ${new Set(counts).size} distinct answers across seven settings — the slider is still stepped`);
  // A film with no critic score is judged by the score dial like any other bar that reads a score: it has
  // none, so it does not clear one. (The named marks are still exactly reachable.)
  for(const r of E.CRIT_MARKS) assert.ok(typeof r.v === "number" && r.v >= 0 && r.v <= 100,
    `${r.label} sits at ${r.v}, off the 0-100 score track`);
});

// CAS-261: read in the streaming lane, which is the lane that still HAS a Critics & awards dial. Since
// CAS-261 a cinema agent carries no critics criterion at all, so migrating one there and then dropping it is
// the correct outcome rather than a migration failure — that half is asserted by its own test below.
test("critics: an agent saved under the old single ladder still means what it meant", () => {
  const cases = [[0, 0, 0], [1, 60, 0], [2, 80, 0], [3, 0, 1], [4, 0, 4]];
  for(const [legacy, score, awards] of cases){
    const c = E.normCascade({ selCritics: legacy, kind: "stream" });
    assert.equal(c.selCritScore, score, `selCritics ${legacy} migrated to a ${c.selCritScore} score floor`);
    assert.equal(c.selAwards, awards, `selCritics ${legacy} migrated to awards rung ${c.selAwards}`);
  }
  // An agent saved SINCE the split is left alone — the migration must not overwrite a real answer.
  const fresh = E.normCascade({ selCritics: 4, selCritScore: 70, selAwards: 0, kind: "stream" });
  assert.equal(fresh.selCritScore, 70);
  assert.equal(fresh.selAwards, 0);
});

// CAS-261: a lane carries only the dials it uses — and that has to hold for an agent SAVED before the rule,
// not just one built after it. Otherwise a cinema agent goes on filtering on a floor its Mission screen does
// not show and its auto-relax cannot loosen, which is the hidden filter the whole rule exists to remove.
test("lanes: an agent carries only the criteria its own lane can show", () => {
  const cinema = E.normCascade({ kind: "cinema", selCrowd: 7.5, selCritScore: 80, selAwards: 3,
                                 selScale: 56e6, selBuzz: 1 });
  assert.equal(cinema.selCrowd, 0, "a cinema agent kept a People's-vote floor");
  assert.equal(cinema.selCritScore, 0, "a cinema agent kept a critics-score floor");
  assert.equal(cinema.selAwards, 0, "a cinema agent kept an awards rung");
  assert.equal(cinema.selScale, 56e6, "a cinema agent lost Scale, which it does use");
  assert.equal(cinema.selBuzz, 1, "a cinema agent lost Buzz, which it does use");

  const stream = E.normCascade({ kind: "stream", selCrowd: 7.5, selCritScore: 80, selAwards: 3,
                                 selScale: 56e6, selBuzz: 1 });
  assert.equal(stream.selCrowd, 7.5, "a streaming agent lost its People's-vote floor");
  assert.equal(stream.selCritScore, 80, "a streaming agent lost its critics-score floor");
  assert.equal(stream.selAwards, 3, "a streaming agent lost its awards rung");
  assert.equal(stream.selBuzz, 0, "a streaming agent kept Buzz, which it does not use");

  // The rule and the dial sets are one definition, not two that can drift.
  for(const kind of ["cinema", "stream"]){
    const carried = { vote: "selCrowd", crit: "selCritScore", scale: "selScale", buzz: "selBuzz" };
    const on = E.normCascade({ kind, selCrowd: 7.5, selCritScore: 80, selScale: 56e6, selBuzz: 1 });
    for(const [dial, field] of Object.entries(carried)){
      const used = E.MISSION_DIALS_USED[kind].includes(dial);
      assert.equal(on[field] > 0, used, `${kind}: ${field} is ${on[field]} but ${dial} used=${used}`);
    }
  }
});

// CAS-261: no preset may be OFFERED in a lane that cannot apply the standard the card names.
test("presets: every offer's standard survives its own lane", () => {
  for(const kind of ["cinema", "stream"]){
    for(const s of E.STARTERS.filter(x => (x.kinds || ["cinema", "stream"]).includes(kind))){
      const before = { ...s.crit };
      const after = E.laneCrit({ ...s.crit }, kind);
      const dropped = ["selCrowd", "selCritScore", "selAwards", "selBuzz"]
        .filter(f => (before[f] || 0) > 0 && !(after[f] || 0));
      const left = ["selCrowd", "selCritScore", "selAwards", "selScale", "selBuzz"]
        .some(f => (after[f] || 0) > 0);
      assert.ok(dropped.length === 0 || left,
        `${kind}/${s.key} is offered but its lane drops ${dropped.join(", ")}, leaving it with no standard`);
    }
  }
});

// ---- 3f. HOW FAR BACK IS A ROLLING WINDOW ON A LOG TRACK (CAS-250) --------------------------------------
test("how far back: the window rolls from today, and the tightest rung is twelve months", () => {
  const cut = E.yearsCutoff(1);
  assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(cut), `a one-year cutoff of ${cut}`);
  // The correction the ticket is about: this is TODAY minus a year, not the first of January. The old
  // "This year" rung admitted five days of releases on 5 January and meant something different every month.
  assert.equal(cut.slice(5), E.TODAY.slice(5), `${cut} is not the same day of the year as ${E.TODAY}`);
  assert.equal(+cut.slice(0, 4), +E.TODAY.slice(0, 4) - 1);
  assert.equal(E.yearsCutoff(0), null, "Any must rule nothing out");
  for(const y of [1, 3, 10, 50]) assert.equal(+E.yearsCutoff(y).slice(0, 4), +E.TODAY.slice(0, 4) - y);
});

test("how far back: widening the window never loses a film, and a film is judged on its own date", () => {
  let prev = 0;
  for(const y of [1, 2, 3, 5, 10, 25, 50, 0]){
    const cut = E.yearsCutoff(y);
    const n = E.MOVIES.filter(m => E.releasedSince(m, cut)).length;
    assert.ok(n >= prev, `a ${y || "any"}-year window caught ${n}, fewer than the tighter one's ${prev}`);
    prev = y ? n : prev;
  }
  // A dated film is judged on the date — that is what makes it rolling — and one with only a year on its
  // year, because a title we cannot date precisely must not be dropped for our own missing field.
  const cut = E.yearsCutoff(1);
  const dated = E.MOVIES.filter(m => m.cinema_date);
  assert.ok(dated.length > 0);
  for(const m of dated.slice(0, 300))
    assert.equal(E.releasedSince(m, cut), m.cinema_date >= cut,
      `${m.title} (${m.cinema_date}) was judged against ${cut} by something other than its date`);
  const undated = E.MOVIES.find(m => !m.cinema_date && m.year);
  if(undated) assert.equal(E.releasedSince(undated, cut), E.yearOf(undated) >= cut.slice(0, 4));
});

test("how far back: the track is ten fixed, non-linear-spaced stops, and every one is reachable (CAS-340)", () => {
  const landed = new Set(Array.from({ length: 101 }, (_, p) => E.yearsForPos(p)));
  assert.equal(landed.size, E.YEARS_STOPS.length,
    `expected exactly the ${E.YEARS_STOPS.length} stops, landed on ${landed.size}`);
  for(const y of E.YEARS_STOPS) assert.ok(landed.has(y), `${y} years is a stop no slider position lands on`);
  // Non-linear means the recent years get the room: 2→1 must take more of the track than 25→50, which is
  // the whole argument for compressing the older end. CAS-340 runs the track furthest-back-left to
  // most-recent-right, so the recent gap is (1's position - 2's position).
  const short = E.posForYears(1) - E.posForYears(2);
  const long  = E.posForYears(25) - E.posForYears(50);
  assert.ok(short > long, `2→1 spans ${short.toFixed(1)}% and 25→50 spans ${long.toFixed(1)}% — not non-linear`);
  // Position and value round-trip, and the marks stay on the track.
  for(const y of E.YEARS_STOPS){
    const p = E.posForYears(y);
    assert.ok(p >= 0 && p <= 100, `${y} years sits at ${p}%`);
    assert.equal(E.yearsForPos(p), y, `${y} years maps to ${p}% which reads back as ${E.yearsForPos(p)}`);
  }
  // CAS-340: furthest-back on the left, most recent on the right.
  assert.equal(E.yearsForPos(0), 0, "the bottom of the track must be Any");
  assert.equal(E.posForYears(0), 0, "Any sits at the very left");
  assert.equal(E.posForYears(1), 100, "the tightest window sits at the very right");
});

test("how far back: an agent saved under the old rung keeps its window", () => {
  const expect = [0, 10, 5, 3, 2, 1];
  expect.forEach((years, i) => {
    assert.equal(E.yearsFromLegacy(i), years, `rung ${i} converted to ${E.yearsFromLegacy(i)} years`);
    assert.equal(E.normCascade({ yearStop: i }).yearsBack, years);
  });
  // …and one saved SINCE keeps its own answer rather than being overwritten by the conversion.
  assert.equal(E.normCascade({ yearStop: 5, yearsBack: 20 }).yearsBack, 20);
});

// ---- 3g. ONE ENTRY PER SERVICE (CAS-251) ----------------------------------------------------------------
// The provider feed names a service once per way you can pay for it, so the picker was 48 chips for about
// 30 services — and picking the wrong one of a pair silently missed every film listed under the other.
test("services: billing variants collapse onto the service they are variants of", () => {
  const pairs = [
    ["Netflix Standard with Ads", "Netflix"],
    ["Netflix Kids", "Netflix"],
    ["Amazon Prime Video with Ads", "Amazon Prime Video"],
    ["Paramount Plus Basic with Ads", "Paramount Plus"],
    ["Paramount+ Amazon Channel", "Paramount Plus"],
    ["HBO Max Amazon Channel", "HBO Max"],
    ["Shudder Apple TV Channel", "Shudder"],
  ];
  for(const [raw, want] of pairs) assert.equal(E.svcCanon(raw), want,
    `${raw} collapsed to ${E.svcCanon(raw)}`);
  // …and a name that is not a variant is left exactly alone.
  for(const plain of ["Netflix", "Stan", "Apple TV Store", "SBS On Demand"])
    assert.equal(E.svcCanon(plain), plain, `${plain} was rewritten to ${E.svcCanon(plain)}`);
  // The list the picker draws is the canonical one, with no duplicates and nothing empty.
  for(const list of [E.SUB_SERVICES, E.STORE_SERVICES]){
    assert.equal(new Set(list).size, list.length, "the service list holds a duplicate");
    for(const svc of list){
      assert.ok(svc && svc.trim(), "the service list holds a blank entry");
      assert.equal(E.svcCanon(svc), svc, `${svc} is itself a variant and should have collapsed`);
    }
  }
});

test("services: a pick matches every variant of the service it names", () => {
  const netflix = E.MOVIES.filter(m => (m.offers || []).some(o => /^Netflix/.test(o.service)));
  assert.ok(netflix.length > 0, "no Netflix films — this test would prove nothing");
  const sub = new Set(E.prefs.sub);
  E.prefs.sub.clear(); E.prefs.sub.add("Netflix");
  try {
    for(const m of netflix) assert.ok(E.matchesServices(m),
      `${m.title} is on ${(m.offers || []).map(o => o.service).join(", ")} and a Netflix pick missed it`);
  } finally { E.prefs.sub.clear(); sub.forEach(x => E.prefs.sub.add(x)); }
});

test("services: the leading services really do lead", () => {
  // The order is the catalogue's own evidence — how many films each service carries — not a hand-kept list
  // of who is big this year, so it cannot go stale.
  const carried = svc => E.MOVIES.filter(m =>
    (m.offers || []).some(o => (o.type === "sub" || o.type === "free") && E.svcCanon(o.service) === svc)).length;
  const lead = E.SUB_SERVICES.slice(0, E.SVC_LEAD).map(carried);
  const tail = E.SUB_SERVICES.slice(E.SVC_LEAD).map(carried);
  assert.ok(lead.length === E.SVC_LEAD && tail.length > 0, "there is no tail to hide");
  assert.ok(Math.min(...lead) >= Math.max(...tail),
    `a hidden service carries more than a leading one: lead ${lead.join(",")} vs tail ${tail.join(",")}`);
});

// ---- 3h. AN EXACT DATE LOOKS DIFFERENT FROM AN ESTIMATE (CAS-240) ---------------------------------------
// CAS-426: the current window's date is inline in the availability capsule (bandHTML); the other three
// windows' dates moved to the "Windows" line in the offers expander (windowsLineHTML) — same data, split
// across the two places the redesign put it, so a date check has to look at both.
test("dates: a date we hold is printed to the day, an estimate stays a month", () => {
  const withCinema = SHOWABLE.filter(m => m.cinema_date);
  assert.ok(withCinema.length > 0, "no film has a cinema date — this test would prove nothing");
  let exact = 0, estimated = 0;
  for(const m of SHOWABLE.slice(0, 400)){
    const html = E.bandHTML(m, "") + E.windowsLineHTML(m);
    for(const key of ["cinema", "pvod", "rental", "included_streaming"]){
      const sd = E.stageDate(m, key);
      if(!sd) continue;
      if(sd.est){ estimated++; continue; }
      exact++;
      // The day is on the card, and the month-only form is not what was printed for it.
      assert.ok(html.includes(E.fmtDay(sd.d)),
        `${m.title}: ${key} is a real ${sd.d} and the strip does not show it to the day`);
    }
  }
  assert.ok(exact > 0 && estimated > 0,
    `the sample held ${exact} exact and ${estimated} estimated dates — one of the two paths is untested`);
});

test("dates: the day form is compact, unambiguous, and never a fabricated precision", () => {
  // CAS-296: every date shows its year, this year included — dropping it read as ambiguous once a film's
  // window could straddle a year boundary.
  const thisYear = `${E.TODAY.slice(0, 4)}-03-07`;
  const other    = "2019-11-21";
  assert.equal(E.fmtDay(thisYear), `7 Mar ${E.TODAY.slice(2, 4)}`);
  assert.equal(E.fmtDay(other), "21 Nov 19");
  assert.equal(E.fmtDay(""), "", "an absent date must print nothing, never a guess");
  // An ESTIMATE is still a month and a year — a day would claim a precision the offset does not have.
  assert.equal(E.fmtDate(other), "Nov 19");
  const est = E.MOVIES.find(m => { const s = E.stageDate(m, "included_streaming"); return s && s.est; });
  if(est){
    const sd = E.stageDate(est, "included_streaming");
    const html = E.bandHTML(est, "") + E.windowsLineHTML(est);
    assert.ok(html.includes(E.fmtDate(sd.d)) || sd.d < E.TODAY,
      `${est.title}: an estimated streaming date is not printed in its month form`);
  }
});

// ---- 3i. THE RECOMMENDED PRESET LEADS ITS LANE (CAS-247) ------------------------------------------------
test("presets: whichever preset a lane recommends is the one offered first", () => {
  for(const kind of LANES){
    const list = E.startersFor(kind);
    assert.ok(list.length > 1, `${kind} offers ${list.length} presets`);
    const rec = list.find(s => s.key === E.RECOMMENDED_FOR[kind]);
    assert.ok(rec, `${kind} recommends a preset it does not offer`);
    assert.equal(list[0].key, rec.key,
      `${kind} recommends ${rec.name} and offers ${list[0].name} first`);
    // Everything else keeps the order it was written in, so lifting one does not reshuffle the rest.
    const rest = list.slice(1).map(s => s.key);
    const written = E.STARTERS.filter(s => (s.kinds || LANES).includes(kind) && s.key !== rec.key).map(s => s.key);
    assert.equal(rest.join(","), written.join(","), `${kind}: the tail was reordered too`);
  }
});

// ---- 4. COUNTS HOLD ACROSS A WIDER MATRIX THAN THE PRESETS ----------------------------------------------
// The presets are eleven points in a space a person can move freely around. A count bug that only appears
// once someone has touched a dial would pass every preset-shaped test, so this walks each preset with each
// dial pushed off its starting position, one at a time.
const PERTURB = [
  ["genre",   d => ({ ...d, genre: ["Drama"] })],
  ["genres",  d => ({ ...d, genre: ["Drama", "Comedy", "Action"] })],
  ["lang",    d => ({ ...d, lang: [] })],
  ["age",     d => ({ ...d, age: [] })],
  ["crowd",   d => ({ ...d, selCrowd: 7 })],
  ["critics", d => ({ ...d, selCritScore: 80 })],
  ["awards",  d => ({ ...d, selAwards: 2 })],
  ["scale",   d => ({ ...d, selScale: 15e6 })],
  ["buzz",    d => ({ ...d, selBuzz: 2 })],
  ["awards",  d => ({ ...d, awards: true })],
  ["windows", d => ({ ...d, status: (d.status || []).slice(0, 1) })],
];

test("counts: every count in the wider matrix is still the size of its own set", () => {
  for(const { kind, s, label } of CASES){
    pickInLane(E, kind, s.key);
    const base = E.onbApply();
    for(const [what, move] of PERTURB){
      const d = E.normCascade(move(base));
      const byCounter = E.watchCount(d);
      const bySet = E.MOVIES.filter(m => E.watchesFilm(m, d)).length;
      assert.equal(byCounter, bySet, `${label} + ${what}: watchCount says ${byCounter}, the set has ${bySet}`);
      const shown = E.MOVIES.filter(m => E.matchesCriteria(m, d)).length;
      assert.equal(E.countCriteria(d), shown, `${label} + ${what}: countCriteria disagrees with its own set`);
      assert.ok(shown <= bySet, `${label} + ${what}: ${shown} showable exceeds ${bySet} watched`);
      // A listing is drawn from the watched set, so it can never be larger than it — and the gap is never
      // unexplained: every film the agent follows but does not list is one that has not arrived in a window
      // it lists. A streaming agent follows a film that is still in cinemas so it can tell you when it
      // lands; that film is in the haul and not on the screen, and that is the whole of the difference.
      const watched = E.MOVIES.filter(m => E.watchesFilm(m, d));
      const listed = watched.filter(m => E.listedBy(m, d)).length;
      assert.equal(E.MOVIES.filter(m => E.listedBy(m, d)).length, listed,
        `${label} + ${what}: lists a film it does not follow`);
      assert.ok(listed <= bySet, `${label} + ${what}: lists ${listed} of a watched set of ${bySet}`);
      const upstream = watched.filter(m => !E.listedBy(m, d));
      for(const m of upstream) assert.ok(!d.listStatus.length || !d.listStatus.includes(E.primaryStatus(m))
        // CAS-481: the other lawful reason a followed film sits in a listed window and still isn't listed —
        // an estimated "upcoming" claim the pipeline could never confirm and isn't still ahead of us, which
        // listWindowOK refuses the same way CAS-170 already refuses every other estimated non-cinema window.
        || (E.primaryStatus(m) === "upcoming" && E.isEstimated(m)),
        `${label} + ${what}: follows ${m.title}, which is sitting in the listed window ` +
        `${E.primaryStatus(m)} and still is not listed`);
    }
  }
});

test("counts: one recipe measured twice gives one answer, whichever dial was moved", () => {
  for(const { kind, s, label } of CASES){
    pickInLane(E, kind, s.key);
    const base = E.onbApply();
    for(const [what, move] of PERTURB){
      const d = E.normCascade(move(base));
      assert.equal(E.watchCount(d), E.watchCount(E.normCascade({ ...d })),
        `${label} + ${what}: the same recipe answered twice with two numbers`);
    }
  }
});

test("counts: a facet is never larger than the set it slices, anywhere in the matrix", () => {
  for(const { kind, s, label } of CASES){
    pickInLane(E, kind, s.key);
    const base = E.onbApply();
    for(const [what, move] of PERTURB){
      const d = E.normCascade(move(base));
      // The facet chips answer with their own axis opened, so the ceiling is the total with that axis open.
      const openGenre = E.watchCount(E.normCascade({ ...d, genre: [] }));
      const openLang  = E.watchCount(E.normCascade({ ...d, lang: [] }));
      const total = E.watchCount(d);
      assert.ok(total <= openGenre && total <= openLang,
        `${label} + ${what}: opening an axis made the set smaller (${total} vs ${openGenre}/${openLang})`);
    }
  }
});

// ---- 5. MY SERVICES ONLY EVER NARROWS (CAS-252) ---------------------------------------------------------
// "Only show films on my services" is a promise that everything left is something you can actually press
// play on. Two properties have to hold for that to be true, and they are asserted against real service names
// taken from the catalogue rather than invented ones.
function withServices(subs, stores, run){
  const sub = new Set(E.prefs.sub), store = new Set(E.prefs.store), on = E.prefs.on;
  E.prefs.sub.clear(); subs.forEach(s => E.prefs.sub.add(s));
  E.prefs.store.clear(); stores.forEach(s => E.prefs.store.add(s));
  E.prefs.on = true;
  try { return run(); }
  finally {
    E.prefs.sub.clear(); sub.forEach(s => E.prefs.sub.add(s));
    E.prefs.store.clear(); store.forEach(s => E.prefs.store.add(s));
    E.prefs.on = on;
  }
}

test("my services: a scoped window only ever shows films the picked services carry", () => {
  const subs = E.SUB_SERVICES.slice(0, 2);
  const stores = E.STORE_SERVICES.slice(0, 2);
  assert.ok(subs.length && stores.length, "the catalogue names no services — this test would prove nothing");
  withServices(subs, stores, () => {
    assert.equal(E.servicesPicked(), true, "picked services did not register");
    for(const { kind, s, label } of CASES){
      pickInLane(E, kind, s.key);
      const scoped = E.normCascade({ ...E.onbApply(), myServices: { pvod: true, rental: true, included_streaming: true } });
      for(const m of E.MOVIES){
        if(!E.matchesCriteria(m, scoped)) continue;
        const ps = E.primaryStatus(m);
        if(!E.HOME_KEYS.includes(ps)) continue;   // cinema and upcoming are not on any service
        // CAS-342: "on a service" has to mean an offer belonging to the window the film actually landed in
        // — an owned rental satisfying a film that only reads back as "on your services" through a
        // streaming offer nobody here holds is exactly the bug this ticket closes.
        assert.ok(E.matchesServices(m, ps),
          `${label}: shows ${m.title} at ${ps} under a my-services scope that none of its ` +
          `${ps} offers (${(m.offers || []).map(o => o.service).join(", ") || "none"}) satisfies`);
      }
    }
  });
});

// CAS-342: the catalogue currently carries no film with both a confirmed subscription AND a confirmed
// cheap-rental offer at once (a real dual title would need both, which today's feed just doesn't have) —
// so the cheapest-wins routing can only be proven with a plain object standing in for one. primaryStatus()
// and matchesServices() read only `status`/`offers` off whatever they're given, so this needs no MOVIES
// membership at all.
test("my services: a dual rent+stream title routes by which of MY OWN services actually reaches it", () => {
  const sub = new Set(E.prefs.sub), store = new Set(E.prefs.store), on = E.prefs.on;
  const dualStatus = ["rental", "included_streaming"];
  const filmOn = (streamSvc, rentSvc) => ({
    title: "Cheapest-Wins Test Film", status: dualStatus,
    offers: [{ type: "sub", service: streamSvc, price: null }, { type: "rent", service: rentSvc, price: 5.99 }],
  });
  try {
    E.prefs.sub.clear(); E.prefs.sub.add("Netflix");
    E.prefs.store.clear(); E.prefs.store.add("Apple TV Store");
    E.prefs.on = true;

    // Owns the rental only (streaming offer is on a service nobody here holds): must file — and be
    // reachable for — Rent, not Stream. This is bug (a)'s exact shape: HBO offered, only Netflix picked.
    const rentalOnly = filmOn("HBO Max", "Apple TV Store");
    assert.equal(E.primaryStatus(rentalOnly), "rental",
      "owns only the rental side of a dual title but it still filed under Stream");
    assert.equal(E.matchesServices(rentalOnly, "rental"), true, "the owned rental offer was not recognised");
    assert.equal(E.matchesServices(rentalOnly, "included_streaming"), false,
      "an HBO offer nobody here holds still counts as \"on your services\" for Stream");

    // Owns the streaming side only: files under Stream, same as the ladder's unscoped default.
    const streamOnly = filmOn("Netflix", "Some Other Rental Store");
    assert.equal(E.primaryStatus(streamOnly), "included_streaming",
      "owns the streaming side of a dual title but it did not file under Stream");

    // Owns both: streaming is as free as it gets, so it still wins over paying to rent.
    const both = filmOn("Netflix", "Apple TV Store");
    assert.equal(E.primaryStatus(both), "included_streaming",
      "owning both sides of a dual title stopped preferring the free (already-paid) one");

    // Scope OFF entirely: the ladder's unscoped default (streaming preferred) is untouched by ownership.
    E.prefs.on = false;
    assert.equal(E.primaryStatus(rentalOnly), "included_streaming",
      "the unscoped default must still prefer streaming regardless of who owns what");
  } finally {
    E.prefs.sub.clear(); sub.forEach(x => E.prefs.sub.add(x));
    E.prefs.store.clear(); store.forEach(x => E.prefs.store.add(x));
    E.prefs.on = on;
  }
});

// CAS-252: the switch used to be inert until a service was named, so with it ON and nothing picked the
// screen said "only showing films on your services" over the whole catalogue — 111 films that were on no
// service of yours, because you had none. Nothing is on your services when you have none.
test("my services: with the scope on and nothing picked, nothing on a service qualifies", () => {
  const sub = new Set(E.prefs.sub), store = new Set(E.prefs.store), on = E.prefs.on;
  E.prefs.sub.clear(); E.prefs.store.clear(); E.prefs.on = true;
  try {
    assert.equal(E.servicesPicked(), false, "the fixture picked a service");
    for(const { kind, s, label } of CASES){
      pickInLane(E, kind, s.key);
      const scoped = E.normCascade({ ...E.onbApply(),
        myServices: { pvod: true, rental: true, included_streaming: true } });
      const shown = E.MOVIES.filter(m => E.matchesCriteria(m, scoped));
      const onService = shown.filter(m => E.HOME_KEYS.includes(E.primaryStatus(m)));
      assert.equal(onService.length, 0,
        `${label}: ${onService.length} films are still shown at home with no service picked, e.g. ` +
        `${onService.slice(0, 3).map(x => x.title).join(", ")}`);
      // A cinema window is not on any service, so it is not what the scope is about and must survive.
      for(const m of shown) assert.ok(!E.HOME_KEYS.includes(E.primaryStatus(m)),
        `${label}: ${m.title} slipped through at ${E.primaryStatus(m)}`);
    }
  } finally {
    E.prefs.sub.clear(); sub.forEach(x => E.prefs.sub.add(x));
    E.prefs.store.clear(); store.forEach(x => E.prefs.store.add(x));
    E.prefs.on = on;
  }
});

// …and with SOME picked it is the matching subset, never the whole catalogue and never nothing.
test("my services: with some picked, the scope leaves exactly what those services carry", () => {
  const subs = E.SUB_SERVICES.slice(0, 3);
  withServices(subs, [], () => {
    pickInLane(E, "stream", "custom");
    const base = E.normCascade({ ...E.onbApply(), myServices: false });
    const scoped = E.normCascade({ ...base, myServices: { included_streaming: true } });
    const open = E.MOVIES.filter(m => E.matchesCriteria(m, base));
    const kept = E.MOVIES.filter(m => E.matchesCriteria(m, scoped));
    assert.ok(kept.length < open.length, `the scope kept all ${open.length} films — it is not filtering`);
    assert.ok(kept.length > 0, "the scope left nothing, with three of the biggest services picked");
    for(const m of kept){
      if(E.primaryStatus(m) !== "included_streaming") continue;
      assert.ok((m.offers || []).some(o => subs.includes(E.svcCanon(o.service))),
        `${m.title} survived a scope to ${subs.join(", ")} on offers from ` +
        `${(m.offers || []).map(o => o.service).join(", ")}`);
    }
  });
});

test("my services: switching the scope on never adds a film", () => {
  withServices(E.SUB_SERVICES.slice(0, 2), E.STORE_SERVICES.slice(0, 2), () => {
    for(const { kind, s, label } of CASES){
      pickInLane(E, kind, s.key);
      const base = E.normCascade({ ...E.onbApply(), myServices: false });
      const open = E.MOVIES.filter(m => E.matchesCriteria(m, base)).length;
      for(const w of E.HOME_KEYS){
        const scoped = E.normCascade({ ...base, myServices: { [w]: true } });
        const after = E.MOVIES.filter(m => E.matchesCriteria(m, scoped)).length;
        assert.ok(after <= open, `${label}: scoping ${w} to my services took the count UP, ${open} → ${after}`);
      }
    }
  });
});
