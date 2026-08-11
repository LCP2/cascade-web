// CAS-231: engine invariants. Run with `node --test tests/js/invariants.test.mjs` (no dependencies, no build
// step — node's own test runner against the built index.html). Exits non-zero on any violation.
//
// These are RELATIONAL assertions, not recorded numbers. The catalogue is refreshed daily on main, so any test
// that pinned "28 films" would be red by tomorrow morning and would teach everyone to ignore it. What does not
// move is the relationships: a count equals the set it counts, narrowing never widens, a facet of a set is no
// bigger than the set, and one recipe measured twice gives one answer. Those are the properties every count bug
// in this release actually violated — CAS-221's 21-vs-2 broke "one recipe, one answer"; CAS-224's Drama · 752
// over a total of 28 broke "a facet is no bigger than the set".
import test from "node:test";
import assert from "node:assert/strict";
import { loadEngine, pickInLane } from "./engine.mjs";

const E = loadEngine();

// Every preset in every lane it is offered in — the real matrix a person can walk into.
const LANES = ["cinema", "stream"];
const CASES = LANES.flatMap(kind => E.startersFor(kind).map(s => ({ kind, s, label: `${kind}/${s.key}` })));

test("the harness is holding the real, built catalogue", () => {
  assert.ok(E.MOVIES.length > 500, `only ${E.MOVIES.length} films — index.html looks unbuilt`);
  assert.ok(E.SHOWABLE_N > 0 && E.SHOWABLE_N <= E.MOVIES.length);
  assert.ok(CASES.length >= 6, `only ${CASES.length} preset/lane cases`);
});

// ---- 1. COUNT INTEGRITY ---------------------------------------------------------------------------------
// The number a screen prints must be the size of the set it claims to describe. Counted two ways: through the
// engine's own counter, and by filtering the catalogue by hand with the same predicate.
test("count integrity: every reported count is the size of its own matching set", () => {
  for(const { kind, s, label } of CASES){
    pickInLane(E, kind, s.key);
    const d = E.onbApply();
    const byCounter = E.watchCount(d);
    const bySet = E.MOVIES.filter(m => E.watchesFilm(m, d)).length;
    assert.equal(byCounter, bySet, `${label}: watchCount says ${byCounter}, the set has ${bySet}`);
    assert.equal(E.onbCount(), bySet, `${label}: the flow's count disagrees with its own set`);

    // …and the same for the narrower "can watch it today" number, which is a different question and must not
    // be allowed to quietly answer the first one (the CAS-143 confusion).
    const shown = E.MOVIES.filter(m => E.matchesCriteria(m, d)).length;
    assert.equal(E.countCriteria(d), shown, `${label}: countCriteria disagrees with its own set`);
    assert.ok(shown <= bySet, `${label}: ${shown} shown now exceeds ${bySet} watched — a subset cannot be bigger`);
  }
});

// ---- 1b. EDIT SCREEN MATCHES THE LISTING (CAS-446) ------------------------------------------------------
// The Edit-Agent screen's "N films match right now" (onbShownCount, via stepCount()'s mirror + CTA) has to
// quote the same number as the deck card and the listing (listedCount) — what the agent will actually LIST
// right now — not the broader watch-ahead figure. A streaming agent diverges when it watches a window ahead
// of what it lists (e.g. watching Rent+Stream but listing Stream only); a cinema agent never diverges
// because cinema is the first window in CASCADE order, so nothing sits "ahead" of it to inflate the count.
test("edit screen matches the listing: onbShownCount equals listedCount, for every lane", () => {
  for(const { kind, s, label } of CASES){
    pickInLane(E, kind, s.key);
    const d = E.onbApply();
    assert.equal(E.onbShownCount(), E.listedCount(d),
      `${label}: Edit says ${E.onbShownCount()}, the listing has ${E.listedCount(d)}`);
  }
});

// ---- 2. ONE RECIPE, ONE ANSWER (CAS-221) ----------------------------------------------------------------
// The pick-agent card and the flow are two views of the same agent, so they are two printings of one number.
// This is the invariant CAS-221 restored; it is here so it cannot rot again.
test("one recipe, one answer: the card's count equals the flow's count", () => {
  for(const { kind, s, label } of CASES){
    pickInLane(E, kind, s.key);
    assert.equal(E.starterCount(s, kind), E.onbCount(),
      `${label}: card says ${E.starterCount(s, kind)}, Mission says ${E.onbCount()}`);
  }
});

