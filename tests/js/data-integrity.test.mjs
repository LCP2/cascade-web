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

// A preset on the pick-agent screen is an offer, and an offer that lists nothing is a dead end. One does
// today — cinema/prestige, 0 films — and it is the KNOWN GAP recorded on CAS-231: the cinema presets carry
// criteria on dials the cinema lane neither shows nor relaxes, so an awards rung nobody can see empties the
// agent. That is CAS-231/CAS-237's to close, not this test's to hide, so this is a ratchet: it holds the
// number of empty offers where it is and fails the moment a second one goes dark.
const EMPTY_OFFERS_TODAY = 1;
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
  const upcoming = listed.filter(m => E.isUpcoming(m)).length;
  const share = 100 * upcoming / Math.max(1, listed.length);
  assert.ok(share <= 90,
    `the widest cinema recipe is ${share.toFixed(0)}% Upcoming (${upcoming} of ${listed.length}) — a wall, not a listing`);
});

// The listing leads with what you can watch, and keeps Upcoming as the tail. Asserted on the shipped order
// rather than on the rendering, because the reveal and the listing must walk the same sequence (CAS-176).
test("in cinema: the listing leads with what is out and ends with what is not", () => {
  assert.equal(E.LISTING_ORDER[E.LISTING_ORDER.length - 1], "upcoming",
    `the listing leads with ${E.LISTING_ORDER[0]} and would put unreleased films above watchable ones`);
  assert.deepEqual([...E.LISTING_ORDER].sort(), [...E.CASCADE].sort(),
    "the listing order and the journey order are not the same six windows");
  pickInLane(E, "cinema", "custom");
  const d = E.onbApply();
  const seq = E.listingOrder(E.MOVIES.filter(m => E.listedBy(m, d)), d.sort || "availability");
  const firstUpcoming = seq.findIndex(m => E.isUpcoming(m));
  const lastReleased = seq.map(m => !E.isUpcoming(m)).lastIndexOf(true);
  if(firstUpcoming >= 0 && lastReleased >= 0) assert.ok(firstUpcoming > lastReleased,
    `an Upcoming film sits at ${firstUpcoming}, above a released one at ${lastReleased}`);
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

// The same film, through the whole recipe rather than the one dial: a scale lean must never be the reason a
// film with no money figure disappears from an agent that otherwise wants it.
test("scale: raising the lean never removes a film whose scale we do not hold", () => {
  for(const { kind, s, label } of CASES){
    pickInLane(E, kind, s.key);
    const base = E.onbApply();
    const open = E.MOVIES.filter(m => E.watchesFilm(m, E.normCascade({ ...base, selScale: 0 })));
    const blind = open.filter(m => !(m.budget > 0) && !(m.worldwide_gross > 0));
    if(!blind.length) continue;
    const top = E.SCALE_REF[E.SCALE_REF.length - 1].d;
    const leaned = new Set(E.MOVIES.filter(m => E.watchesFilm(m, E.normCascade({ ...base, selScale: top }))));
    for(const m of blind) assert.ok(leaned.has(m),
      `${label}: ${m.title} fell out at the top scale rung with no money figure to judge it by`);
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
  // A cinema agent starts with everything on, sub-moments included — the ticket's stated assumption.
  const seed = E.PRIORITY_WATCH.cinema.upcoming;
  assert.ok(seed.notify && seed.subs, "a new cinema agent no longer starts with the Upcoming bell on");
  for(const s of win.subs) assert.equal(seed.subs[s.key], true,
    `a new cinema agent starts with ${s.key} off, against the ticket's everything-on assumption`);
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
  assert.ok(seed.rent && seed.rent.list && seed.rent.notify, "Standard Rent is not on for a new agent");
  assert.ok(seed.stream && seed.stream.list && seed.stream.notify, "Streaming is not on for a new agent");
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

test("critics: an agent saved under the old single ladder still means what it meant", () => {
  const cases = [[0, 0, 0], [1, 60, 0], [2, 80, 0], [3, 0, 1], [4, 0, 4]];
  for(const [legacy, score, awards] of cases){
    const c = E.normCascade({ selCritics: legacy });
    assert.equal(c.selCritScore, score, `selCritics ${legacy} migrated to a ${c.selCritScore} score floor`);
    assert.equal(c.selAwards, awards, `selCritics ${legacy} migrated to awards rung ${c.selAwards}`);
  }
  // An agent saved SINCE the split is left alone — the migration must not overwrite a real answer.
  const fresh = E.normCascade({ selCritics: 4, selCritScore: 70, selAwards: 0 });
  assert.equal(fresh.selCritScore, 70);
  assert.equal(fresh.selAwards, 0);
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

test("how far back: the track is continuous and log-spaced, and every named window is reachable", () => {
  const landed = new Set(Array.from({ length: 101 }, (_, p) => E.yearsForPos(p)));
  for(const y of E.YEARS_NOTCHES) assert.ok(landed.has(y),
    `${y} years is a named notch that no slider position lands on`);
  assert.ok(landed.size > E.YEARS_NOTCHES.length + 5,
    `only ${landed.size} distinct windows across the whole track — it is still a stop ladder`);
  // Log-spaced means the short windows get the room: 1→3 must take more of the track than 25→50, which is
  // the whole argument for not making it linear.
  const short = E.posForYears(3) - E.posForYears(1);
  const long  = E.posForYears(50) - E.posForYears(25);
  assert.ok(short > long, `1→3 spans ${short.toFixed(1)}% and 25→50 spans ${long.toFixed(1)}% — not log-spaced`);
  // Position and value round-trip, and the marks stay on the track.
  for(const y of E.YEARS_NOTCHES){
    const p = E.posForYears(y);
    assert.ok(p >= 0 && p <= 100, `${y} years sits at ${p}%`);
    assert.equal(E.yearsForPos(p), y, `${y} years maps to ${p}% which reads back as ${E.yearsForPos(p)}`);
  }
  assert.equal(E.yearsForPos(0), 0, "the bottom of the track must be Any");
  assert.equal(E.posForYears(0), 0);
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
      for(const m of upstream) assert.ok(!d.listStatus.length || !d.listStatus.includes(E.primaryStatus(m)),
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
        if(!E.HOME_KEYS.includes(E.primaryStatus(m))) continue;   // cinema and upcoming are not on any service
        assert.ok(E.matchesServices(m),
          `${label}: shows ${m.title} at ${E.primaryStatus(m)} under a my-services scope that none of its ` +
          `offers (${(m.offers || []).map(o => o.service).join(", ") || "none"}) satisfies`);
      }
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
