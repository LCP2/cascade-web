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
  ["critics", d => ({ ...d, selCritics: 2 })],
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