// ---- 3. MONOTONICITY ------------------------------------------------------------------------------------
// Narrowing any one axis can only ever remove films. This is what makes a falling count legible as "you asked
// for more" — CAS-114 reversed the dials to AND for exactly this reason, and a regression here would make the
// count move the opposite way to the gesture.
test("monotonicity: narrowing any single axis never increases the count", () => {
  const narrower = [
    ["genre",     d => ({ ...d, genre: ["Drama"] })],
    ["age",       d => ({ ...d, age: [E.AGE_LEVELS[0]] })],
    ["lang",      d => ({ ...d, lang: ["en"] })],
    ["vote bar",  d => ({ ...d, selCrowd: Math.max(d.selCrowd || 0, 7.5) })],
    // CAS-249 split the one 0-4 critics ladder into a continuous SCORE floor and a counted awards rung.
    // Both narrow, and both are poked, because a dead assertion on a field nothing reads any more would sit
    // here passing forever — which is the failure mode a renamed field usually produces in a suite.
    ["critics score", d => ({ ...d, selCritScore: Math.max(d.selCritScore || 0, 80) })],
    ["awards rung",   d => ({ ...d, selAwards:    Math.max(d.selAwards || 0, 2) })],
    ["scale",     d => ({ ...d, selScale: Math.max(d.selScale || 0, 100e6) })],
    ["buzz",      d => ({ ...d, selBuzz: Math.max(d.selBuzz || 0, 3) })],
    ["awards",    d => ({ ...d, awards: true })],
    // Dropping a window is a narrowing; SWAPPING one is not, and it took a failing run to see why. Membership
    // is "a window I watch is still ahead of this film" (inScope), so watching a LATER window admits more, not
    // fewer — pointing a cinema agent at streaming took 28 to 153. A subset of the windows is the real
    // narrowing, and that is what this asserts.
    ["windows",   d => ({ ...d, status: (d.status || []).slice(0, 1) })],
  ];
  for(const { kind, s, label } of CASES){
    pickInLane(E, kind, s.key);
    const base = E.onbApply();
    const before = E.watchCount(base);
    for(const [what, tighten] of narrower){
      const after = E.watchCount(E.normCascade(tighten(base)));
      assert.ok(after <= before,
        `${label}: tightening ${what} took the count UP, ${before} → ${after}`);
    }
  }
});

// ---- 4. FACET COUNTS ARE WITHIN THE SET (CAS-224) -------------------------------------------------------
// A per-genre or per-language number is a slice of the agent's own films, so no slice can be bigger than the
// whole. Before CAS-224 the chips quoted the whole catalogue (Drama · 752 on a page whose total was 28), which
// is precisely this invariant broken by a factor of 27.
test("facet counts: no genre or language slice is larger than the set it slices", () => {
  for(const { kind, s, label } of CASES){
    pickInLane(E, kind, s.key);
    // The facet counts open their own axis, so the ceiling is the total with that axis open — not the total
    // with it applied. Comparing against the narrowed total would be comparing two different populations.
    const openGenre = E.watchCount(E.normCascade({ ...E.onbApply(), genre: [] }));
    const openLang  = E.watchCount(E.normCascade({ ...E.onbApply(), lang: [] }));
    for(const [g, n] of Object.entries(E.genreCountsNow())){
      assert.ok(n <= openGenre, `${label}: genre ${g} counts ${n} of ${openGenre}`);
      assert.ok(n >= 0 && Number.isInteger(n), `${label}: genre ${g} counts ${n}`);
    }
    const langs = Object.entries(E.langCountsNow());
    for(const [l, n] of langs) assert.ok(n <= openLang, `${label}: language ${l} counts ${n} of ${openLang}`);
    // Language is single-valued per film, so its slices PARTITION the set and must sum to exactly the total.
    // Genres overlap, so no such assertion is available there (see CAS-224 for why (a) was chosen over (b)).
    const sum = langs.reduce((a, [, n]) => a + n, 0);
    assert.equal(sum, openLang, `${label}: language counts sum to ${sum}, set is ${openLang}`);
  }
});

// ---- 5. THE LANE'S WINDOWS AND ITS LISTING (CAS-227 / CAS-228) ------------------------------------------
// Two properties the v0.8.1 window model has to keep: a listed window is always a watched window (you cannot
// list what the agent does not follow), and a cinema agent never watches a home window or vice versa.
test("windows: everything listed is watched, and lanes keep to their own windows", () => {
  const CINEMA_W = new Set(["upcoming", "opening_week", "in_cinema"]);
  for(const { kind, s, label } of CASES){
    pickInLane(E, kind, s.key);
    const d = E.onbApply();
    for(const w of d.listStatus) assert.ok(d.status.includes(w),
      `${label}: lists ${w} without watching it — the films could never arrive`);
    const isCinema = [...d.status].some(w => CINEMA_W.has(w));
    const isHome   = [...d.status].some(w => !CINEMA_W.has(w));
    assert.ok(!(isCinema && isHome), `${label}: watches both cinema and home windows — ${d.status.join(",")}`);
    assert.equal(isCinema, kind === "cinema", `${label}: a ${kind} agent watches ${d.status.join(",")}`);
  }
});

// A film that is listed must be one the agent watches, and must sit in a window the agent lists. Checked over
// the real catalogue rather than asserted from the fields, so a listing bug cannot hide behind correct config.
test("windows: no listed film sits outside the agent's listed windows", () => {
  for(const { kind, s, label } of CASES){
    pickInLane(E, kind, s.key);
    const d = E.onbApply();
    const listed = E.MOVIES.filter(m => E.listedBy(m, d));
    for(const m of listed){
      assert.ok(E.matchesTaste(m, d), `${label}: lists ${m.title}, which fails its own taste test`);
      if(d.listStatus.length) assert.ok(d.listStatus.includes(E.primaryStatus(m)),
        `${label}: lists ${m.title} from ${E.primaryStatus(m)}, not a listed window`);
    }
  }
});

// ---- 6. AVAILABILITY IS BACKED BY SOMETHING (CAS-170 / CAS-155 / CAS-227) -------------------------------
test("availability: every showable film is unreleased, offered, or in a cinema run", () => {
  for(const m of E.MOVIES){
    if(!E.showable(m)) continue;
    const upcoming   = (m.status || []).includes("upcoming");
    const offered    = !E.isEstimated(m) && (m.offers || []).length > 0;
    // CAS-237 widened the third case by exactly one clause. It used to require a CONFIRMED title; it now
    // also admits an estimated one, PROVIDED the film is in a cinema window with its opening date still
    // inside the run. That is not a weaker claim, it is the same claim: the evidence for "on a screen" is a
    // real opening date and no digital listing, and whether the pipeline or the front end read that
    // evidence changes nothing about it. Every other estimated window is still excluded (CAS-170).
    const inCinema   = E.inCinemaWindow(m) && (!E.isEstimated(m) || E.inCinemaRun(m));
    assert.ok(upcoming || offered || inCinema,
      `${m.title} is listable on nothing: status ${(m.status||[]).join(",")}, ${(m.offers||[]).length} offers`);
    // CAS-155's fault in one line: a film with a rent or stream offer must never be filed under the big screen.
    if(inCinema) assert.ok(!(m.offers || []).length,
      `${m.title} is in a cinema window while holding ${(m.offers||[]).length} digital offers`);
    if(inCinema) assert.ok(m.cinema_date, `${m.title} is in a cinema window with no opening date`);
  }
});

// ---- 7. THE SCALE DIAL LEANS, IT DOES NOT CUT (CAS-166) -------------------------------------------------
// A film whose scale we do not know rides along; only a film we KNOW is too small is dropped. If this ever
// flips to a hard cut, every count quietly loses the large slice of the catalogue carrying no money figures.
// "Unknown" means neither budget NOR worldwide gross — the dial reads gross as a fallback, so a film with a
// gross has a known scale even with no budget on it (which is what a first failing run of this test showed).
test("scale: an unknown scale is never the reason a film is dropped", () => {
  const unknown = E.MOVIES.filter(m => !(m.budget > 0) && !(m.worldwide_gross > 0));
  assert.ok(unknown.length > 0, "every film has a money figure — this test would prove nothing");
  for(const m of unknown){
    assert.notEqual(E.selScaleMatch(m, { selScale: 100e6 }), false,
      `${m.title} has no budget or gross and was cut by the scale dial`);
  }
  // …and the other half of "lean, not cut": a film we know is small IS dropped, or the dial does nothing.
  const small = E.MOVIES.find(m => m.budget > 0 && m.budget < 1e6);
  if(small) assert.equal(E.selScaleMatch(small, { selScale: 100e6 }), false,
    `${small.title} at $${small.budget} passed a $100M floor`);
});
