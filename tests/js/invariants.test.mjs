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
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadEngine, pickInLane } from "./engine.mjs";

const E = loadEngine();
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

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
// Narrowing any one axis can only ever remove films — true unconditionally for genre/age/awards/windows,
// which stay ANDed. The Mission dials (People's vote / Critics & awards / Budget / Buzz) are CAS-661's OR
// group: raising a dial that is ALREADY set only ever shrinks that one OR term, so the union with the other
// (unchanged) terms can only shrink or hold — still guaranteed. But turning a dial on FROM OFF is adding a
// new independent route in, not tightening one, and when another Mission dial is already active in the base
// recipe that can only add films, never remove them (e.g. stream/streaming: turning on Critics score while
// People's vote is already the agent's route in took 349 → 380). That case is only guaranteed to narrow when
// the dial being moved is the SOLE active Mission route (see invariants.test.mjs's own OR-specific test,
// added by CAS-661), so this general matrix walk skips it rather than asserting something no longer true.
test("monotonicity: narrowing any single axis never increases the count", () => {
  // Group id for each Mission-dial perturbation below, and whether that group is already active in a given
  // recipe. selCritScore/selAwards share one OR term (selCriticsOK), so both perturbations share one group id.
  const MISSION_GROUP_ID = { "vote bar": "crowd", "critics score": "critics", "awards rung": "critics",
                              "scale": "scale", "buzz": "buzz" };
  const groupActive = (id, d) => id === "crowd" ? !!d.selCrowd
    : id === "critics" ? !!(d.selCritScore || d.selAwards)
    : id === "scale" ? !!d.selScale : !!d.selBuzz;
  const missionActiveExcept = (d, exceptId) => Object.values(MISSION_GROUP_ID)
    .some(id => id !== exceptId && groupActive(id, d)) || !!d.cinemaReleaseOnly;
  const narrower = [
    ["genre",     d => ({ ...d, genre: ["Drama"] })],
    ["age",       d => ({ ...d, age: [E.AGE_LEVELS[0]] })],
    // CAS-560 retired the per-agent lang field (c.lang) — matchesCriteria no longer reads it, so a "lang"
    // case here would sit passing forever without testing anything (the failure mode this comment already
    // warns against). Language narrowing is exercised on tasteBase.langs instead — see the taste-baseline
    // test below.
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
      const groupId = MISSION_GROUP_ID[what];
      if(groupId && !groupActive(groupId, base) && missionActiveExcept(base, groupId)) continue;   // CAS-661:
        // adding a new OR route in, not tightening one already there — only guaranteed to narrow when this
        // dial is the sole active Mission route (or none was active, i.e. the whole block was open before)
      const after = E.watchCount(E.normCascade(tighten(base)));
      assert.ok(after <= before,
        `${label}: tightening ${what} took the count UP, ${before} → ${after}`);
    }
  }
});

// ---- 4. FACET COUNTS ARE WITHIN THE SET (CAS-224) -------------------------------------------------------
// A per-genre number is a slice of the agent's own films, so no slice can be bigger than the whole. Before
// CAS-224 the chips quoted the whole catalogue (Drama · 752 on a page whose total was 28), which is precisely
// this invariant broken by a factor of 27. This used to check a per-language facet too (langCountsNow()), but
// CAS-560 retired the per-agent language axis that facet counted — there is no longer an agent-level "lang"
// slice for a count to be a slice of.
test("facet counts: no genre slice is larger than the set it slices", () => {
  for(const { kind, s, label } of CASES){
    pickInLane(E, kind, s.key);
    // The facet counts open their own axis, so the ceiling is the total with that axis open — not the total
    // with it applied. Comparing against the narrowed total would be comparing two different populations.
    const openGenre = E.watchCount(E.normCascade({ ...E.onbApply(), genre: [] }));
    for(const [g, n] of Object.entries(E.genreCountsNow())){
      assert.ok(n <= openGenre, `${label}: genre ${g} counts ${n} of ${openGenre}`);
      assert.ok(n >= 0 && Number.isInteger(n), `${label}: genre ${g} counts ${n}`);
    }
  }
});

// ---- 4b. LANGUAGE IS TASTE-BASELINE ONLY NOW (CAS-560) --------------------------------------------------
// CAS-560 retired the per-agent language field — c.lang is forced to [] for every agent (normCascade) and
// matchesCriteria no longer reads it. tasteBase.langs (Preferences) is the only language filter left, so this
// is where the narrowing-never-widens property (CAS-114/monotonicity, above) has to hold for language now.
test("language narrowing lives on tasteBase now, and still only ever narrows", () => {
  const savedLangs = E.tasteBase.langs;
  try{
    for(const { kind, s, label } of CASES){
      pickInLane(E, kind, s.key);
      const d = E.onbApply();
      E.tasteBase.langs = [];             // open: no language filter
      const open = E.watchCount(d);
      E.tasteBase.langs = ["en"];         // narrower: English only
      const narrowed = E.watchCount(d);
      assert.ok(narrowed <= open, `${label}: narrowing tasteBase.langs took the count UP, ${open} → ${narrowed}`);
      // c.lang itself must carry no weight any more — an agent explicitly set to ["en"] must count identically
      // to the same agent left at [], since Preferences is the only language gate now.
      E.tasteBase.langs = [];
      const withStrayLang = E.watchCount(E.normCascade({ ...d, lang: ["en"] }));
      assert.equal(withStrayLang, open, `${label}: a stray c.lang still changed the count — matchesCriteria is reading it`);
    }
  } finally {
    E.tasteBase.langs = savedLangs;
  }
});

// ---- 5. THE LANE'S WINDOWS AND ITS LISTING (CAS-227 / CAS-228, CAS-723) -----------------------------------
// A listed window is always a watched window (you cannot list what the agent does not follow) — that
// property survives. CAS-723 retires the other half this test used to assert: c.kind no longer scopes an
// agent's windows, so a "cinema" preset and a "stream" preset now derive the exact same c.status from the
// one shared watchPrefs answer, with no more lane-separation to check.
test("windows: everything listed is watched", () => {
  for(const { kind, s, label } of CASES){
    pickInLane(E, kind, s.key);
    const d = E.onbApply();
    for(const w of d.listStatus) assert.ok(d.status.includes(w),
      `${label}: lists ${w} without watching it — the films could never arrive`);
  }
});

// CAS-723: c.kind retires as a window-scoping input — every agent's c.status/c.listStatus now derive from
// watchPrefs alone, so a cinema-flavoured preset and a stream-flavoured preset agree on both exactly.
test("CAS-723: cinema and stream presets derive the identical window scope from watchPrefs", () => {
  const byKind = {};
  for(const { kind, s } of CASES){
    pickInLane(E, kind, s.key);
    const d = E.onbApply();
    byKind[kind] = byKind[kind] || new Set();
    d.status.forEach(w => byKind[kind].add(w));
  }
  assert.deepEqual([...byKind.cinema].sort(), [...byKind.stream].sort(),
    `cinema presets watch ${[...byKind.cinema].sort()}, stream presets watch ${[...byKind.stream].sort()}`);
});

// ---- 5b. ONE AGENT TYPE — EVERY WINDOW ENABLED MEANS NOTHING LEAVES SCOPE (CAS-723 AC2) ------------------
// With every window switched on, inScope(m,c) must hold for every showable film and every agent — there is
// no longer a "cinema" agent whose c.status excludes home windows and therefore drops a film once it moves
// past cinemas. Fails before CAS-723 on any released film against a cinema-preset agent (inScope depends on
// c.status, which watchForKind used to narrow to upcoming/opening_week/in_cinema for that lane alone).
test("CAS-723 AC2: with every window enabled, inScope holds for every film and every agent", () => {
  const savedPrefs = E.watchPrefs;
  try {
    const allOn = {};
    for(const w of E.AGENT_WINDOWS) allOn[w.key] = { list: true, notify: true };
    E.setWatchPrefs(allOn);
    for(const { kind, s, label } of CASES){
      pickInLane(E, kind, s.key);
      const d = E.onbApply();
      for(const m of E.MOVIES){
        if(!E.showable(m)) continue;
        assert.ok(E.inScope(m, d),
          `${label}: ${m.title} (${E.primaryStatus(m)}) is out of scope with every window enabled`);
      }
    }
  } finally {
    E.setWatchPrefs(savedPrefs);
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

// ---- 8. THE CASCADE SCORE (CAS-603) ---------------------------------------------------------------------
// One number from the axes the card already prints, so a thin-voted IMDb average can no longer outrank a
// broadly-agreed film just because nothing else was reading the critic scores.
test("cascade score: critic agreement beats a below-floor IMDb rating with no critic backing, and sourceless films sort last", () => {
  // CAS-702: cascadeScore now reads primaryStatus(m) to route pre-release films to cinemaScore instead of
  // qScore — a released status keeps these fixtures on the qScore axis this test is actually about.
  const released = { status: ["included_streaming"] };
  const wellReviewed  = { ...released, title: "Well Reviewed",  imdb_rating: 8.2, imdb_votes: 1000000, metacritic: 90, rt_critic: 93 };
  const belowFloor    = { ...released, title: "Below Floor",    imdb_rating: 9.9, imdb_votes: E.IMDB_MIN_VOTES - 1 };
  const noSources      = { ...released, title: "No Sources",     imdb_rating: null, imdb_votes: 0 };

  assert.ok(E.sortMoviesBy(wellReviewed, belowFloor, "cascade") < 0,
    "a film with real critic agreement did not outrank a below-floor IMDb rating with no critic backing");

  // A film with no source at all sorts after every scored film.
  assert.ok(E.sortMoviesBy(noSources, wellReviewed, "cascade") > 0,
    "a film with no source at all did not sort after a scored film");

  // Below IMDB_MIN_VOTES the IMDb figure must not count as a rating at all — with no critic scores backing it
  // either, the film remains unscorable (CAS-660: a film scores from whatever it has, but a below-floor IMDb
  // figure is not "having" IMDb).
  assert.equal(E.qScore(belowFloor), -1, "a film under the vote floor with no critic scores was still treated as rated");
});

// ---- 9. THE CASCADE SCORE IS THREE SCALE-MATCHED TERMS (CAS-706) -------------------------------------------
// CAS-660 let qScore score from whichever of three raw sources a film carried; CAS-669 narrowed that; CAS-694
// then collapsed RT/Metacritic into one combined Critics axis. CAS-706 (Cascade 9.7) reverses CAS-694: the
// score is back to three separate terms — IMDb (gated rating x10), RT, Metacritic — but RT and Metacritic are
// each divided by their own catalogue-measured ratio (RT_ADJ, META_ADJ) to the gated IMDb-x10 figure first, so
// all three terms sit on the same 0-100 scale before averaging. A lone RT or Metacritic figure still scores,
// as its own scale-matched value, not the raw source.
const RT_ADJ = 1.0873, META_ADJ = 0.9635;
test("cascade score: scored from IMDb/RT/Metacritic (scale-matched), never from budget/gross/popularity/awards", () => {
  const metaOnly    = { title: "Metacritic Only", imdb_rating: null, imdb_votes: 0, metacritic: 61 };
  const rtOnly      = { title: "RT Only",         imdb_rating: null, imdb_votes: 0, rt_critic: 88 };
  const imdbOnly    = { title: "IMDb Only",       imdb_rating: 7.3,  imdb_votes: 1000000 };
  const bothCritics = { title: "Both Critics",    imdb_rating: null, imdb_votes: 0, metacritic: 60, rt_critic: 90 };
  const allThree    = { title: "All Three",       imdb_rating: 8.0,  imdb_votes: 1000000, metacritic: 60, rt_critic: 90 };
  const neither     = { title: "Neither",         imdb_rating: null, imdb_votes: 0 };

  // A lone Metacritic or RT figure scores as itself, scale-matched against IMDb's x10 convention.
  assert.equal(E.qScore(metaOnly), Math.round(61 / META_ADJ), "a lone Metacritic score should scale-match against IMDb and score as itself");
  assert.equal(E.qScore(rtOnly), Math.round(88 / RT_ADJ), "a lone RT score should scale-match against IMDb and score as itself");
  // People's vote alone scores as the gated rating x10.
  assert.equal(E.qScore(imdbOnly), 73, "IMDb-only score should be the gated IMDb rating x10, rounded");
  // Both critic sources present but no gated IMDb: the mean of the two scale-matched terms, and it's the WHOLE score.
  assert.equal(E.qScore(bothCritics), Math.round((60 / META_ADJ + 90 / RT_ADJ) / 2), "Metacritic+RT with no People's vote should score as the mean of the two scale-matched terms");
  // All three present: the mean of the three scale-matched terms.
  assert.equal(E.qScore(allThree), Math.round((80 + 60 / META_ADJ + 90 / RT_ADJ) / 3), "all three present should average the three scale-matched terms");
  // Neither term present scores -1.
  assert.equal(E.qScore(neither), -1, "a film with no term should not score");

  // AC4: budget, worldwide gross, popularity and awards are not terms — perturbing them changes nothing.
  const rich = { ...allThree, budget: 200e6, worldwide_gross: 900e6, popularity: 500, award: "won", award_text: "Won 3 Oscars" };
  assert.equal(E.qScore(rich), E.qScore(allThree), "budget/gross/popularity/awards changed the score");

  // AC3, whole catalogue: qScore is exactly the rounded mean of whichever scale-matched terms a film carries.
  for(const m of E.MOVIES){
    const q = E.qScore(m);
    const r = E.ratingOf(m);
    const terms = [];
    if(r != null) terms.push(r*10);
    if(m.rt_critic != null) terms.push(m.rt_critic / RT_ADJ);
    if(m.metacritic != null) terms.push(m.metacritic / META_ADJ);
    if(!terms.length){ assert.equal(q, -1, `${m.title}: has no term but scored ${q}`); continue; }
    const expected = Math.round(terms.reduce((x,y)=>x+y,0)/terms.length);
    assert.equal(q, expected, `${m.title}: qScore ${q} disagrees with the three-term mean ${expected}`);
  }
});

// ---- 9b. CRITICS IS ONE RECORDED FIGURE (CAS-694) -----------------------------------------------------------
// AC1: critScore has exactly one definition, and AC2: it's the same figure both selCriticsOK (the dial) and
// qScore (the score) read — the defect this fixes is a dial that tested one source while the score averaged
// two, which meant the two disagreed about what "the critics" said.
test("critScore: the mean of Metacritic and RT where both are present, whichever is present otherwise, null when neither is", () => {
  assert.equal(E.critScore({ metacritic: 60, rt_critic: 90 }), 75, "both present should average to their mean");
  assert.equal(E.critScore({ metacritic: 61, rt_critic: null }), 61, "Metacritic alone should read as itself");
  assert.equal(E.critScore({ metacritic: null, rt_critic: 88 }), 88, "RT alone should read as itself");
  assert.equal(E.critScore({ metacritic: null, rt_critic: null }), null, "neither present should read as null");
  // rt_critic: 0 is a present (if extreme) score, not an absent one — a truthy-only check would wrongly treat
  // it as missing, exactly the asymmetry this ticket fixes.
  assert.equal(E.critScore({ metacritic: null, rt_critic: 0 }), 0, "an RT score of exactly 0 should still read as present");

  // AC2, whole catalogue: selCriticsOK's dial must never disagree with critScore() about a film's own figure.
  for(const m of E.MOVIES){
    const cs = E.critScore(m);
    if(cs == null) continue;
    assert.equal(E.selCriticsOK(m, E.normCascade({ selCritScore: cs }, { template: true })), true,
      `${m.title}: selCriticsOK read a different Critics figure than critScore()`);
  }
});

// ---- 9d. qScoreSourcesText NAMES THE THREE RAW SOURCES (CAS-706) -------------------------------------------
// AC5: the card's own tooltip names People's vote, RT and Metacritic individually now that qScore is back to
// three scale-matched terms rather than the CAS-694 two-axis (People's vote, Critics) collapse.
test("qScoreSourcesText: names the individual sources present, not a combined Critics axis", () => {
  const imdbOnly    = { imdb_rating: 7.3, imdb_votes: 1000000 };
  const metaOnly    = { imdb_rating: null, imdb_votes: 0, metacritic: 61 };
  const rtOnly      = { imdb_rating: null, imdb_votes: 0, rt_critic: 88 };
  const allThree    = { imdb_rating: 8.0, imdb_votes: 1000000, metacritic: 60, rt_critic: 90 };
  assert.equal(E.qScoreSourcesText(imdbOnly), "People's vote only");
  assert.equal(E.qScoreSourcesText(metaOnly), "Metacritic only");
  assert.equal(E.qScoreSourcesText(rtOnly), "RT only");
  assert.equal(E.qScoreSourcesText(allThree), "People's vote, RT and Metacritic");
  assert.ok(!E.qScoreSourcesText(allThree).includes("Critics"), "qScoreSourcesText named the retired combined Critics axis");
});

// ---- 10. MISSION DIALS COMBINE WITH OR (CAS-661) ----------------------------------------------------------
// The dials used to AND (CAS-114/145): a film had to clear every one you touched. CAS-661 reverses that — a
// film now clears the Mission block if it clears AT LEAST ONE dial that is SET, so turning a second dial on
// only ever ADDS films. `{template:true}` skips laneCrit (STARTERS' own normalisation trick, CAS-261) so a
// standalone criteria object keeps whichever dials this test sets regardless of the lane its empty `status`
// would otherwise resolve to.
const missionCase = (overrides = {}) => E.normCascade({ ...overrides }, { template: true });

// CAS-663: a pre-release film (primaryStatus upcoming or in_cinema) is exempt from the quality dials, so
// the exact-equivalence-with-selCrowdOK claim below only holds for a film that has had the chance to be
// judged. isPreRelease mirrors matchesCriteria's own preRelease test.
const isPreRelease = m => ["upcoming", "in_cinema"].includes(E.primaryStatus(m));

// CAS-724: selCrowd and selCritScore retire as admission routes entirely — a film's inclusion must not move
// at all when either is set, pre-release or not. (selAwards, the third former OR member, survives as its own
// standing requirement and is covered separately below.)
test("CAS-724: selCrowd and selCritScore no longer affect admission at all", () => {
  const open = new Set(E.MOVIES.filter(m => E.matchesCriteria(m, missionCase())));
  for(const overrides of [{ selCrowd: 7.5 }, { selCritScore: 80 }, { selCrowd: 7.5, selCritScore: 80 }]){
    const got = new Set(E.MOVIES.filter(m => E.matchesCriteria(m, missionCase(overrides))));
    assert.equal(got.size, open.size,
      `${JSON.stringify(overrides)}: setting a retired dial changed the matching set, ${open.size} → ${got.size}`);
  }
});

test("with every requirement off, admission is exactly as if the block were not there", () => {
  const open = new Set(E.MOVIES.filter(m => E.matchesCriteria(m, missionCase())));
  const reopened = new Set(E.MOVIES.filter(m => E.matchesCriteria(m, missionCase({
    selCrowd: 0, selCritScore: 0, selAwards: 0, selScale: 0, selBuzz: 0, cinemaReleaseOnly: false, scoreFloor: 0,
  }))));
  assert.equal(reopened.size, open.size,
    `every requirement off should equal the open set (${open.size}), got ${reopened.size}`);
  for(const m of open) assert.ok(reopened.has(m), `${m.title} is in the open set but not the all-off set`);
});

test("every zero stop reads Off, and the Cinema Release control drops \"Only\"", () => {
  assert.equal(E.CRIT_MARKS[0].label, "Off", `Critics score's zero stop reads "${E.CRIT_MARKS[0].label}"`);
  assert.equal(E.AWARD_STOPS[0].label, "Off", `Awards' zero stop reads "${E.AWARD_STOPS[0].label}"`);
  assert.equal(E.SCALE_REF[0].label, "Off", `Budget's zero stop reads "${E.SCALE_REF[0].label}"`);
  assert.equal(E.BUZZ_STOPS[0].label, "Off", `Buzz's zero stop reads "${E.BUZZ_STOPS[0].label}"`);
  assert.equal(E.voteReadout(0), "Off", `People's vote's zero stop reads "${E.voteReadout(0)}"`);
  for(const arr of [E.CRIT_MARKS, E.AWARD_STOPS, E.SCALE_REF, E.BUZZ_STOPS])
    for(const stop of arr) assert.ok(!/^Any( size)?$/.test(stop.label),
      `a Mission dial stop still reads "${stop.label}"`);
  assert.equal(E.critScoreReadout(0), "Off", `critScoreReadout(0) reads "${E.critScoreReadout(0)}"`);
  assert.equal(E.scaleReadout(0), "Off", `scaleReadout(0) reads "${E.scaleReadout(0)}"`);

  const src = fs.readFileSync(path.join(ROOT, "app_template.html"), "utf8");
  const anchor = src.indexOf('id="onbCinemaRelease"');
  assert.ok(anchor >= 0, "the Cinema Release control markup was not found");
  const cinemaBlock = src.slice(anchor, anchor + 400);
  assert.ok(!/Only movies/i.test(cinemaBlock), "the Cinema Release control still reads \"Only movies\"");
  assert.ok(/Had a cinema release/i.test(cinemaBlock),
    "the Cinema Release control does not read \"Had a cinema release\"");
});

// ---- 10b. ADMISSION IS ONE SCORE FLOOR PLUS AND REQUIREMENTS, NOT AN OR BLOCK (CAS-724) -------------------
// CAS-724 deletes the CAS-661 Mission OR block. Admission is now cascadeScore(m) >= c.scoreFloor AND every
// requirement below (Budget, Awards, How far back, Had a cinema release), all ANDed, none optional.

// AC4: the Budget requirement's tri-state survives exactly as CAS-238/CAS-674 established for an AND-style
// gate — `null` (no budget AND no worldwide gross) rides along and never denies, at every rung. Only a KNOWN,
// strictly-below-floor match denies.
// scoreFloor:0 is pinned on every case below alongside selScale — otherwise normCascade's own one-time
// migration (legacyMissionFloorDefault) would read the very selScale these cases are setting as a legacy
// cinema Mission dial and derive a non-zero floor from it, contaminating a test about the Budget requirement
// alone with the separate score-floor gate.
test("CAS-724 AC4: the Budget requirement's tri-state survives — an unknown scale is never denied", () => {
  const unknown = E.MOVIES.find(m => !(m.budget > 0) && !(m.worldwide_gross > 0)
    && E.matchesCriteria(m, missionCase()));
  assert.ok(unknown, "no unknown-scale film clearing the open baseline — this test would prove nothing");
  for(const floor of E.SCALE_REF.map(r => r.d).filter(Boolean)){
    assert.equal(E.matchesCriteria(unknown, missionCase({ selScale: floor, scoreFloor: 0 })), true,
      `${unknown.title} carries no budget or gross and was still denied by a $${floor} Budget requirement`);
  }
  // and the requirement is real: a KNOWN below-floor budget still denies.
  const above = E.MOVIES.find(m => m.budget >= 100e6 && E.matchesCriteria(m, missionCase()));
  const below = E.MOVIES.find(m => m.budget > 0 && m.budget < 100e6 && E.matchesCriteria(m, missionCase()));
  assert.ok(above && below, "need both an above-floor and a below-floor budgeted film to test the requirement is real");
  assert.equal(E.matchesCriteria(above, missionCase({ selScale: 100e6, scoreFloor: 0 })), true,
    `${above.title} at $${above.budget} (>= floor) did not clear the Budget requirement`);
  assert.equal(E.matchesCriteria(below, missionCase({ selScale: 100e6, scoreFloor: 0 })), false,
    `${below.title} at $${below.budget} (< floor) cleared the Budget requirement`);
});

// AC3: the Awards requirement is reachable today only inside matchesCriteria's !preRelease branch — the
// ticket's own "trap". A pre-release, unawarded film clearing the open baseline must still list once Awards
// is set; this fails the moment the exemption is dropped.
test("CAS-724 AC3: the Awards requirement exempts a film that hasn't been judged yet (upcoming/in_cinema)", () => {
  const open = missionCase();
  const candidate = E.MOVIES.find(m => E.matchesCriteria(m, open) && isPreRelease(m) && E.awardRank(m) === 0);
  assert.ok(candidate, "no pre-release, unawarded film clearing the open baseline — this test would prove nothing");
  const withAwards = missionCase({ selAwards: 2 });
  assert.equal(E.matchesCriteria(candidate, withAwards), true,
    `${candidate.title}: pre-release, unawarded film was excluded by the Awards requirement, which must exempt pre-release`);
  // and the requirement is real once released: a released, unawarded film IS denied by the same setting.
  const released = E.MOVIES.find(m => E.matchesCriteria(m, open) && !isPreRelease(m) && E.awardRank(m) === 0);
  if(released) assert.equal(E.matchesCriteria(released, withAwards), false,
    `${released.title}: released, unawarded film cleared the Awards requirement`);
});

// AC2: for every agent and film, listedBy(m,c) implies cascadeScore(m) >= c.scoreFloor. No exceptions —
// checked both across the real preset/lane matrix (CASES) and directly against matchesCriteria with a custom
// floor, since listedBy narrows further (window/pin state) and must not be the only place this holds.
test("CAS-724 AC2: no listed film's Cascade score is below its own agent's scoreFloor — no exceptions", () => {
  for(const { kind, s, label } of CASES){
    pickInLane(E, kind, s.key);
    const d = E.onbApply();
    const listed = E.MOVIES.filter(m => E.listedBy(m, d));
    for(const m of listed) assert.ok(E.cascadeScore(m) >= d.scoreFloor,
      `${label}: ${m.title} lists at Cascade score ${E.cascadeScore(m)}, below its own agent's floor ${d.scoreFloor}`);
  }
  const floored = missionCase({ scoreFloor: 70 });
  const scoredBelow = E.MOVIES.filter(m => { const s = E.cascadeScore(m); return s >= 0 && s < 70; });
  assert.ok(scoredBelow.length > 0, "no film scored below 70 in the fixture catalogue — this test would prove nothing");
  for(const m of scoredBelow) assert.equal(E.matchesCriteria(m, floored), false,
    `${m.title} scores ${E.cascadeScore(m)}, below the agent's floor of 70, but still matched`);
  // and rule 4: a film with no Cascade score at all is never admitted, even at the most permissive floor (0).
  const unscored = E.MOVIES.find(m => E.cascadeScore(m) === -1 && E.matchesCriteria(m, missionCase(), undefined, true));
  if(unscored) assert.equal(E.matchesCriteria(unscored, missionCase({ scoreFloor: 0 })), false,
    `${unscored.title} has no Cascade score but was admitted at a floor of 0`);
});

// AC6: raising any single requirement never increases what an agent lists — asserted over the live MOVIES
// array (via listedBy, not just matchesCriteria) for a sweep of selScale stops, across the real preset/lane
// matrix. This is a general property of AND-only admission, not something special-cased per dial.
test("CAS-724 AC6: raising the Budget requirement never increases what an agent lists, for any agent", () => {
  const stops = E.SCALE_REF.map(r => r.d);
  for(const { kind, s, label } of CASES){
    pickInLane(E, kind, s.key);
    const base = E.onbApply();
    let prev = null;
    for(const floor of stops){
      const d = E.normCascade({ ...base, selScale: floor });
      const n = E.MOVIES.filter(m => E.listedBy(m, d)).length;
      if(prev !== null) assert.ok(n <= prev,
        `${label}: raising Budget to $${floor} took the listed count UP, ${prev} → ${n}`);
      prev = n;
    }
  }
});

// CAS-724 change item 6: scoreHeldBackCount is restated against c.scoreFloor rather than the retired
// Mission-dials target — and, since rule 4 (no score, never admitted) is now unconditional rather than only
// active "while a target is in force", the count is meaningful even at a floor of 0.
test("CAS-724: scoreHeldBackCount agrees with its own set, at any floor including 0", () => {
  const d = missionCase({ status: ["included_streaming", "pvod", "rental"], scoreFloor: 0 });
  const held = E.scoreHeldBackCount(d);
  const heldFilms = E.MOVIES.filter(m => E.cascadeScore(m) === -1
    && !E.listedBy(m, d) && E.listedBy(m, d, true));
  assert.equal(heldFilms.length, held, "scoreHeldBackCount disagrees with its own set");
  assert.ok(held > 0, "test setup: expected at least one unscored film held back to exercise the count");
  for(const m of heldFilms) assert.equal(E.listedBy(m, d), false,
    `${m.title} has no score but is still listed`);
});

// ---- 10b. THE CHOSEN SORT'S OWN COMPARATOR DECIDES THE ORDER (CAS-702) ------------------------------------
// CAS-699 stopped two guards silently overriding a chosen sort with the release timeline in In Cinema and
// Upcoming. That was not the whole defect: sortMoviesBy's own "cascade" case still read qScore, which is -1
// for virtually every real pre-release film (CAS-695 scores them off buzz, not People's
// vote/Critics) — so once the override was lifted, the "order" it revealed was really a tie-break
// (rating/popularity), not the Cascade score a person had just picked. Checked against ground truth built
// independently of listingOrder/sortForKey/sortMoviesBy — cascadeScore itself for one section+sort,
// alphabetical order (no scoring function at all) for the other — and as a monotonicity, not an exact
// sequence, because tied scores/titles are free to land in either relative order.
test("CAS-702: an explicit sort's own comparator decides the rendered order, In Cinema and Upcoming", () => {
  const cinema = E.MOVIES.filter(m => E.primaryStatus(m) === "in_cinema" && E.cascadeScore(m) >= 0);
  assert.ok(cinema.length > 3, `only ${cinema.length} scored in_cinema films — not enough to test an order against`);
  const rendered = E.listingOrder(cinema, "cascade", { kind: "cinema" }, true);
  for(let i = 1; i < rendered.length; i++){
    assert.ok(E.cascadeScore(rendered[i - 1]) >= E.cascadeScore(rendered[i]),
      `In Cinema under Cascade score: "${rendered[i - 1].title}" (${E.cascadeScore(rendered[i - 1])}) sits above "${rendered[i].title}" (${E.cascadeScore(rendered[i])})`);
  }

  const upcoming = E.MOVIES.filter(m => E.primaryStatus(m) === "upcoming");
  assert.ok(upcoming.length > 3, `only ${upcoming.length} upcoming films — not enough to test an order against`);
  const byTitle = E.listingOrder(upcoming, "title", { kind: "cinema" }, true);
  for(let i = 1; i < byTitle.length; i++){
    assert.ok(byTitle[i - 1].title.localeCompare(byTitle[i].title) <= 0,
      `Upcoming under Title: "${byTitle[i - 1].title}" sits above "${byTitle[i].title}"`);
  }
});

// ---- 11. LISTED NEVER EXCEEDS WHAT MATCHES (CAS-674 AC1) --------------------------------------------------
// listedCount (what an agent actually LISTS, via listedBy) is a NARROWING of countCriteria (the raw
// matchesCriteria haul) by window and pin/move state — it can never legitimately exceed it. This was
// violated for an agent watching a single narrow window with no listStatus singled out: listWindowOK's
// fallback ("list whatever the agent watches") read that through inScope's broader "still ahead of" test
// instead of an exact match against c.status, so a single-window agent could list films from windows
// matchesCriteria itself would reject.
test("listing never exceeds matching: listedCount(c) <= countCriteria(c), for every real preset", () => {
  for(const { kind, s, label } of CASES){
    pickInLane(E, kind, s.key);
    const d = E.onbApply();
    const lc = E.listedCount(d), cc = E.countCriteria(d);
    assert.ok(lc <= cc, `${label}: listedCount ${lc} exceeds countCriteria ${cc}`);
  }
});

test("listing never exceeds matching: holds for a single-window agent with no listStatus singled out (CAS-674 repro)", () => {
  const narrowVariants = [
    { kind:"cinema", status:["in_cinema"] },
    { kind:"stream", status:["included_streaming"] },
    { kind:"stream", status:["pvod","rental"] },
  ];
  for(const v of narrowVariants){
    const c = E.normCascade({ ...v }, {});
    assert.equal(c.listStatus.length, 0, `${JSON.stringify(v)}: expected no listStatus singled out for this repro`);
    const lc = E.listedCount(c), cc = E.countCriteria(c);
    assert.ok(lc <= cc, `${JSON.stringify(v)}: listedCount ${lc} exceeds countCriteria ${cc}`);
  }
});

// ---- 12. THE AGENTS ROW AND MISSION AGREE (CAS-674 AC4) ---------------------------------------------------
// Reproduces the reported case: a cinema agent set to Budget Studio floor + Buzz Trending must report the
// SAME count on the Agents row (agentMetricsCompute's "total", the deck card's "N listed") as on Mission
// (listedCount, what onbShownCount/stepCount print as "N films match right now"). Before CAS-674 the Agents
// row's comment already claimed "same test the listing itself runs" but the code read watchesFilm — the
// wider watch-ahead set — so the two screens quoted different numbers for one agent.
test("the Agents row and Mission report the same count for one agent (CAS-674 repro)", () => {
  const c = E.normCascade({ kind:"cinema", status:["upcoming","opening_week","in_cinema"],
    selScale:97e6, selBuzz:2 }, {});
  const agentsRowTotal = E.agentMetricsCompute(c).total;
  const missionCount = E.listedCount(c);
  assert.equal(agentsRowTotal, missionCount,
    `Agents row says ${agentsRowTotal} listed, Mission says ${missionCount} match right now`);
});

// ---- WATCH-LIST SELECTION LOADS ITS OWN RECORD (CAS-666) ------------------------------------------------
// deckSelect/wlRailCreate are the LIVE deck's own selection/creation paths — the ones that shipped without
// applyActiveWatchlist(), so the ymSvcOn/etc scratch state kept whichever list was previously open and
// ymPersist() then stamped those stale values into the newly selected list's own saved record.
// Records built or read back through the vm sandbox carry vm-realm Arrays, which deepStrictEqual (this
// file imports assert/strict) treats as unequal to a same-looking native array — every array assertion in
// data-integrity.test.mjs hits the same thing and spreads first; this does the same for a whole record.
// CAS-720: excludeTags dropped out of watchlistRecord() itself when the Watch screen's own exclude-tags
// editor was removed — the field still lives on the list record proper (untouched, still readable off
// `a`/`b` directly), it just no longer round-trips through the ymSvcOn-style scratch/record bridge.
const plainRecord = r => ({
  svcOn: [...r.svcOn], cascOff: [...r.cascOff], watchedOn: [...r.watchedOn],
  watchTiers: [...r.watchTiers], sort: r.sort,
});

function seedTwoLists(){
  E.watchLists.length = 0;
  const a = E.normWatchlistEntry({ name: "A", order: 0, svcOn: ["stream"], cascOff: ["only-a"] });
  const b = E.normWatchlistEntry({ name: "B", order: 1, svcOn: ["cinema", "rent"], cascOff: [] });
  E.watchLists.push(a, b);
  return { a, b };
}

test("CAS-666 AC1/AC3: selecting a list through the deck loads that list's own record, not the previous list's", () => {
  const { a, b } = seedTwoLists();
  E.setActiveWatchlist(a.id);
  E.applyActiveWatchlist();
  assert.deepEqual(plainRecord(E.watchlistRecord()), plainRecord(a),
    "list A's own record should load on activation");

  assert.ok(E.deckSelect(1), "deckSelect should report a real selection");
  assert.equal(E.watchActiveId, b.id, "deckSelect did not make list B active");
  assert.deepEqual(plainRecord(E.watchlistRecord()), plainRecord(b),
    "deckSelect must load list B's own stored record, not carry list A's scratch state over");

  // AC3: switching back to B must not have overwritten A's own stored record with B's settings.
  // CAS-677: watchedOn defaults to every WATCH_STEPS key (permissive) now, not [] — read off
  // watchlistDefaults() itself rather than hardcode the step keys here.
  assert.deepEqual(plainRecord(a),
    { svcOn: ["stream"], cascOff: ["only-a"], watchedOn: [...E.watchlistDefaults().watchedOn], watchTiers: [], sort: null },
    "list A's stored record must be unchanged by selecting list B");
});

test("CAS-666 AC2: creating a list through the deck gets watchlistDefaults(), not the previously active list's settings", () => {
  const { a } = seedTwoLists();
  E.setActiveWatchlist(a.id);
  E.applyActiveWatchlist();
  assert.equal(E.watchlistRecord().svcOn.join(","), a.svcOn.join(","), "sanity: A's scratch state is loaded");

  E.wlRailCreate();
  assert.notEqual(E.watchActiveId, a.id, "wlRailCreate must make the new list active, not keep A active");
  assert.deepEqual(plainRecord(E.watchlistRecord()), plainRecord(E.watchlistDefaults()),
    "a freshly created list must carry watchlistDefaults(), not list A's svcOn/cascOff");
});

// ---- WATCHED VERDICTS ARE PERMISSIVE BY DEFAULT, AND A RESTRICTIVE STORED VALUE IS MIGRATED UP (CAS-677) ---
// The editor UI that used to write ymWatchedOn (the five "Films I've watched" tickboxes) is gone — the
// Watched control in the listing and the scope bar are now the only places that state lives. So
// watchlistDefaults().watchedOn has to stop meaning "exclude every watched film" ([]) and start meaning
// "exclude none" (every WATCH_STEPS key), and any list already holding a narrower value has to be widened
// on load, or that list would be permanently stuck with no UI left that can change it.
test("CAS-677 AC6: watchlistDefaults().watchedOn contains every WATCH_STEPS key", () => {
  // Spread WATCH_STEPS itself first — mapping it directly would call the vm realm's own Array.prototype.map,
  // which returns a vm-realm array that deepStrictEqual treats as unequal to a same-looking native one (see
  // plainRecord's own comment above for the same gotcha).
  const keys = [...E.WATCH_STEPS].map(s => s.key);
  const d = E.watchlistDefaults();
  assert.deepEqual([...d.watchedOn].sort(), keys.sort(),
    "a newly created list must exclude no film on watched grounds");
});

test("CAS-677 AC7: normWatchlist migrates a restrictive stored watchedOn to the permissive default on load", () => {
  const permissive = [...E.watchlistDefaults().watchedOn].sort();

  const restrictive = E.normWatchlistEntry({ name: "restrictive", order: 0, watchedOn: ["wow"] });
  assert.deepEqual([...restrictive.watchedOn].sort(), permissive,
    "a narrower stored watchedOn must be migrated up to the permissive set");

  const legacyEmpty = E.normWatchlistEntry({ name: "legacy", order: 0, watchedOn: [] });
  assert.deepEqual([...legacyEmpty.watchedOn].sort(), permissive,
    "the old [] default (exclude every watched film) must migrate to the permissive set too");

  const alreadyPermissive = E.normWatchlistEntry({ name: "already", order: 0, watchedOn: permissive.slice() });
  assert.deepEqual([...alreadyPermissive.watchedOn].sort(), permissive,
    "an already-permissive stored value must be kept as-is");
});

// (More CAS-677 tests — AC3/AC4/AC9, which need the CAS-680 section's seedNCascades/withCas680List helpers —
// live further down, right after the CAS-680 tests those helpers were built for.)

// ---- AGENT TICK AND ACTIVE SET STAY IN STEP (CAS-673) ------------------------------------------------------
// ymCascToggle/ymCascSetAll mutate the live scratch Set ymCascOff and then re-derive activeIds via
// syncActiveIdsFromActiveList(). That function used to re-derive from the PERSISTED record (list.cascOff),
// which ymPersist only writes behind ymSchedulePersist's 300ms debounce (CAS-652) — so reading it back
// immediately after a tick returned the state from BEFORE that tick. These tests assert the fix
// synchronously, with no timer ever run, mirroring the ACs' own wording.
function seedNCascades(n){
  const ids = [];
  for(let i = 0; i < n; i++){
    const c = E.normCascade({ kind: "stream", status: [] });
    c.id = `cas673-test-cascade-${i}`;
    c.name = `CAS-673 Agent ${i}`;
    E.cascades.push(c);
    ids.push(c.id);
  }
  return ids;
}
function unseedCascades(ids){
  ids.forEach(id => {
    const i = E.cascades.findIndex(c => c.id === id);
    if(i >= 0) E.cascades.splice(i, 1);
  });
}
// Every test below needs a fresh single active list with every seeded agent ticked in, and must leave
// watchLists exactly as it found them so later tests in this file are unaffected.
function withCas673List(ids, fn){
  const savedLists = E.watchLists.slice();
  const savedActive = E.watchActiveId;
  try {
    const l = E.normWatchlistEntry({ name: "CAS-673 list", order: 0, cascOff: [] });
    E.watchLists.length = 0;
    E.watchLists.push(l);
    E.setActiveWatchlist(l.id);
    E.applyActiveWatchlist();
    fn(l);
  } finally {
    E.watchLists.length = 0;
    savedLists.forEach(sl => E.watchLists.push(sl));
    E.setActiveWatchlist(savedActive);
    E.applyActiveWatchlist();
  }
}

test("CAS-673 AC1: activeCascades() matches ymCascTicked immediately after ymCascToggle, no timer elapsed", () => {
  const ids = seedNCascades(6);
  try {
    withCas673List(ids, () => {
      // Reproduce the exact reported case: six agents, then untick two.
      E.ymCascToggle(ids[4]);
      E.ymCascToggle(ids[5]);

      const tickedIds = E.cascades.filter(E.ymCascTicked).map(c => c.id);
      const activeCascadeIds = E.activeCascades().map(c => c.id);
      assert.deepEqual(new Set(activeCascadeIds), new Set(tickedIds),
        "activeCascades() must contain exactly the ticked agents right after ymCascToggle returns");
      assert.deepEqual(new Set(E.activeIds), new Set(tickedIds),
        "activeIds must match ymCascTicked right after ymCascToggle returns");
      assert.ok(!activeCascadeIds.includes(ids[4]) && !activeCascadeIds.includes(ids[5]),
        "the two just-unticked agents must not be in the active set");

      // Re-ticking one must bring it straight back in, again with no timer elapsed.
      E.ymCascToggle(ids[4]);
      assert.ok(E.activeCascades().map(c => c.id).includes(ids[4]),
        "re-ticking an agent must be reflected immediately");
    });
  } finally {
    unseedCascades(ids);
  }
});

test("CAS-673 AC2: the same holds immediately after ymCascSetAll(true) and ymCascSetAll(false)", () => {
  const ids = seedNCascades(6);
  try {
    withCas673List(ids, () => {
      E.ymCascSetAll(false);
      assert.equal(E.activeCascades().length, 0, "ymCascSetAll(false) must clear the active set immediately");
      assert.equal(E.activeIds.length, 0, "activeIds must be empty immediately after ymCascSetAll(false)");

      E.ymCascSetAll(true);
      assert.deepEqual(new Set(E.activeCascades().map(c => c.id)), new Set(ids),
        "ymCascSetAll(true) must restore every agent to the active set immediately");
      assert.deepEqual(new Set(E.activeIds), new Set(ids),
        "activeIds must hold every agent immediately after ymCascSetAll(true)");
    });
  } finally {
    unseedCascades(ids);
  }
});

test("CAS-673 AC4: the single-agent empty state never names an agent unticked in the active list", () => {
  const ids = seedNCascades(2);
  try {
    withCas673List(ids, () => {
      E.ymCascToggle(ids[0]);   // one agent left ticked
      const acs = E.activeCascades();
      assert.equal(acs.length, 1, "sanity: exactly one agent should remain active");
      assert.equal(acs[0].id, ids[1], "the ticked agent, not the just-unticked one, must be the sole active agent");

      const html = E.emptyResultsHTML();
      const uncheckedName = E.cascades.find(c => c.id === ids[0]).name;
      assert.ok(!html.includes(uncheckedName),
        "the empty state must never name an agent unticked in the active list");
    });
  } finally {
    unseedCascades(ids);
  }
});

// ---- WATCH LIST EDIT DEFERS THE DECK, NOT JUST DEBOUNCES IT (CAS-676) -------------------------------------
// CAS-652 already coalesced a burst of taps into one rAF; the delay persisted because that one rAF still
// paid for renderYourMovies()+render() — a whole-catalogue re-derive of two screens #leScreen (a
// full-viewport modal, CAS-676's own comment at ymScheduleRender) covers and hides. The fix defers both to
// leClose(); this only re-checks the coalescing property CAS-673 already covers (activeIds stays live).
// AC4 is checked below by spying on MOVIES.filter (leInnerHTML's own per-agent listedCount pass, and
// render()'s recomputeFound/scopeRows, both funnel through it) — an own-property shadow on the live array,
// since the engine's code closes over that exact object, not a copy this test could intercept any other way.
async function flushRaf(){ await new Promise(r => setTimeout(r, 0)); }
async function withMoviesFilterSpy(fn){
  let calls = 0;
  E.MOVIES.filter = function(...args){ calls++; return Array.prototype.filter.apply(this, args); };
  try { await fn(); } finally { delete E.MOVIES.filter; }
  return calls;
}
// render() (which leClose() calls to pay off ymDeckStale) ends in recomputeFound() -> trackFirstFound(),
// which DELETES every firstFound entry not in the just-recomputed `found` set and re-notify-arms the rest —
// global ledgers, rewritten here against these tests' throwaway cascades/watchlist rather than a person's
// real ones. Snapshot and restore both around any call that can reach leClose() with fake data still active,
// so this file's other tests (CAS-671/668 seed firstFound directly and expect it untouched) never see it.
async function withFoundLedgersSnapshot(fn){
  const firstFoundSnap = JSON.parse(JSON.stringify(E.firstFound));
  const notifySnap = JSON.parse(JSON.stringify(E.notify));
  try { return await fn(); }
  finally {
    Object.keys(E.firstFound).forEach(k => delete E.firstFound[k]);
    Object.assign(E.firstFound, firstFoundSnap);
    Object.keys(E.notify).forEach(k => delete E.notify[k]);
    Object.assign(E.notify, notifySnap);
  }
}
function seedCas676List(ids){
  const savedLists = E.watchLists.slice();
  const savedActive = E.watchActiveId;
  const l = E.normWatchlistEntry({ name: "CAS-676 list", order: 0, cascOff: [] });
  E.watchLists.length = 0;
  E.watchLists.push(l);
  E.setActiveWatchlist(l.id);
  E.applyActiveWatchlist();
  return () => {
    E.watchLists.length = 0;
    savedLists.forEach(sl => E.watchLists.push(sl));
    E.setActiveWatchlist(savedActive);
    E.applyActiveWatchlist();
  };
}

test("CAS-676 AC2/AC3: the deck and Your Movies are never rebuilt while the Edit screen covers them", async () => {
  const ids = seedNCascades(6);
  const restore = seedCas676List(ids);
  try {
    await withFoundLedgersSnapshot(async () => {
      assert.equal(E.leOn, false, "sanity: the Edit screen starts closed");
      E.leOpen();
      assert.equal(E.ymDeckStale, false, "opening must not itself owe a deferred rebuild");
      E.ymCascToggle(ids[0]);
      await flushRaf();
      assert.equal(E.ymDeckStale, true,
        "a tap taken while the Edit screen is open must defer the deck/Your-Movies rebuild, not skip it outright");
      E.leClose();
      assert.equal(E.ymDeckStale, false, "closing must pay the deferred rebuild it owed and clear the flag");
    });
  } finally {
    if(E.leOn) E.leClose();
    restore();
    unseedCascades(ids);
  }
});

// CAS-693 superseded this test's original premise (that ANY tap, casc included, must run at least one
// MOVIES.filter pass): an agent's own include toggle never changes which films any agent lists, only which
// of those already-known memberships get summed, so leComputeCounts()'s per-open cache lets a casc burst
// cost ZERO catalogue passes once it's warm — strictly better than "one pass per burst, not one per tap".
// Availability chips DO change film membership (ymListBaseOK), so a svc burst still has to invalidate and
// rebuild — the "one pass per burst" coalescing CAS-676 introduced still has to hold for that case.
test("CAS-676 AC4 / CAS-693: a casc-toggle burst costs zero catalogue passes once the cache is warm; a cache-invalidating (svc) burst still costs exactly one, not one per tap", async () => {
  const ids = seedNCascades(6);
  const restore = seedCas676List(ids);
  try {
    await withFoundLedgersSnapshot(async () => {
      E.leOpen();   // warms leComputeCounts()'s cache
      const cascBurstCalls = await withMoviesFilterSpy(async () => {
        E.ymCascToggle(ids[0]); E.ymCascToggle(ids[1]); E.ymCascToggle(ids[2]);
        await flushRaf();
      });
      E.leClose();
      assert.equal(cascBurstCalls, 0,
        `a 3-tap agent-include burst cost ${cascBurstCalls} MOVIES.filter pass(es) against the cache's own 0 — ` +
        `toggling which agents are ticked must never re-scan the catalogue`);

      E.leOpen();
      const svcSingleCalls = await withMoviesFilterSpy(async () => {
        E.ymSvcToggle("stream");
        await flushRaf();
      });
      E.leClose();

      E.leOpen();
      const svcBurstCalls = await withMoviesFilterSpy(async () => {
        E.ymSvcToggle("stream"); E.ymSvcToggle("cinema"); E.ymSvcToggle("upcoming");
        await flushRaf();
      });
      E.leClose();

      assert.ok(svcSingleCalls > 0, "sanity: a cache-invalidating tap (an availability chip) must still run the count pass");
      assert.equal(svcBurstCalls, svcSingleCalls,
        `a 3-tap svc burst cost ${svcBurstCalls} MOVIES.filter pass(es) against a single tap's ${svcSingleCalls} — ` +
        `cache-invalidating toggles must still coalesce to one rebuild per burst, not one per tap`);
    });
  } finally {
    if(E.leOn) E.leClose();
    restore();
    unseedCascades(ids);
  }
});

// ---- WATCH LIST EDIT COUNTS DESCRIBE THE LIST, NOT THE AGENT OR A GLOBAL VIEW (CAS-680) -------------------
// Reported case: a list with one availability chip and three of six agents ticked showed a header of 113, per-
// agent figures of 132/4/15 (listedCount(c) — the agent's OWN global total, none of the list's own filters
// applied) and a rendered listing of 34. Part 1: the per-agent figure must answer a question about the LIST
// (ymAgentListCount, same basis ymFeedList() uses), so a single ticked agent's figure can never legitimately
// disagree with the header. Part 2 (Lee's option C, 2026-08-28): the header/rendered gap itself is not a bug —
// it is the scope bar (#scopeBar, CAS-586), which is deliberately list-independent — so ymFeedList() must go on
// ignoring it while scopeRows() goes on applying it.
function withCas680List(ids, fn){
  const savedLists = E.watchLists.slice();
  const savedActive = E.watchActiveId;
  const savedSvc = new Set(E.ymSvcOn);
  try {
    const l = E.normWatchlistEntry({ name: "CAS-680 list", order: 0, cascOff: ids.slice() });
    E.watchLists.length = 0;
    E.watchLists.push(l);
    E.setActiveWatchlist(l.id);
    E.applyActiveWatchlist();
    fn(l);
  } finally {
    E.watchLists.length = 0;
    savedLists.forEach(sl => E.watchLists.push(sl));
    E.setActiveWatchlist(savedActive);
    E.applyActiveWatchlist();
    E.ymSvcSetAll(false);
    savedSvc.forEach(k => E.ymSvcToggle(k));
  }
}

test("CAS-680 AC1/AC2: with exactly one agent ticked, its per-agent figure equals the header figure, for every agent and every availability-chip combination", () => {
  const ids = seedNCascades(6);
  try {
    withCas680List(ids, () => {
      const chipCombos = [["stream"], ["cinema", "stream"], E.YM_SVC.map(s => s.key), ["upcoming"]];
      for(const combo of chipCombos){
        E.ymSvcSetAll(false);
        combo.forEach(k => E.ymSvcToggle(k));
        for(const id of ids){
          E.ymCascSetAll(false);
          E.ymCascToggle(id);
          const c = E.cascades.find(x => x.id === id);
          const header = E.ymFeedList().length;
          const perAgent = E.ymAgentListCount(c);
          assert.equal(perAgent, header,
            `chips [${combo.join("+")}], agent ${id}: header says ${header} but the per-agent figure says ${perAgent}`);
        }
      }
    });
  } finally {
    unseedCascades(ids);
  }
});

// CAS-718: the Watch screen's own scope bar (WATCH ON/For review/Watched pills) is retired — CAS-717's
// tabs already narrow by watch level, so Watch On/For review need no replacement, and Watched moves into
// the new per-tab Filters sheet (watchWatchedSel, applied by render() via filmMatchesWatchedFilter — see
// its own comment). scopeRows() itself no longer narrows by any of this; it stays list/agent-matching only.
// inFindScope/scope/scopeVerdicts/scopeTiers are left defined and still drive leInnerHTML's own preview
// (leComputeCounts), which this ticket does not touch.
test("CAS-680/CAS-718 AC7: ymFeedList() still ignores per-tab Watched filtering, and scopeRows() no longer applies any of it", () => {
  const ids = seedNCascades(3);
  try {
    withCas680List(ids, () => {
      E.ymCascSetAll(true);
      E.ymSvcSetAll(true);           // every availability window counts, for the widest possible match
      const list = E.ymFeedList();
      assert.ok(list.length > 0, "sanity: the reproduction must match at least one film");

      const target = list[0];
      const wasWatched = E.watched.has(target.tmdb_id);
      E.watched.add(target.tmdb_id);
      const savedSel = new Set(E.watchWatchedSel[E.watchTab]);
      try {
        E.watchWatchedSel[E.watchTab].clear();   // CAS-718 default: nothing selected, tagged-out films hidden
        assert.equal(E.filmMatchesWatchedFilter(target), false,
          "a watched film must fail filmMatchesWatchedFilter under the default (empty) Watched selection");

        const stillMatches = E.ymFeedList();
        assert.ok(stillMatches.some(m => m.tmdb_id === target.tmdb_id),
          "ymFeedList() must still carry that same film — it never applies watchWatchedSel/filmMatchesWatchedFilter");

        const rows = E.scopeRows();
        assert.ok(rows.some(m => m.tmdb_id === target.tmdb_id),
          "scopeRows() must no longer drop a watched film itself — Watched narrowing is render()'s own per-tab step now, not scopeRows()'s");
      } finally {
        E.watchWatchedSel[E.watchTab].clear();
        savedSel.forEach(k => E.watchWatchedSel[E.watchTab].add(k));
        if(!wasWatched) E.watched.delete(target.tmdb_id);
      }
    });
  } finally {
    unseedCascades(ids);
  }
});

// ---- WATCH LIST EDIT'S COUNTS SURVIVE THE SINGLE-PASS REWRITE (CAS-693) ------------------------------------
// leInnerHTML used to call ymFeedList() once and ymAgentListCount(c) once per agent — a fresh full-catalogue
// MOVIES.filter for each. leComputeCounts() replaces all of that with one pass. This asserts the new
// single-pass figures still agree with the old per-predicate formulas, and that leInnerHTML's actual HTML
// output carries exactly those figures — not just that the helper function returns the right numbers.
test("CAS-693 AC2: leComputeCounts's single pass agrees with the old per-agent/header formulas, and leInnerHTML renders exactly those figures", () => {
  const ids = seedNCascades(4);
  try {
    withCas680List(ids, () => {
      const chipCombos = [["stream"], ["cinema", "stream"], E.YM_SVC.map(s => s.key), []];
      for(const combo of chipCombos){
        E.ymSvcSetAll(false);
        combo.forEach(k => E.ymSvcToggle(k));
        E.ymCascSetAll(false);
        ids.forEach((id, i) => { if(i % 2 === 0) E.ymCascToggle(id); });   // a mixed ticked/unticked set

        const list = E.ymFeedList();
        const expectedN = list.length;
        const expectedScoped = list.filter(E.inFindScope).length;
        const expectedCascOn = E.cascades.filter(E.ymCascTicked).length;

        const actual = E.leComputeCounts();
        assert.equal(actual.n, expectedN, `chips [${combo.join("+")}]: n`);
        assert.equal(actual.scoped, expectedScoped, `chips [${combo.join("+")}]: scoped`);
        assert.equal(actual.cascOn, expectedCascOn, `chips [${combo.join("+")}]: cascOn`);
        for(const id of ids){
          const c = E.cascades.find(x => x.id === id);
          assert.equal(actual.counts.get(id), E.ymAgentListCount(c),
            `chips [${combo.join("+")}], agent ${id}: single-pass count must match ymAgentListCount`);
        }

        const html = E.leInnerHTML();
        const countMatch = html.match(/id="leCount"[^>]*>([\s\S]*?)<\/div>/);
        assert.ok(countMatch, "sanity: header count line must render");
        const nums = [...countMatch[1].matchAll(/<b>(\d+)<\/b>/g)].map(m => Number(m[1]));
        assert.equal(nums[0], expectedN, `chips [${combo.join("+")}]: rendered header n`);
        if(nums.length > 1) assert.equal(nums[1], expectedScoped, `chips [${combo.join("+")}]: rendered header scoped`);

        const cascOnMatch = html.match(/id="leCascOn"[^>]*>·\s*(\d+) of (\d+)/);
        assert.ok(cascOnMatch, "sanity: agents-ticked count must render");
        assert.equal(Number(cascOnMatch[1]), expectedCascOn, `chips [${combo.join("+")}]: rendered cascOn`);

        const matchLineMatch = html.match(/id="leMatch"[^>]*>(\d+)/);
        assert.ok(matchLineMatch, "sanity: N films match line must render");
        assert.equal(Number(matchLineMatch[1]), expectedN, `chips [${combo.join("+")}]: rendered lematch`);

        for(const id of ids){
          const c = E.cascades.find(x => x.id === id);
          const rowMatch = html.match(new RegExp(`id="le-cnt-${id}"[^>]*>(\\d+)`));
          assert.ok(rowMatch, `sanity: agent ${id}'s own count must render`);
          assert.equal(Number(rowMatch[1]), E.ymAgentListCount(c), `chips [${combo.join("+")}], agent ${id}: rendered row count`);
        }
      }
    });
  } finally {
    unseedCascades(ids);
  }
});

test("CAS-677 AC4/AC9: ymWatchedOn still gates ymFeedMatches exactly as before — only its default population changed", () => {
  const ids = seedNCascades(1);
  try {
    withCas680List(ids, () => {
      E.ymCascSetAll(true);
      E.ymSvcSetAll(true);
      const list = E.ymFeedList();
      assert.ok(list.length > 0, "sanity: the reproduction must match at least one film");
      const target = list[0];
      const wasWatched = E.watched.has(target.tmdb_id);
      E.watched.add(target.tmdb_id);   // opinionOf(target) -> "liked" once no other verdict is set
      const savedWatchedOn = new Set(E.ymWatchedOn);
      try {
        E.ymWatchedOn.clear();         // simulate the old restrictive default
        assert.ok(!E.ymFeedList().some(m => m.tmdb_id === target.tmdb_id),
          "a watched film whose verdict is not in ymWatchedOn must still fail ymFeedList's own ymFeedMatches gate");

        E.ymWatchedOn.add("liked");
        assert.ok(E.ymFeedList().some(m => m.tmdb_id === target.tmdb_id),
          "adding the matching verdict back to ymWatchedOn must let the film back in — the predicate itself is untouched");
      } finally {
        E.ymWatchedOn.clear();
        savedWatchedOn.forEach(k => E.ymWatchedOn.add(k));
        if(!wasWatched) E.watched.delete(target.tmdb_id);
      }
    });
  } finally {
    unseedCascades(ids);
  }
});

test("CAS-677 AC3: the watch list Edit screen no longer renders verdict tickboxes or the Films I've watched heading", () => {
  const ids = seedNCascades(1);
  try {
    withCas680List(ids, () => {
      const html = E.leInnerHTML();
      assert.ok(!html.includes("Films I've watched"), "the removed heading must not render");
      assert.ok(!html.includes("ymverdicts"), "the removed verdict-tickbox wrapper must not render");
      assert.ok(!html.includes("ymVerdictToggle") && !html.includes("ymVerdictSetAll"),
        "no control should still wire to the removed verdict toggles");
    });
  } finally {
    unseedCascades(ids);
  }
});

test("CAS-677 AC1: the scope bar defaults to Notify and For review on, Watched off", () => {
  // scope is a session-only module object — never persisted (see its own comment) — so this literal IS the
  // state both a brand-new list and a user who has never touched the bar land on.
  assert.deepEqual({ watch: E.scope.watch, new: E.scope.new, watched: E.scope.watched },
    { watch: true, new: true, watched: false });
});

test("CAS-718 AC (was CAS-677 AC8): selecting a verdict in the Filters sheet's Watched section surfaces that watched film, per tab", () => {
  const ids = seedNCascades(1);
  try {
    withCas680List(ids, () => {
      E.ymCascSetAll(true);
      E.ymSvcSetAll(true);
      const list = E.ymFeedList();
      assert.ok(list.length > 0, "sanity: the reproduction must match at least one film");
      const target = list[0];
      const wasWatched = E.watched.has(target.tmdb_id);
      E.watched.add(target.tmdb_id);           // opinionOf -> "liked"
      const tab = E.watchTab;
      const savedSel = new Set(E.watchWatchedSel[tab]);
      try {
        E.watchWatchedSel[tab].clear();
        assert.ok(!E.filmMatchesWatchedFilter(target),
          "sanity: with nothing selected in Watched, the watched film must not pass the filter");

        E.watchWatchedSel[tab].add(E.opinionOf(target.tmdb_id));
        assert.ok(E.filmMatchesWatchedFilter(target),
          "with its own verdict selected in Watched, the watched film must pass the filter");
      } finally {
        E.watchWatchedSel[tab].clear();
        savedSel.forEach(k => E.watchWatchedSel[tab].add(k));
        if(!wasWatched) E.watched.delete(target.tmdb_id);
      }
    });
  } finally {
    unseedCascades(ids);
  }
});

// ---- MOVING NEVER RENDERS A PROVISIONAL LEDGER (CAS-667) -------------------------------------------------
// movingData() branches on window.CascadePersistence.accountActive() — flip window.CascadeAuth's real fields
// (enabled/client/session) the same way sign-in for real does, rather than a stand-in predicate, so the
// signed-in branch runs through the exact same check the shipped code runs.
function setSignedIn(signedIn){
  const auth = E.CascadeAuth;
  auth.enabled = signedIn;
  auth.client = signedIn ? {} : null;
  auth.session = signedIn ? { user: { id: "cas667-test-user" } } : null;
  // CAS-670: the guest branch itself now keys off cascade_had_account, not accountActive() — set it the same
  // way the real cascade-auth-change listener does so these tests still simulate a signed-in device faithfully.
  E.localStorage.setItem("cascade_had_account", signedIn ? "1" : "0");
}

test("CAS-667 AC1: a signed-in device with the alerts ledger unresolved renders nothing, never the guest ledger", () => {
  const film = E.MOVIES[0];
  E.realAlerts.length = 0;
  E.firstFound[String(film.tmdb_id)] = new Date().toISOString();
  setSignedIn(true);
  E.setMovingReady(false);

  const { canRows, newRows, changedRows } = E.movingData();
  assert.equal(canRows.length, 0, "unresolved ledger must not render can-watch rows");
  assert.equal(newRows.length, 0, "unresolved ledger must not fall back to the guest firstFound ledger");
  assert.equal(changedRows.length, 0, "unresolved ledger must not render changed rows");

  delete E.firstFound[String(film.tmdb_id)];
  setSignedIn(false);
  E.setMovingReady(true);
});

test("CAS-667 AC2: opening Moving before and after the ledger resolves ends on the same row set", () => {
  const film = E.MOVIES[0];
  setSignedIn(true);
  E.realAlerts.length = 0;
  E.realAlerts.push({ id: 1, movie_id: film.tmdb_id, moment: "announced_stream", title: film.title,
    cascade_name: "Test agent", emailed_at: new Date().toISOString(), read_at: null });

  // Landing on Moving before the account answer comes back — the reported symptom.
  E.setMovingReady(false);
  const beforeReady = E.movingData();
  assert.equal([...beforeReady.canRows, ...beforeReady.newRows, ...beforeReady.changedRows].length, 0,
    "still-unresolved ledger must render nothing on the landing-screen open");

  // Same visit, once loadRealAlerts has actually answered.
  E.setMovingReady(true);
  const afterReady = E.movingData();
  const afterIds = [...afterReady.canRows, ...afterReady.newRows, ...afterReady.changedRows].map(r => r.filmId);
  assert.deepEqual(afterIds, [String(film.tmdb_id)],
    "once ready, movingData must reflect the real alerts ledger instead of staying empty");

  // Navigating away and back — same underlying data, same readiness — must reproduce the identical rows.
  const reopened = E.movingData();
  const reopenedIds = [...reopened.canRows, ...reopened.newRows, ...reopened.changedRows].map(r => r.filmId);
  assert.deepEqual(reopenedIds, afterIds, "reopening Moving must produce the same row set as the prior open");

  E.realAlerts.length = 0;
  setSignedIn(false);
});

test("CAS-667 AC3: a genuine guest device still gets firstFound rows regardless of movingReady", () => {
  const film = E.MOVIES[0];
  setSignedIn(false);
  E.firstFound[String(film.tmdb_id)] = new Date().toISOString();
  E.setMovingReady(false);   // a guest has nothing to wait for — must be unaffected by this flag

  const { canRows, newRows, changedRows } = E.movingData();
  assert.equal(canRows.length + changedRows.length, 0, "a guest device has no can-watch/changed rows at all");
  assert.ok(newRows.some(r => r.filmId === String(film.tmdb_id)),
    "a guest device must still get its firstFound row even while movingReady is false");

  delete E.firstFound[String(film.tmdb_id)];
  E.setMovingReady(true);
});

// ---- THE GUEST BRANCH KEYS OFF cascade_had_account, NOT THE LIVE accountActive() ANSWER (CAS-670) --------
// CAS-667's guard only ever protected the `!guest` branch. The race it was meant to fix happens precisely
// while accountActive() still reads false on a device that DOES have an account — so the old guest flag
// stayed true through the whole window and movingData() kept falling into the firstFound branch regardless
// of the guard. These seed cascade_had_account directly (not via setSignedIn/CascadeAuth) so accountActive()
// can stay false throughout, exactly reproducing the reported race.
test("CAS-670 AC1: cascade_had_account=1 with accountActive() false returns empty rows and ignores firstFound", () => {
  const film = E.MOVIES[0];
  E.CascadeAuth.enabled = false; E.CascadeAuth.client = null; E.CascadeAuth.session = null;
  E.localStorage.setItem("cascade_had_account", "1");
  E.firstFound[String(film.tmdb_id)] = new Date().toISOString();
  E.setMovingReady(false);

  const { canRows, newRows, changedRows } = E.movingData();
  assert.equal(canRows.length, 0, "must not render can-watch rows while the ledger is unresolved");
  assert.equal(newRows.length, 0, "must not read firstFound just because accountActive() reads false");
  assert.equal(changedRows.length, 0, "must not render changed rows while the ledger is unresolved");

  delete E.firstFound[String(film.tmdb_id)];
  E.setMovingReady(true);
  E.localStorage.removeItem("cascade_had_account");
});

test("CAS-670 AC2: cascade_had_account=1 makes renderMovingScreen show its loading state, never the guest rows", () => {
  const film = E.MOVIES[0];
  const fid = String(film.tmdb_id);
  E.CascadeAuth.enabled = false; E.CascadeAuth.client = null; E.CascadeAuth.session = null;
  E.localStorage.setItem("cascade_had_account", "1");
  E.firstFound[fid] = new Date().toISOString();
  delete E.movingSeen[fid];
  E.setMovingReady(false);

  E.renderMovingScreen();
  assert.ok(!(fid in E.movingSeen),
    "the loading-state early return must never mark a guest-branch row as seen (would only happen if the guest/empty-state path ran instead)");

  delete E.firstFound[fid];
  E.setMovingReady(true);
  E.localStorage.removeItem("cascade_had_account");
});

test("CAS-670 AC3: cascade_had_account absent is a genuine guest device and still gets firstFound rows", () => {
  const film = E.MOVIES[0];
  E.localStorage.removeItem("cascade_had_account");
  E.CascadeAuth.enabled = false; E.CascadeAuth.client = null; E.CascadeAuth.session = null;
  E.firstFound[String(film.tmdb_id)] = new Date().toISOString();
  E.setMovingReady(false);   // a guest has nothing to wait for — must be unaffected by this flag

  const { canRows, newRows, changedRows } = E.movingData();
  assert.equal(canRows.length + changedRows.length, 0, "a guest device has no can-watch/changed rows at all");
  assert.ok(newRows.some(r => r.filmId === String(film.tmdb_id)),
    "a guest device (no cascade_had_account) must still get its firstFound row");

  delete E.firstFound[String(film.tmdb_id)];
  E.setMovingReady(true);
});

test("CAS-670 AC4: a hard reload on a signed-in device never surfaces a firstFound-sourced row during boot", () => {
  const film = E.MOVIES[0];
  const fid = String(film.tmdb_id);
  E.CascadeAuth.enabled = false; E.CascadeAuth.client = null; E.CascadeAuth.session = null; // still resolving
  E.localStorage.setItem("cascade_had_account", "1");
  E.firstFound[fid] = new Date().toISOString();   // a stale guest-era ledger this device happens to carry
  E.realAlerts.length = 0;
  E.setMovingReady(false);

  // Boot, pre-answer: nothing may render, and nothing sourced from firstFound.
  let rows = E.movingData();
  assert.ok(![...rows.canRows, ...rows.newRows, ...rows.changedRows].some(r => r.filmId === fid),
    "no point before the ledger resolves may surface a firstFound-sourced row");

  // The ledger answers, still no real alerts for this film — firstFound must still never leak through.
  E.setMovingReady(true);
  rows = E.movingData();
  assert.ok(![...rows.canRows, ...rows.newRows, ...rows.changedRows].some(r => r.filmId === fid),
    "once resolved, a signed-in device must read its real ledger, never fall back to firstFound");

  delete E.firstFound[fid];
  E.localStorage.removeItem("cascade_had_account");
});

// ---- MOVING OPENS ON THE FULLEST WINDOW (CAS-671), AND THE BADGE COUNTS THE SAME WINDOW THE SCREEN SHOWS
// (CAS-668) --------------------------------------------------------------------------------------------
// CAS-671 removed "Since you last looked" and the visit-cutoff it depended on: movingAutoOpenWindow() now
// opens on the shortest window (Today/Week/2 weeks/Month, in that order) holding 3 or more rows, falling
// back to Month if none do. movingWindowRows(win) is still the one recipe both renderMovingScreen and
// movingUnseenCount read through, so the badge and the list can never disagree about the window.
const daysAgoISO = n => new Date(Date.now() - n * 864e5).toISOString();
function unwatchedFilms(n){
  return E.MOVIES.filter(m => !E.watched.has(m.tmdb_id)).slice(0, n);
}
function seedFirstFound(films, daysAgo){
  films.forEach(m => { E.firstFound[String(m.tmdb_id)] = daysAgoISO(daysAgo); delete E.movingSeen[String(m.tmdb_id)]; });
}
function unseedFirstFound(films){
  films.forEach(m => { delete E.firstFound[String(m.tmdb_id)]; delete E.movingSeen[String(m.tmdb_id)]; });
}

test("CAS-671 AC1: app_template.html contains no since_last or movingVisitCutoff", () => {
  const src = fs.readFileSync(path.join(ROOT, "app_template.html"), "utf8");
  assert.ok(!src.includes("since_last"), "since_last must be fully removed");
  assert.ok(!src.includes("movingVisitCutoff"), "movingVisitCutoff must be fully removed");
});

test("CAS-671 AC2: opens on the shortest window holding 3 or more rows (Today 0/Week 1/2 weeks 4/Month 9)", () => {
  const films = unwatchedFilms(9);
  assert.equal(films.length, 9, "sanity: needs 9 distinct unwatched films to seed this scenario");
  const weekFilm = films.slice(0, 1);      // age 3d: inside week/2weeks/month, outside today — Week totals 1
  const twoWeekFilms = films.slice(1, 4);  // age 10d: inside 2weeks/month, outside week — 2 weeks totals 4
  const monthFilms = films.slice(4, 9);    // age 20d: inside month only — Month totals 9
  seedFirstFound(weekFilm, 3);
  seedFirstFound(twoWeekFilms, 10);
  seedFirstFound(monthFilms, 20);

  assert.equal(E.movingAutoOpenWindow(), "2weeks",
    "Today=0, Week=1, 2 weeks=4, Month=9 must open on 2 weeks — the shortest window holding >=3 rows");

  unseedFirstFound([...weekFilm, ...twoWeekFilms, ...monthFilms]);
});

test("CAS-671 AC3: falls back to Month when no window reaches 3 rows", () => {
  const films = unwatchedFilms(2);
  seedFirstFound(films, 5);   // 2 rows, inside week/2weeks/month — never reaches 3 anywhere

  assert.equal(E.movingAutoOpenWindow(), "month",
    "no window holding 3+ rows must fall back to Month, not an empty window");

  unseedFirstFound(films);
});

test("CAS-671 AC4/AC5: opening lands on the predicted window with the matching rows/badge, and reopening with no data change repeats it", () => {
  const films = unwatchedFilms(3);
  seedFirstFound(films, 10);   // 3 rows inside 2weeks/month, outside today/week

  const predicted = E.movingAutoOpenWindow();
  assert.equal(predicted, "2weeks", "sanity: 3 rows aged 10 days must open on 2 weeks");

  E.openMovingScreen();
  assert.equal(E.movingWindow, predicted, "openMovingScreen must land on the window movingAutoOpenWindow predicted");
  const shownIds = E.movingWindowRows(E.movingWindow).shownNew.map(r => r.filmId).sort();
  assert.deepEqual(shownIds, films.map(m => String(m.tmdb_id)).sort(),
    "the rendered window must show exactly the seeded rows");
  assert.equal(E.movingUnseenCount(), 0, "every row just shown must now count as seen");
  E.closeMovingScreen();

  // Reopening with the same, unchanged data must pick the same window again.
  E.openMovingScreen();
  const window2 = E.movingWindow;
  const rows2 = E.movingWindowRows(window2).shownNew.map(r => r.filmId).sort();
  E.closeMovingScreen();
  assert.equal(window2, predicted, "reopening with no data change must pick the same window");
  assert.deepEqual(rows2, shownIds, "reopening with no data change must show the same rows");

  unseedFirstFound(films);
});

test("CAS-668: rendering a window does not clear the unseen state of rows outside it", () => {
  const [filmA, filmB] = unwatchedFilms(2);
  const idA = String(filmA.tmdb_id), idB = String(filmB.tmdb_id);
  const padding = unwatchedFilms(4).slice(2, 4);   // 2 more films so filmB's window reaches the 3-row threshold

  seedFirstFound([filmB, ...padding], 10);   // 3 rows aged 10 days — inside 2weeks/month, outside today/week
  seedFirstFound([filmA], 20);               // 1 row aged 20 days — inside month only, outside 2weeks

  E.openMovingScreen();
  assert.equal(E.movingWindow, "2weeks", "sanity: 3 rows aged 10 days must auto-open on 2 weeks");
  const { shownNew } = E.movingWindowRows("2weeks");
  const shownIds = shownNew.map(r => r.filmId);
  assert.ok(shownIds.includes(idB) && !shownIds.includes(idA), "sanity: filmB is in the 2 weeks window, filmA is not");

  assert.equal(E.movingSeen[idB], "new_agents", "the row actually shown in the rendered window must be marked seen");
  assert.ok(!(idA in E.movingSeen), "a row outside the rendered window must not have its unseen state touched");
  E.closeMovingScreen();

  unseedFirstFound([filmA, filmB, ...padding]);
});

test("CAS-668: an empty window's badge reads 0, not a count borrowed from a different window", () => {
  const [film] = unwatchedFilms(1);
  seedFirstFound([film], 20);  // real, unseen, but never inside "today"

  E.openMovingScreen();
  E.setMovingWindow("today");
  const { shownNew } = E.movingWindowRows("today");
  assert.equal(shownNew.length, 0, "sanity: \"today\" really is empty for this seeded data");
  assert.equal(E.movingUnseenCount(), 0,
    "the badge must read 0 for an empty window even though an unseen row exists in a different window");
  E.closeMovingScreen();

  unseedFirstFound([film]);
});

// ---- THE LISTING APPLIES NO DEPTH CAP OR SCORE FLOOR (CAS-662) --------------------------------------------
// render() used to read one active agent's onboarding depth answer + rate-slider stop and apply that agent's
// floor/cap to the WHOLE listing — a six-agent list could render one film under a "Show all 36" button, none
// of which anyone had chosen. AC1 (structural: render() reads no onbDepth, the app carries no obshowall
// affordance) is checked directly against the source; AC2 (arithmetic: the listing yields exactly the rows it
// is given, with no further trimming) is checked against listingGroups(), render()'s own DOM-free group
// partition — the only place the cap used to live.
test("CAS-662 AC1: render() reads no onbDepth, and the app carries no obshowall affordance", () => {
  const src = fs.readFileSync(path.join(ROOT, "app_template.html"), "utf8");
  const renderStart = src.indexOf("\nfunction render(){");
  assert.ok(renderStart >= 0, "render() was not found");
  const renderEnd = src.indexOf("\n// ---- CAS-275", renderStart);
  assert.ok(renderEnd > renderStart, "the end of render() was not found");
  const renderBody = src.slice(renderStart, renderEnd);
  assert.ok(!renderBody.includes("onbDepth"), "render() still reads onbDepth");
  assert.ok(!src.includes("obshowall"), "the app still carries the obshowall affordance");
});

test("CAS-662 AC2: the listing yields exactly E.listedBy's rows, for every group, no cap or floor", () => {
  for(const { kind, s, label } of CASES){
    pickInLane(E, kind, s.key);
    const d = E.onbApply();
    const rows = E.MOVIES.filter(m => E.listedBy(m, d));
    const groups = E.listingGroups(rows, d);
    const total = groups.reduce((n, x) => n + x.items.length, 0);
    assert.equal(total, rows.length,
      `${label}: the listing dropped ${rows.length - total} of ${rows.length} listed film(s) — a cap survived`);
    // AC3: a group's header count (rendered cards minus tagged-out stubs) can never exceed what render()
    // actually streams for that group — true as long as no group holds more than its own rows.length.
    for(const { g, items } of groups) assert.ok(items.length <= rows.filter(m => E.primaryStatus(m) === g).length,
      `${label}/${g}: group holds more items than the rows that belong to it`);
  }
});

// ---- WATCH ON PLACEMENT — THE LATER-OF RULE (CAS-727) ------------------------------------------------------
// recomputeFound() now computes every admitted film's Watch On itself, every pass: the later of `earned`
// (the window its score clears, fixed once at admission and never re-thresholded) and `standing` (the
// window it's in right now, which keeps moving). This replaces CAS-613's once-ever `autoNotify`-gated arm
// outright — autoNotified is gone (AC5 below), and c.autoNotify no longer has anything to do with Watch On.
function seedMarkerCascade(markers){
  const id = "cas727-test-cascade";
  // A full normCascade(), not a bare object: watchesFilm/matchesCriteria run against EVERY film in
  // MOVIES.forEach (recomputeFound loops the whole catalogue per cascade), and a bare {id} crashes on the
  // first film that isn't the one this test pins in. imdb:10.1 is above the real 0-10 scale, so criteria
  // matching admits nothing — only pinFilm's pinnedInto override reaches this cascade.
  const c = E.normCascade({ kind: "stream", status: [], imdb: 10.1 });
  c.id = id; c.paused = false;
  c.watchMarkers = { in_cinema: null, premium: null, rent: null, stream: null, ...markers };
  E.cascades.push(c);
  return id;
}
// Cinema/Rental/Streaming on, Premium off — the default watchPrefsDefaults() shape, made explicit so these
// tests don't depend on whatever an earlier test left the global watchPrefs pointing at.
const PLACEMENT_WATCH_PREFS = {
  in_cinema: { list: true, notify: false }, premium: { list: false, notify: false },
  rent: { list: true, notify: false }, stream: { list: true, notify: false },
};
function unseedCascade(id){
  const i = E.cascades.findIndex(c => c.id === id);
  if(i >= 0) E.cascades.splice(i, 1);
}
function pinFilm(id, cascadeId){
  const e = E.entryFor(id);
  e.pinnedTo = [...(e.pinnedTo || []), cascadeId];
}
function withWatchPrefs(overrides, fn){
  const saved = E.watchPrefs;
  E.setWatchPrefs({ ...saved, ...overrides });
  try{ fn(); } finally{ E.setWatchPrefs(saved); }
}

test("CAS-613 AC1: the briefing screen's autoNotify checkbox is unconditional (both cinema and streaming agents)", () => {
  const src = fs.readFileSync(path.join(ROOT, "app_template.html"), "utf8");
  const anchor = src.indexOf("<!-- CAS-613: auto-notify");
  assert.ok(anchor >= 0, "the CAS-613 checkbox block was not found in the briefing step");
  const block = src.slice(anchor, anchor + 800);
  assert.ok(block.includes('id="briefAutoNotify"'), "the autoNotify switch must render in the briefing step");
  assert.ok(!block.trimStart().startsWith("${stream"),
    "the checkbox must not be gated behind the streaming-only branch — it belongs to both lanes");
});

test("CAS-613 AC1: autoNotify defaults false and round-trips true through normCascade (the criteria jsonb shape)", () => {
  const off = E.normCascade({ kind: "stream", status: [] });
  assert.equal(off.autoNotify, false, "an agent saved before this ticket must read false, not undefined");
  const on = E.normCascade({ kind: "stream", status: [], autoNotify: true });
  assert.equal(on.autoNotify, true, "an agent explicitly saved with autoNotify true must keep it");
});

// Picks an unwatched film with a real (non -1) Cascade score under `status`, since the placement rule has
// nothing to grade a scoreless film against. unwatchedFilms(n) already skips watched films; this just walks
// forward until cascadeScore(m) is real, restoring nothing itself — status is the caller's to save/restore.
function scoredUnwatchedFilm(status){
  const pool = unwatchedFilms(40);
  for(const m of pool){
    const saved = m.status;
    m.status = status;
    const score = E.cascadeScore(m);
    if(score !== -1) return m;
    m.status = saved;
  }
  throw new Error("no unwatched film in the first 40 carries a real Cascade score under " + JSON.stringify(status));
}
// Same search, but hands back a restore() closing over the film's status as it stood BEFORE this pick — not
// scoredUnwatchedFilm's own "savedStatus = film.status" convention, which captures the status AFTER it has
// already been overwritten and so never actually undoes the mutation. That's harmless as long as no later
// test's own unwatchedFilms() pick lands on the same film, which is what happened here: CAS-731's tests and
// CAS-709/CAS-728's fixed unwatchedFilms(1) pick collided on the same first film once this file's own status
// mutations accumulated. `listable` additionally demands !isEstimated(m) for tests that must clear
// listWindowOK (CAS-731's placementSplitHTML tests, via listedBy) — an ESTIMATED "upcoming" is denied there
// outright (CAS-481) — where the recomputeFound-only CAS-727 tests above don't need it.
function pickScoredFilm(status, { listable = false } = {}){
  const pool = unwatchedFilms(60);
  for(const m of pool){
    const original = m.status;
    m.status = status;
    const score = E.cascadeScore(m);
    if(score !== -1 && (!listable || !E.isEstimated(m))) return { film: m, restore: () => { m.status = original; } };
    m.status = original;
  }
  throw new Error(`no eligible unwatched film in the first 60 under ${JSON.stringify(status)} (listable=${listable})`);
}

test("CAS-727 AC2(a): upcoming, score above the Cinema marker, is placed at Cinema", () => {
  const film = scoredUnwatchedFilm(["upcoming"]);
  const id = film.tmdb_id;
  const savedStatus = film.status;
  const score = E.cascadeScore(film);
  const cId = seedMarkerCascade({ in_cinema: score - 1, rent: score - 20, stream: score - 30 });
  try {
    pinFilm(id, cId);
    withWatchPrefs(PLACEMENT_WATCH_PREFS, () => { E.recomputeFound(); });
    const e = E.notify[id];
    assert.equal(e.wins.in_cinema, true, "an upcoming film clearing the Cinema marker is placed at Cinema");
    assert.equal(e.winsSource.in_cinema, "auto");
  } finally {
    delete E.notify[id];
    unseedCascade(cId);
    film.status = savedStatus;
  }
});

test("CAS-727 AC2(b): in cinemas, a score between the Rental and Cinema markers is placed at Rental", () => {
  const film = scoredUnwatchedFilm(["in_cinema"]);
  const id = film.tmdb_id;
  const savedStatus = film.status;
  const score = E.cascadeScore(film);
  const cId = seedMarkerCascade({ in_cinema: score + 10, rent: score - 10, stream: score - 20 });
  try {
    pinFilm(id, cId);
    withWatchPrefs(PLACEMENT_WATCH_PREFS, () => { E.recomputeFound(); });
    const e = E.notify[id];
    assert.equal(e.wins.rent, true,
      "the score doesn't clear Cinema but clears Rental, and the film is standing at Cinema — 'I'll wait for it'");
    assert.equal(e.winsSource.rent, "auto");
  } finally {
    delete E.notify[id];
    unseedCascade(cId);
    film.status = savedStatus;
  }
});

test("CAS-727 AC2(c)/(d)/AC3-in-miniature: earned is fixed at admission — a film travels forward with its status, and Never skips a window", () => {
  const film = scoredUnwatchedFilm(["upcoming"]);
  const id = film.tmdb_id;
  const savedStatus = film.status;
  const score = E.cascadeScore(film);   // taken while upcoming (cinema basis) — must survive the basis flip below
  const cId = seedMarkerCascade({ in_cinema: score - 1, rent: score - 20, stream: score - 30 });
  try {
    pinFilm(id, cId);
    withWatchPrefs(PLACEMENT_WATCH_PREFS, () => {
      E.recomputeFound();
      assert.equal(E.notify[id].wins.in_cinema, true, "AC2(a) sanity: armed at Cinema while upcoming");

      // (c): the same film, unwatched, now rental — earned (Cinema, from the score at admission) never
      // gets re-read even though released films score on a completely different basis (qScore, not cinema
      // buzz); only standing moves, and it moves past earned.
      film.status = ["rental"];
      E.recomputeFound();
      assert.equal(E.notify[id].wins.rent, true, "AC2(c): standing overtakes earned once the film reaches rental");
      assert.equal(E.notify[id].wins.in_cinema, false);

      // (d): same again, but this agent has set Rental to Never — standing must snap forward past it to
      // the next enabled window (Streaming), not fall back to earned (Cinema).
      const c = E.cascades.find(x => x.id === cId);
      c.watchMarkers.rent = null;
      E.recomputeFound();
      assert.equal(E.notify[id].wins.stream, true, "AC2(d): Rental set to Never snaps standing forward to Streaming");
      assert.equal(E.notify[id].wins.in_cinema, false);
      assert.equal(E.notify[id].wins.rent, false);
    });
  } finally {
    delete E.notify[id];
    unseedCascade(cId);
    film.status = savedStatus;
  }
});

test("CAS-727 AC2(e): a score below every marker is admitted (via pin) but placed nowhere", () => {
  const film = scoredUnwatchedFilm(["upcoming"]);
  const id = film.tmdb_id;
  const savedStatus = film.status;
  // 101 is above the 0-100 scale on every axis cascadeScore can return, so no real score ever clears it —
  // simpler than reasoning about the film's own score value, and just as much "below every marker".
  const cId = seedMarkerCascade({ in_cinema: 101, rent: 101, stream: 101 });
  try {
    pinFilm(id, cId);
    withWatchPrefs(PLACEMENT_WATCH_PREFS, () => { E.recomputeFound(); });
    const e = E.notify[id];
    const picked = !!(e && e.wins && Object.values(e.wins).some(Boolean));
    assert.ok(!picked, "a film that clears no marker must get no Watch On value, even though the pin admits it");
  } finally {
    delete E.notify[id];
    unseedCascade(cId);
    film.status = savedStatus;
  }
});

test("CAS-727 AC3: replaying a film's status forward never moves its Watch On backward on WINDOW_RUNG", () => {
  const film = scoredUnwatchedFilm(["upcoming"]);
  const id = film.tmdb_id;
  const savedStatus = film.status;
  const score = E.cascadeScore(film);
  const cId = seedMarkerCascade({ in_cinema: score - 1, rent: score - 20, stream: score - 30 });
  try {
    pinFilm(id, cId);
    withWatchPrefs(PLACEMENT_WATCH_PREFS, () => {
      const journey = [["upcoming"], ["in_cinema"], ["rental"], ["included_streaming"]];
      let prevRank = -1;
      for(const status of journey){
        film.status = status;
        E.recomputeFound();
        const e = E.notify[id];
        const key = E.WATCH_LEVEL_KEYS.find(k => e.wins && e.wins[k]);
        assert.ok(key, `a film clearing its Cinema marker at admission must still hold a Watch On value at ${status}`);
        const rank = E.WATCH_LEVEL_KEYS.indexOf(key);
        assert.ok(rank >= prevRank,
          `Watch On moved backward at status=${status}: rank ${rank} < previous ${prevRank}`);
        prevRank = rank;
      }
    });
  } finally {
    delete E.notify[id];
    unseedCascade(cId);
    film.status = savedStatus;
  }
});

test("CAS-727 AC4: a manual Watch On value is byte-identical before and after recompute, for any marker combination", () => {
  const film = scoredUnwatchedFilm(["in_cinema"]);
  const id = film.tmdb_id;
  const savedStatus = film.status;
  const cId = seedMarkerCascade({});
  try {
    pinFilm(id, cId);
    const e = E.entryFor(id);
    e.wins = { in_cinema: false, premium: false, rent: true, stream: false };
    e.winsSource = { rent: "manual" };
    const before = JSON.stringify([e.wins, e.winsSource]);
    const c = E.cascades.find(x => x.id === cId);
    const score = E.cascadeScore(film) === -1 ? 50 : E.cascadeScore(film);
    const combos = [
      { in_cinema: score - 1, rent: score - 20, stream: score - 30 },
      { in_cinema: null, rent: null, stream: null },
      { in_cinema: 0, rent: 0, stream: 0 },
      { in_cinema: score + 40, rent: score + 20, stream: score + 10 },
    ];
    withWatchPrefs(PLACEMENT_WATCH_PREFS, () => {
      for(const markers of combos){
        c.watchMarkers = { in_cinema: null, premium: null, rent: null, stream: null, ...markers };
        for(const status of [["upcoming"], ["in_cinema"], ["rental"], ["included_streaming"]]){
          film.status = status;
          E.recomputeFound();
          assert.equal(JSON.stringify([e.wins, e.winsSource]), before,
            `a manual value must survive recompute: markers=${JSON.stringify(markers)} status=${status}`);
        }
      }
    });
  } finally {
    delete E.notify[id];
    unseedCascade(cId);
    film.status = savedStatus;
  }
});

test("CAS-727 AC5: app_template.html carries no trace of the retired autoNotified guard", () => {
  const src = fs.readFileSync(path.join(ROOT, "app_template.html"), "utf8");
  const count = (src.match(/autoNotified/g) || []).length;
  assert.equal(count, 0, `expected 0 occurrences of "autoNotified", found ${count}`);
});

// ---- MISSION PLACEMENT SPLIT COUNTS WATCH ON, NOT AVAILABILITY (CAS-731) -----------------------------------
// placementSplitHTML(c) used to bucket by primaryStatus(m) through filmOptKeyForWindow — the film's CURRENT
// availability — which both answered the wrong question (CAS-729 §7 item 7 wants placement, what the agent
// DECIDED) and silently dropped a film whenever that status mapped to a window outside the agent's own marks
// (upcoming/pvod), so the parts didn't sum to the headline (the CAS-680/682 bug, again). It now buckets by
// filmNotifyState(m.tmdb_id).key — Watch On, the same value the Watch screen's tabs filter on — and any
// listed film without a bucket in `marks` (no Watch On value yet) falls into a trailing "unplaced" part
// instead of vanishing.
function sumPlacementParts(html){
  if(!html) return 0;
  const parts = [...html.matchAll(/(\d+) (?:Cinema|Premium|Rental|Streaming|unplaced)/g)];
  return parts.reduce((sum, m) => sum + Number(m[1]), 0);
}

test("CAS-731 AC2: the placement split (including unplaced) sums to the listing headline, for every lane", () => {
  for(const { kind, s, label } of CASES){
    pickInLane(E, kind, s.key);
    const d = E.onbApply();
    const html = E.placementSplitHTML(d);
    const sum = sumPlacementParts(html);
    assert.equal(sum, E.listedCount(d), `${label}: placement split sums to ${sum}, the listing has ${E.listedCount(d)} (split: "${html}")`);
  }
});

test("CAS-731 AC2: a listed film with no Watch On value is counted as unplaced, not dropped", () => {
  const { film, restore } = pickScoredFilm(["upcoming"], { listable: true });
  const id = film.tmdb_id;
  // 101 is above the 0-100 scale on every axis cascadeScore can return, so the pinned film clears no marker
  // and gets no Watch On value at all — the "no bucket" case this test exists to check.
  const cId = seedMarkerCascade({ in_cinema: 101, rent: 101, stream: 101 });
  try {
    pinFilm(id, cId);
    withWatchPrefs(PLACEMENT_WATCH_PREFS, () => {
      E.recomputeFound();
      assert.equal(E.filmNotifyState(id).key, null, "sanity: a score below every marker leaves no Watch On value");
      const c = E.cascades.find(x => x.id === cId);
      const html = E.placementSplitHTML(c);
      assert.match(html, /\b1 unplaced\b/, `expected the unplaced film to surface, not vanish: "${html}"`);
      assert.equal(sumPlacementParts(html), E.listedCount(c), `parts must still sum to the headline: "${html}"`);
    });
  } finally {
    delete E.notify[id];
    unseedCascade(cId);
    restore();
  }
});

test("CAS-731 AC3: a film admitted from upcoming and placed at Cinema is counted in the Cinema part, not dropped", () => {
  const { film, restore } = pickScoredFilm(["upcoming"], { listable: true });
  const id = film.tmdb_id;
  const score = E.cascadeScore(film);
  const cId = seedMarkerCascade({ in_cinema: score - 1, rent: score - 20, stream: score - 30 });
  try {
    pinFilm(id, cId);
    withWatchPrefs(PLACEMENT_WATCH_PREFS, () => {
      E.recomputeFound();
      assert.equal(E.primaryStatus(film), "upcoming", "sanity: the film is still upcoming");
      assert.equal(E.filmNotifyState(id).key, "in_cinema", "sanity: Watch On is Cinema");
      const c = E.cascades.find(x => x.id === cId);
      const html = E.placementSplitHTML(c);
      const cinema = html.match(/(\d+) Cinema/);
      assert.ok(cinema && Number(cinema[1]) >= 1, `expected the upcoming film in the Cinema part, not dropped: "${html}"`);
      assert.equal(sumPlacementParts(html), E.listedCount(c), `parts must sum to the headline: "${html}"`);
    });
  } finally {
    delete E.notify[id];
    unseedCascade(cId);
    restore();
  }
});

test("CAS-731 AC4: a film whose Watch On is Streaming while standing at Rental is counted in Streaming, not Rental", () => {
  const { film, restore } = pickScoredFilm(["rental"]);
  const id = film.tmdb_id;
  const score = E.cascadeScore(film);
  const cId = seedMarkerCascade({ in_cinema: score + 50, rent: score + 20, stream: score - 1 });
  try {
    pinFilm(id, cId);
    withWatchPrefs(PLACEMENT_WATCH_PREFS, () => {
      E.recomputeFound();
      assert.equal(E.primaryStatus(film), "rental", "sanity: the film is standing at Rental");
      assert.equal(E.filmNotifyState(id).key, "stream", "sanity: Watch On is Streaming, following the score, not availability");
      const c = E.cascades.find(x => x.id === cId);
      const html = E.placementSplitHTML(c);
      const streaming = html.match(/(\d+) Streaming/);
      const rental = html.match(/(\d+) Rental/);
      assert.ok(streaming && Number(streaming[1]) >= 1, `expected the film in Streaming: "${html}"`);
      assert.equal(rental ? Number(rental[1]) : 0, 0, `the film must not also count under Rental: "${html}"`);
      assert.equal(sumPlacementParts(html), E.listedCount(c), `parts must sum to the headline: "${html}"`);
    });
  } finally {
    delete E.notify[id];
    unseedCascade(cId);
    restore();
  }
});

test("CAS-613 AC5: recomputeFound() calls saveNotify() at most once per pass", () => {
  const src = fs.readFileSync(path.join(ROOT, "app_template.html"), "utf8");
  const start = src.indexOf("\nfunction recomputeFound(){");
  assert.ok(start >= 0, "recomputeFound() was not found");
  const end = src.indexOf("\n// What the megaphone's colour", start);
  assert.ok(end > start, "the end of recomputeFound() was not found");
  const body = src.slice(start, end);
  const calls = body.match(/\bsaveNotify\(\)/g) || [];
  assert.equal(calls.length, 1, `recomputeFound() calls saveNotify() ${calls.length} time(s), expected exactly 1`);
});

// ---- A FILM BELONGS TO EXACTLY ONE AGENT (CAS-709) --------------------------------------------------------
// recomputeFound() used to let a film be found by every Cascade whose criteria matched it, so a film could
// show under two auto-matching agents at once. Now, unpinned, it belongs to exactly its single highest-ranked
// (lowest .order) match; pinned, it belongs to exactly its pinned cascade(s), full stop, even against a
// higher-ranked agent's own criteria match.
test("CAS-709 AC1/AC2: an unpinned film keeps only its top-ranked match; a hand-pin outranks a higher-ranked match", () => {
  const [film] = unwatchedFilms(1);
  const id = film.tmdb_id;
  const before = new Set(Object.keys(E.notify));
  // Broad, unconstrained criteria (mirrors seedAutoNotifyCascade's shape) so both agents match the same
  // film by CRITERIA, not by pin — .order is what CAS-709 says must decide between them.
  const cA = E.normCascade({ kind: "stream", status: [] }); cA.id = "cas709-a"; cA.paused = false; cA.order = -1000;
  const cB = E.normCascade({ kind: "stream", status: [] }); cB.id = "cas709-b"; cB.paused = false; cB.order = -999;
  E.cascades.push(cA, cB);
  try {
    E.recomputeFound();
    // vm-realm gotcha: cascadeIds is an Array from the sandboxed engine's own realm, so it must be spread
    // into a plain array before deepEqual — compared directly it fails even with identical contents.
    assert.deepEqual([...E.notify[id].cascadeIds], [cA.id],
      "AC1: an unpinned film matched by two agents must belong to exactly its single highest-ranked (lowest .order) one");

    pinFilm(id, cB.id);   // hand-pin into the LOWER-ranked agent while the higher-ranked one still matches by criteria
    E.recomputeFound();
    assert.deepEqual([...E.notify[id].cascadeIds], [cB.id],
      "AC2: a hand-pin must win outright over a higher-ranked agent's own criteria match");
  } finally {
    unseedCascade(cA.id);
    unseedCascade(cB.id);
    // The broad-match agents above will have found many other films besides `id` — clean up every notify
    // entry this test created, not just the one it asserted on, then recompute so real state is restored.
    for(const k of Object.keys(E.notify)) if(!before.has(k)) delete E.notify[k];
    E.recomputeFound();
  }
});

// ---- A MONITOR MOMENT CAN NEVER RENDER AS ITS RAW KEY (CAS-602) -------------------------------------------
// The monitor's `newly_qualifies` moment (a held film whose own attributes newly qualify it for an agent)
// has to be in REAL_MOMENT_SAID, the bell's own moment-copy lookup, or a ledger row for it would fall
// through to a.moment itself at the ntfrow render site — a raw internal key on screen.
test("CAS-602: REAL_MOMENT_SAID carries the newly_qualifies key, so its ledger row never renders raw", () => {
  assert.ok(Object.prototype.hasOwnProperty.call(E.REAL_MOMENT_SAID, "newly_qualifies"),
    "REAL_MOMENT_SAID is missing a newly_qualifies entry");
  assert.equal(typeof E.REAL_MOMENT_SAID.newly_qualifies, "string",
    "REAL_MOMENT_SAID.newly_qualifies must be real copy, not empty/falsy");
});

// ---- CAS-678: ONE POPULARITY LADDER — THE BUZZ DIAL AND THE CARD LOZENGE CANNOT DRIFT APART --------------
// One cohort (films whose status includes upcoming or in_cinema), one quantity (TMDB popularity), one set of
// percentile cuts. The card badge and the Buzz dial both read buzzStop()/buzzBandOf(), so these are really
// one invariant tested from both ends, not two separate claims that happen to agree today.
test("CAS-678 AC1: one set of popularity thresholds, computed over the upcoming-and-in-cinema cohort", () => {
  assert.deepEqual([...E.BUZZ_PCTL], [0, 65, 85, 95], "the ladder's percentile stops have moved");
  assert.equal(E.BUZZ_CUTS.length, E.BUZZ_PCTL.length, "one cut per stop");
  for(let i = 1; i < E.BUZZ_CUTS.length; i++){
    assert.ok(E.BUZZ_CUTS[i] >= E.BUZZ_CUTS[i - 1], "the cuts must be non-decreasing — a higher stop is a higher bar");
  }
  const cohort = E.MOVIES.filter(m => m.status.includes("upcoming") || m.status.includes("in_cinema"));
  assert.ok(cohort.length > 0, "the cohort is empty — this test would prove nothing");
  for(const m of cohort) assert.equal(E.inLadderCohort(m), true, `${m.title}: in the cohort by status but inLadderCohort says no`);
  for(const m of E.MOVIES.filter(m => !cohort.includes(m))){
    assert.equal(E.inLadderCohort(m), false, `${m.title}: outside the cohort by status but inLadderCohort says yes`);
  }
});

test("CAS-678 AC2: a film displays a band's lozenge if and only if the Buzz dial set to that band returns it", () => {
  const BAND_KEY = { anticipated: 1, blockbuster: 2, mustsee: 3 };
  for(const m of E.MOVIES){
    const badge = E.scaleTier(m);
    if(badge === "landmark") continue;   // Landmark outranks the ladder — its own axis, tested separately
    for(const [band, stop] of Object.entries(BAND_KEY)){
      const dialReturnsExactlyThisBand = E.selBuzzOK(m, { selBuzz: stop })
        && (stop === 3 || !E.selBuzzOK(m, { selBuzz: stop + 1 }));
      assert.equal(badge === band, dialReturnsExactlyThisBand,
        `${m.title}: badge is ${badge || "none"}, dial-at-${band} says ${dialReturnsExactlyThisBand}`);
    }
  }
});

test("CAS-678 AC3: no film outside the cohort carries any of the three ladder lozenges", () => {
  for(const m of E.MOVIES){
    if(E.inLadderCohort(m)) continue;
    assert.equal(E.buzzBandOf(m), null, `${m.title}: outside the cohort but badged ${E.buzzBandOf(m)}`);
  }
});

test("CAS-678 AC4: the three bands are disjoint and ordered — a film's band is the highest it clears", () => {
  for(const m of E.MOVIES){
    const stop = E.buzzStop(m);
    assert.ok(stop >= 0 && stop <= 3, `${m.title}: buzzStop ${stop} out of range`);
    // Every lower stop must also be cleared (a floor, not a band) — otherwise "highest cleared" is undefined.
    for(let s = 1; s <= stop; s++){
      assert.equal(E.selBuzzOK(m, { selBuzz: s }), true, `${m.title}: clears stop ${stop} but not the lower stop ${s}`);
    }
    for(let s = stop + 1; s <= 3; s++){
      assert.equal(E.selBuzzOK(m, { selBuzz: s }), false, `${m.title}: buzzStop says ${stop} but also clears the higher stop ${s}`);
    }
  }
});

test("CAS-678 AC5: Landmark behaves exactly as before the change — its predicate is unchanged", () => {
  const LANDMARK_RT = 85, LANDMARK_META = 75, BIG_BUDGET = 120e6;
  const BLOCKBUSTER_TOP = 15;
  const popOf = m => m.popularity || 0;
  const popAll = E.MOVIES.map(popOf).sort((a, b) => a - b);
  const blockbusterBar = popAll.length
    ? popAll[Math.min(popAll.length - 1, Math.round((100 - BLOCKBUSTER_TOP) / 100 * (popAll.length - 1)))] : Infinity;
  const reproIsLandmark = m => !!m.award
    && ((m.rt_critic || 0) >= LANDMARK_RT || (m.metacritic || 0) >= LANDMARK_META)
    && ((m.budget || 0) >= BIG_BUDGET || popOf(m) >= blockbusterBar);
  let landmarkCount = 0;
  for(const m of E.MOVIES){
    assert.equal(E.isLandmark(m), reproIsLandmark(m), `${m.title}: isLandmark disagrees with the pre-CAS-678 formula`);
    if(E.isLandmark(m)) landmarkCount++;
  }
  assert.ok(landmarkCount > 0, "not one film is badged Landmark — this test would prove nothing");
});

test("CAS-678 AC6: matchesCriteria no longer reads c.tentpole, and no Tentpole UI markup remains", () => {
  const src = fs.readFileSync(path.join(ROOT, "app_template.html"), "utf8");
  const start = src.indexOf("\nfunction matchesCriteria(m,c,ignoreBlocked,ignoreScoreGate){");
  assert.ok(start >= 0, "matchesCriteria() was not found");
  const end = src.indexOf("\nconst countCriteria = c =>", start);
  assert.ok(end > start, "the end of matchesCriteria() was not found");
  assert.ok(!/tentpole/i.test(src.slice(start, end)), "matchesCriteria still reads the tentpole criterion");
  for(const gone of ["TENTPOLE_STOPS", "tentpoleSel", "cTentLoz", "cTentCap", "cTentDesc"]){
    assert.ok(!src.includes(gone), `${gone} still appears — Tentpole UI has not been fully removed`);
  }
  // The stored field itself, and cascSigOf's use of it, are explicitly UNCHANGED (CAS-678 item Four).
  assert.ok(/c\.tentpole = c\.tentpole\|\|"any";/.test(src), "the stored c.tentpole field's normalisation was removed");
  const sigStart = src.indexOf("const cascSigOf = c =>");
  assert.ok(sigStart >= 0, "cascSigOf() was not found");
  assert.ok(/c\.tentpole/.test(src.slice(sigStart, sigStart + 300)), "cascSigOf no longer carries c.tentpole");
});

// ---- WATCH-LIST ACCOUNT MERGE NEVER DOUBLE-ADDS AN ID (CAS-681) --------------------------------------------
// loadWatchlistAccount used to fold in "local-only" lists by content signature alone (CAS-590). A list that
// genuinely exists in the account, but whose local copy has drifted (svcOn/cascOff/watchedOn/watchTiers/sort
// all change on every Edit-screen tap), read as local-only and got appended alongside its own remote twin —
// two rows sharing one id, which Postgres's upsert rejects with 21000 ("ON CONFLICT DO UPDATE command cannot
// affect row a second time"). Same fault, same fix, as CAS-658 did for cascades. These tests exercise the
// real seam (window.CascadePersistence, newly wired up for watchlists here) against a fake Supabase client
// that reproduces the exact 21000 error a real duplicate-id payload would get, rather than a stand-in.
// CAS-692: a chainable, awaitable stand-in for a postgrest select() builder — supports the .eq()/.in()/
// .is()/.maybeSingle() chains the real version/tombstone-aware sync path now issues, while still being
// directly awaitable (a bare `await client.from(t).select(cols)`) for call sites that chain nothing.
function wlSelectBuilder(sourceRows){
  let rows = sourceRows.map(r => ({ ...r }));
  const builder = {
    eq(col, val){ rows = rows.filter(r => r[col] === val); return builder; },
    in(col, vals){ const set = new Set(vals); rows = rows.filter(r => set.has(r[col])); return builder; },
    is(col, val){ rows = rows.filter(r => (r[col] ?? null) === val); return builder; },
    maybeSingle: async () => ({ data: rows[0] || null, error: null }),
    then(resolve, reject){ return Promise.resolve({ data: rows, error: null }).then(resolve, reject); },
  };
  return builder;
}
function fakeWatchlistSupabase(initialRows){
  const state = { rows: initialRows.slice(), upsertCalls: [] };
  const client = {
    from(table){
      assert.equal(table, "watchlists", "the watch-list seam must only ever touch the watchlists table");
      return {
        select: () => wlSelectBuilder(state.rows),
        upsert(rows){
          state.upsertCalls.push(rows);
          const ids = rows.map(r => r.id);
          let result;
          if(new Set(ids).size !== ids.length){
            // The real failure mode, reproduced: a payload with a repeated conflict key 500s.
            result = { data: null, error: { code: "21000",
              message: "ON CONFLICT DO UPDATE command cannot affect row a second time",
              hint: "Ensure that no rows proposed for insertion within the same command have duplicate constrained values." } };
          } else {
            const nowIso = new Date().toISOString();
            rows.forEach(r => {
              const stored = { ...r, updated_at: nowIso };
              const i = state.rows.findIndex(x => x.id === r.id);
              if(i >= 0) state.rows[i] = stored; else state.rows.push(stored);
            });
            result = { data: rows.map(r => ({ id: r.id, updated_at: nowIso })), error: null };
          }
          return { select: async () => result, then(resolve, reject){ return Promise.resolve(result).then(resolve, reject); } };
        },
        update(patch){
          return { eq(){ return { in: async (col, ids) => {
            ids.forEach(id => { const i = state.rows.findIndex(x => x.id === id); if(i >= 0) state.rows[i] = { ...state.rows[i], ...patch }; });
            return { error: null };
          } }; } };
        },
      };
    },
  };
  return { client, state };
}
function signInWithClient(client){
  const auth = E.CascadeAuth;
  auth.enabled = true; auth.client = client; auth.session = { user: { id: "cas681-test-user" } };
}
function signOut(){
  const auth = E.CascadeAuth;
  auth.enabled = false; auth.client = null; auth.session = null;
}
function withCas681State(fn){
  const savedLists = E.watchLists.slice();
  const savedActive = E.watchActiveId;
  return (async () => {
    try { await fn(); }
    finally {
      E.watchLists.length = 0; savedLists.forEach(l => E.watchLists.push(l));
      E.setActiveWatchlist(savedActive);
      signOut();
    }
  })();
}

test("CAS-681 AC1/AC3: a remote row plus a locally-drifted copy of it never doubles up, and the drifted account load no longer 500s", () => withCas681State(async () => {
  const id = "cas681-0000-4000-8000-000000000001";
  const remoteRow = { id, user_id: "cas681-test-user",
    criteria: { name: "My List", icon: "🎬", order: 0, svcOn: [], cascOff: [], watchedOn: [], watchTiers: [], sort: "score" } };
  const { client, state } = fakeWatchlistSupabase([remoteRow]);
  signInWithClient(client);

  // This device's own copy of the SAME list (same id), edited locally — e.g. a re-sort — while the
  // account write kept failing, so its content signature differs from the remote row above.
  E.watchLists.length = 0;
  E.watchLists.push(E.normWatchlistEntry({ id, name: "My List", icon: "🎬", order: 0,
    svcOn: [], cascOff: [], watchedOn: [], watchTiers: [], sort: "az" }));

  await E.CascadePersistence.loadWatchlistAccount();

  const ids = E.watchLists.map(l => l.id);
  assert.equal(new Set(ids).size, ids.length, "watchLists must never hold two entries sharing one id");
  const kept = E.watchLists.find(l => l.id === id);
  assert.ok(kept, "the shared-id list must still be present after the load");
  assert.equal(kept.sort, "az", "the local (newer) drifted value must win over the stale remote one");

  // The reported failure, reproduced end to end: pushing the post-load state must not hit the simulated
  // 21000 (it would if the load had appended a duplicate instead of updating in place).
  await E.CascadePersistence.syncWatchlistsNow();
  const lastUpsert = state.upsertCalls[state.upsertCalls.length - 1] || [];
  const upsertIds = lastUpsert.map(r => r.id);
  assert.equal(new Set(upsertIds).size, upsertIds.length, "the sync that follows a drifted load must not 500");
}));

test("CAS-681 AC2: syncWatchlistsToAccount never issues an upsert whose payload contains a repeated id, even if watchLists already holds a duplicate", () => withCas681State(async () => {
  const id = "cas681-0000-4000-8000-000000000002";
  const { client, state } = fakeWatchlistSupabase([]);
  signInWithClient(client);

  // A payload that cannot be built without duplicates is a bug elsewhere (the AC's own words) — seed one
  // directly to prove the defensive guard in syncWatchlistsToAccount catches it regardless of source.
  E.watchLists.length = 0;
  E.watchLists.push(E.normWatchlistEntry({ id, name: "Stale copy", order: 0 }));
  E.watchLists.push(E.normWatchlistEntry({ id, name: "Newer copy", order: 0 }));

  await E.CascadePersistence.syncWatchlistsNow();

  assert.equal(state.upsertCalls.length, 1, "exactly one upsert must have been attempted");
  const upsertIds = state.upsertCalls[0].map(r => r.id);
  assert.equal(new Set(upsertIds).size, upsertIds.length, "the upsert payload must never contain a repeated id");
  assert.equal(upsertIds.filter(x => x === id).length, 1, "the shared id must appear exactly once");
}));

test("CAS-681 AC4: a watch-list setting changed locally reaches the account and survives a reload", () => withCas681State(async () => {
  const id = "cas681-0000-4000-8000-000000000003";
  const remoteRow = { id, user_id: "cas681-test-user",
    criteria: { name: "My List", icon: "🎬", order: 0, svcOn: [], cascOff: [], watchedOn: [], watchTiers: [], sort: "score" } };
  const { client, state } = fakeWatchlistSupabase([remoteRow]);
  signInWithClient(client);

  E.watchLists.length = 0;
  await E.CascadePersistence.loadWatchlistAccount();
  assert.equal(E.watchLists.find(l => l.id === id).sort, "score", "sanity: starts on the remote value");

  // The Edit-screen tap: change a setting locally, then let the (fixed) sync path push it.
  E.watchLists.find(l => l.id === id).sort = "az";
  await E.CascadePersistence.syncWatchlistsNow();
  assert.equal(state.rows.find(r => r.id === id).criteria.sort, "az", "the account row must reflect the local edit");

  // "Survives a reload": a fresh load (as a new session/tab would do) must see the edit, not the stale value.
  E.watchLists.length = 0;
  await E.CascadePersistence.loadWatchlistAccount();
  assert.equal(E.watchLists.find(l => l.id === id).sort, "az", "a reload must show the edit that was pushed, not the pre-edit value");
}));

// ---- SIGNED IN, A WATCH-LIST EDIT IS DURABLE THE INSTANT IT'S MADE, AND A SYNC FAILURE IS VISIBLE (CAS-691) -
// saveWatchlists used to, while signed in, write NOTHING durable — it only scheduled an account push, so a
// reload before that push landed (or a push that failed outright) silently reverted the edit, and the failure
// itself was a bare console.warn. These tests exercise the real wrapped save (window.CascadePersistence's
// saveWatchlists, the same chokepoint every Edit-screen tap calls) and the guest-cache reload seam
// (loadGuestWatchlist) a cold boot runs before the account fan-out ever gets a chance to respond.
function fakeFlakyWatchlistSupabase(initialRows){
  const state = { rows: initialRows.slice(), down: false };
  const client = {
    from(table){
      assert.equal(table, "watchlists", "the watch-list seam must only ever touch the watchlists table");
      return {
        select(){
          if(state.down){
            return { eq(){ return this; }, in(){ return this; }, is(){ return this; },
              maybeSingle: async () => ({ data: null, error: { message: "network unreachable" } }),
              then(resolve, reject){ return Promise.resolve({ data: null, error: { message: "network unreachable" } }).then(resolve, reject); } };
          }
          return wlSelectBuilder(state.rows);
        },
        upsert(rows){
          if(state.down){
            const result = { data: null, error: { message: "network unreachable" } };
            return { select: async () => result, then(resolve, reject){ return Promise.resolve(result).then(resolve, reject); } };
          }
          const nowIso = new Date().toISOString();
          rows.forEach(r => {
            const stored = { ...r, updated_at: nowIso };
            const i = state.rows.findIndex(x => x.id === r.id);
            if(i >= 0) state.rows[i] = stored; else state.rows.push(stored);
          });
          const result = { data: rows.map(r => ({ id: r.id, updated_at: nowIso })), error: null };
          return { select: async () => result, then(resolve, reject){ return Promise.resolve(result).then(resolve, reject); } };
        },
        update(patch){
          return { eq(){
            return { in: async (col, ids) => {
              if(state.down) return { error: { message: "network unreachable" } };
              ids.forEach(id => { const i = state.rows.findIndex(x => x.id === id); if(i >= 0) state.rows[i] = { ...state.rows[i], ...patch }; });
              return { error: null };
            } };
          } };
        },
      };
    },
  };
  return { client, state };
}

test("CAS-691 AC1/AC6: a rename made while signed in survives a reload before the push completes, and is flagged not-yet-saved", () => withCas681State(async () => {
  const id = "ca691000-0000-4000-8000-000000000001";
  const remoteRow = { id, user_id: "cas681-test-user",
    criteria: { name: "Old Name", icon: "🎬", order: 0, svcOn: [], cascOff: [], watchedOn: [], watchTiers: [], sort: "score" } };
  const { client } = fakeFlakyWatchlistSupabase([remoteRow]);
  signInWithClient(client);

  E.watchLists.length = 0;
  E.watchLists.push(E.normWatchlistEntry({ id, name: "Old Name", icon: "🎬", order: 0,
    svcOn: [], cascOff: [], watchedOn: [], watchTiers: [], sort: "score" }));
  await E.CascadePersistence.loadWatchlistAccount();   // establishes the baseline, as a real sign-in would

  // The edit: rename it through the real wire-code save — but never await/flush the network push, the same
  // way a reload interrupting an in-flight request would.
  E.watchLists.find(l => l.id === id).name = "New Name";
  E.CascadePersistence.saveWatchlists();

  assert.equal(JSON.parse(E.localStorage.getItem("cascade_watchlist")).find(l => l.id === id).name, "New Name",
    "the rename must be written to the on-device cache the instant it's made, not only scheduled for the network");
  assert.equal(E.CascadePersistence.acctTablePending.watchlists, true, "the app must indicate the change is not yet saved to the account");

  // "Reload": a cold boot always re-reads the on-device cache first, before the account fan-out responds.
  E.CascadePersistence.loadGuestWatchlist();
  assert.equal(E.watchLists.find(l => l.id === id).name, "New Name", "the new name must still be present immediately after a reload");

  // The account fan-out now runs against a remote that still has the OLD name (the earlier push never
  // completed) — the merge must not let the stale remote name win over the not-yet-synced local rename.
  await E.CascadePersistence.loadWatchlistAccount();
  assert.equal(E.watchLists.find(l => l.id === id).name, "New Name", "a signed-in load landing on top of an unsynced rename must not revert it");
}));

test("CAS-691 AC2/AC3: a delete made while the account is unreachable stays deleted locally and is flagged local-only, then clears once reachable again", () => withCas681State(async () => {
  const idKeep = "ca691000-0000-4000-8000-000000000010";
  const idGone = "ca691000-0000-4000-8000-000000000011";
  const remoteRows = [
    { id: idKeep, user_id: "cas681-test-user", criteria: { name: "Keep", icon: "🎬", order: 0, svcOn: [], cascOff: [], watchedOn: [], watchTiers: [], sort: "score" } },
    { id: idGone, user_id: "cas681-test-user", criteria: { name: "Gone", icon: "🎬", order: 1, svcOn: [], cascOff: [], watchedOn: [], watchTiers: [], sort: "score" } },
  ];
  const { client, state } = fakeFlakyWatchlistSupabase(remoteRows);
  signInWithClient(client);
  E.watchLists.length = 0;
  await E.CascadePersistence.loadWatchlistAccount();
  assert.equal(E.watchLists.length, 2, "sanity: both lists loaded");

  state.down = true;   // AC2: the account is unreachable from here
  E.watchLists.splice(E.watchLists.findIndex(l => l.id === idGone), 1);
  E.CascadePersistence.saveWatchlists();
  await E.CascadePersistence.syncWatchlistsNow();   // the immediate push attempt, which fails

  assert.ok(!JSON.parse(E.localStorage.getItem("cascade_watchlist")).some(l => l.id === idGone),
    "the delete must be written to the on-device cache even though the account push failed");
  assert.equal(E.CascadePersistence.acctTablePending.watchlists, true, "a failed push must be visible, not silently dropped");

  // "Reload": cold boot re-reads the (correctly-deleted) local cache.
  E.CascadePersistence.loadGuestWatchlist();
  assert.ok(!E.watchLists.some(l => l.id === idGone), "the delete must still hold after a reload");
  assert.ok(state.rows.some(r => r.id === idGone), "sanity: the account itself still has the stale row while unreachable");

  state.down = false;   // AC3: reachable again
  await E.CascadePersistence.syncWatchlistsNow();
  // CAS-692 req3: a delete is now a tombstone (deleted_at set), never a removed row — an offline device
  // must not be able to read an absent row as "never existed" and resurrect it.
  const goneRow = state.rows.find(r => r.id === idGone);
  assert.ok(goneRow, "the row itself must still exist — a delete tombstones it, it never removes the row");
  assert.ok(goneRow.deleted_at, "the delete must reach the account once it's reachable again, as a tombstone");
  assert.equal(E.CascadePersistence.acctTablePending.watchlists, false, "the flag must clear once the push actually lands");
}));

test("CAS-691 AC4: acctTableFail.watchlists is a visible flag, not silence, and it clears on the next successful load", () => withCas681State(async () => {
  const { client } = fakeWatchlistSupabase([]);
  signInWithClient(client);
  const brokenClient = { from(){ return { select(){ return { eq(){ return this; }, in(){ return this; }, is(){ return this; },
    then(resolve, reject){ return Promise.resolve({ data: null, error: { message: "down" } }).then(resolve, reject); } }; } }; } };
  E.CascadeAuth.client = brokenClient;
  await E.CascadePersistence.loadWatchlistAccount();
  assert.equal(E.CascadePersistence.acctTableFail.watchlists, true, "a failed load must flip the visible flag, not just console.warn");

  E.CascadeAuth.client = client;
  await E.CascadePersistence.loadWatchlistAccount();
  assert.equal(E.CascadePersistence.acctTableFail.watchlists, false, "a later successful load must clear the flag");
}));

test("CAS-691 neighbours: saveCascades also mirrors to the on-device cache immediately while signed in — the identical wrapper hole CAS-691 fixed for watch lists", () => withCas681State(async () => {
  signInWithClient(fakeWatchlistSupabase([]).client);
  const before = E.cascades.length;
  E.cascades.push(E.normCascade({ id: "ca691ca5-0000-4000-8000-000000000001", name: "Neighbour Agent" }));
  E.CascadePersistence.saveCascades();
  const cached = JSON.parse(E.localStorage.getItem("cascade_cascades") || "[]");
  assert.ok(cached.some(c => c.id === "ca691ca5-0000-4000-8000-000000000001"),
    "saveCascades must mirror to the on-device cache immediately while signed in, not only schedule an account sync");
  E.cascades.length = before;
}));

test("CAS-733 AC7: CascadePersistence exposes no CAS-212 merge-sheet seam — signed-out is no longer a usable state to offer a merge away from", () => {
  const keys = Object.keys(E.CascadePersistence);
  assert.ok(!keys.includes("offerMerge"), "CascadePersistence must not expose offerMerge");
  assert.ok(!keys.includes("pendingMerge"), "CascadePersistence must not expose pendingMerge");
  assert.ok(!keys.includes("renderMigrate"), "CascadePersistence must not expose renderMigrate");
});

// ---- WATCH-LIST EDITS SURVIVE ACROSS DEVICES: DIRTY-ROW SYNC, VERSIONING, TOMBSTONES (CAS-692) -------------
// CAS-691 made an edit durable on the device that made it; it did nothing for a SECOND device, because
// syncWatchlistsToAccount pushed this device's entire watchLists set on every save and deletion was
// inferred by diffing against a private per-device baseline — a stale device could silently resurrect a
// list another device had deleted, or clobber a row it had never itself touched. These tests exercise the
// same real seam as CAS-681/691 above, simulating a second device's writes by mutating the fake account's
// `state.rows` directly (bypassing this device's own code), the way CAS-691's own tests simulate a remote
// that hasn't caught up yet.
test("CAS-692 AC1 (data layer): a delete confirmed on the account is never resurrected by a load that also carries this device's own unrelated edit", () => withCas681State(async () => {
  const idKeep = "cas692-0000-4000-8000-000000000001";
  const idGone = "cas692-0000-4000-8000-000000000002";
  const remoteRows = [
    { id: idKeep, user_id: "cas681-test-user", criteria: { name: "List 1", icon: "🎬", order: 0, svcOn: [], cascOff: [], watchedOn: [], watchTiers: [], sort: "score" } },
    { id: idGone, user_id: "cas681-test-user", criteria: { name: "List 2", icon: "🎬", order: 1, svcOn: [], cascOff: [], watchedOn: [], watchTiers: [], sort: "score" } },
  ];
  const { client, state } = fakeWatchlistSupabase(remoteRows);
  signInWithClient(client);

  // Device B loads both lists — "still showing list 2" per the AC's own wording.
  E.watchLists.length = 0;
  await E.CascadePersistence.loadWatchlistAccount();
  assert.equal(E.watchLists.length, 2, "sanity: both lists loaded");

  // Device A deletes list 2 — simulated as a tombstone landing directly on the shared account, since B
  // never reloads before making its own change (exactly the AC's setup).
  state.rows.find(r => r.id === idGone).deleted_at = "2026-01-01T00:00:00.000Z";

  // Device B, unaware, makes an unrelated change to list 1 and pushes it.
  E.watchLists.find(l => l.id === idKeep).sort = "az";
  E.CascadePersistence.saveWatchlists();
  await E.CascadePersistence.syncWatchlistsNow();
  assert.equal(state.rows.find(r => r.id === idKeep).criteria.sort, "az", "list 1's edit must reach the account");

  // "Reload both": list 2 must be gone, and list 1 must carry B's change.
  E.watchLists.length = 0;
  await E.CascadePersistence.loadWatchlistAccount();
  assert.ok(!E.watchLists.some(l => l.id === idGone), "the tombstoned list must never reappear after a reload");
  assert.equal(E.watchLists.find(l => l.id === idKeep).sort, "az", "the unrelated edit must survive the reload");
}));

test("CAS-692 AC5 (data layer): a tombstoned list never reappears, including on a device that was offline from before the deletion until after it", () => withCas681State(async () => {
  const idKeep = "cas692-0000-4000-8000-000000000010";
  const idGone = "cas692-0000-4000-8000-000000000011";
  const remoteRows = [
    { id: idKeep, user_id: "cas681-test-user", criteria: { name: "Keep", icon: "🎬", order: 0, svcOn: [], cascOff: [], watchedOn: [], watchTiers: [], sort: "score" } },
    { id: idGone, user_id: "cas681-test-user", criteria: { name: "Gone", icon: "🎬", order: 1, svcOn: [], cascOff: [], watchedOn: [], watchTiers: [], sort: "score" } },
  ];
  const { client, state } = fakeWatchlistSupabase(remoteRows);
  signInWithClient(client);

  // This device saw both lists before going offline.
  E.watchLists.length = 0;
  await E.CascadePersistence.loadWatchlistAccount();
  assert.equal(E.watchLists.length, 2, "sanity: both lists loaded before going offline");

  // While this device is away, another device deletes "Gone" — tombstoned directly on the account.
  state.rows.find(r => r.id === idGone).deleted_at = "2026-01-01T00:00:00.000Z";

  // This device returns and reconciles in the background (the tab-focus path), never doing a full reload.
  await E.CascadePersistence.reconcileWatchlists();
  assert.ok(!E.watchLists.some(l => l.id === idGone), "a background reconcile must drop a list tombstoned while this device was away");
  assert.ok(E.watchLists.some(l => l.id === idKeep), "the untouched list must remain");
}));

test("CAS-692 req1/AC3: a device that changed nothing never issues a watchlists upsert", () => withCas681State(async () => {
  const id = "cas692-0000-4000-8000-000000000020";
  const remoteRow = { id, user_id: "cas681-test-user", criteria: { name: "Untouched", icon: "🎬", order: 0, svcOn: [], cascOff: [], watchedOn: [], watchTiers: [], sort: "score" } };
  const { client, state } = fakeWatchlistSupabase([remoteRow]);
  signInWithClient(client);

  E.watchLists.length = 0;
  await E.CascadePersistence.loadWatchlistAccount();
  await E.CascadePersistence.syncWatchlistsNow();   // nothing has changed since the load
  assert.equal(state.upsertCalls.length, 0, "a device that has made no changes must never write any row");
}));

test("CAS-692 req2: a write whose base version is stale is refused, and the newer remote edit wins instead of being silently lost", () => withCas681State(async () => {
  const id = "cas692-0000-4000-8000-000000000030";
  const remoteRow = { id, user_id: "cas681-test-user", criteria: { name: "Original", icon: "🎬", order: 0, svcOn: [], cascOff: [], watchedOn: [], watchTiers: [], sort: "score" } };
  const { client, state } = fakeWatchlistSupabase([remoteRow]);
  signInWithClient(client);

  E.watchLists.length = 0;
  await E.CascadePersistence.loadWatchlistAccount();   // establishes this device's base version

  // Another device writes a newer version directly to the account after this device last read it.
  const row = state.rows.find(r => r.id === id);
  row.criteria = { ...row.criteria, name: "Renamed elsewhere" };
  row.updated_at = "2099-01-01T00:00:00.000Z";

  // This device, unaware, edits the same list and tries to push.
  E.watchLists.find(l => l.id === id).sort = "az";
  E.CascadePersistence.saveWatchlists();
  await E.CascadePersistence.syncWatchlistsNow();

  assert.equal(state.upsertCalls.length, 0, "a stale-based write must be refused, not upserted");
  assert.equal(E.watchLists.find(l => l.id === id).name, "Renamed elsewhere",
    "the newer remote edit must win locally rather than this device's stale-based edit silently overwriting it");
}));

// ---- THE WATCH-LIST CARD AND SECTION COUNTS DESCRIBE WHAT render() ACTUALLY PUTS ON SCREEN (CAS-682) ------
// Reported case: list "Lee Stream", scope bar set to For review + Watched, Notify off. The deck card read 234
// (watchlistRawCount — the raw agent union, ignoring the scope bar AND the list's own svcOn/watchedOn/
// watchTiers entirely). The Rent section read 53 against 58 rendered rows (`items.filter(!taggedOut)` dropped
// five stubs the section still drew). Fix: the card now takes render()'s own `rows` (scopeRows(), the exact
// set the sections are built from); each section header counts every item in its group, stubs included.
// AC1/AC6 are checked structurally (render() is DOM-bound and not itself callable from this harness, exactly
// like CAS-662's own AC1) — AC2/AC3/AC4 are checked arithmetically against the same `rows`/`listingGroups`
// render() reads, reproducing the reported scope combination.
test("CAS-682 AC1/AC6: render() feeds the deck card scopeRows()'s own `rows`, not a pre-scope pool", () => {
  const src = fs.readFileSync(path.join(ROOT, "app_template.html"), "utf8");
  const renderStart = src.indexOf("\nfunction render(){");
  assert.ok(renderStart >= 0, "render() was not found");
  const renderEnd = src.indexOf("\n// ---- CAS-275", renderStart);
  assert.ok(renderEnd > renderStart, "the end of render() was not found");
  const renderBody = src.slice(renderStart, renderEnd);
  assert.ok(renderBody.includes("renderCascadeBar(rows.length)"),
    "the deck card must be handed rows.length — the exact set the listing below is built from");
  assert.ok(!renderBody.includes("pool.filter(m=>!taggedOut(m)).length"),
    "the deck card must no longer fall back to the pre-scope pool count");
});

test("CAS-682 AC3: render() counts every row a section holds, stubs included, no taggedOut subtraction", () => {
  const src = fs.readFileSync(path.join(ROOT, "app_template.html"), "utf8");
  const renderStart = src.indexOf("\nfunction render(){");
  const renderEnd = src.indexOf("\n// ---- CAS-275", renderStart);
  const renderBody = src.slice(renderStart, renderEnd);
  assert.ok(renderBody.includes("const live=items.length;"),
    "each group's header count must equal every row in that group");
  assert.ok(!renderBody.includes("items.filter(m=>!taggedOut(m)).length"),
    "the header must not subtract tagged-out stubs any more — a stub is still a rendered row");
});

// CAS-718: the scope bar's Watched pill this AC was reported against is retired — the reproduction now
// drives the same shape through watchWatchedSel + filmMatchesWatchedFilter (render()'s own post-scopeRows
// step, see its comment), since scopeRows() itself no longer narrows by Watched state at all.
test("CAS-682/CAS-718 AC2/AC4: reproducing a Watched selection — toggling watchWatchedSel moves the post-scope row count, and listingGroups() carries the resulting stub into its section", () => {
  const ids = seedNCascades(1);
  try {
    withCas680List(ids, () => {
      E.ymCascSetAll(true);
      E.ymSvcSetAll(true);
      const feed = E.ymFeedList();
      assert.ok(feed.length > 0, "sanity: the reproduction must match at least one film");
      const target = feed[0];
      const wasWatched = E.watched.has(target.tmdb_id);
      E.watched.add(target.tmdb_id);   // opinionOf -> "liked": a tagged-out film, same shape as the reported case
      assert.ok(E.taggedOut(target), "sanity: marking it watched must make it a stub");
      const tab = E.watchTab;
      const savedSel = new Set(E.watchWatchedSel[tab]);
      try {
        E.watchWatchedSel[tab].clear();
        E.watchWatchedSel[tab].add(E.opinionOf(target.tmdb_id));
        assert.ok(E.scopeRows().filter(E.filmMatchesWatchedFilter).some(m => m.tmdb_id === target.tmdb_id),
          "sanity: the stub's own verdict selected must surface it in the reproduced set");

        // AC2: the count moves when the Watched selection is toggled.
        const withSelection = E.scopeRows().filter(E.filmMatchesWatchedFilter).length;
        E.watchWatchedSel[tab].clear();
        const withoutSelection = E.scopeRows().filter(E.filmMatchesWatchedFilter).length;
        assert.notEqual(withoutSelection, withSelection,
          "clearing the Watched selection must change the row count — the card must move with it");
        assert.ok(!E.scopeRows().filter(E.filmMatchesWatchedFilter).some(m => m.tmdb_id === target.tmdb_id),
          "sanity: clearing the selection must drop the stub again");

        // AC1/AC3 arithmetic: back to the reproduced selection, the card's set and the sections' own sets
        // must agree exactly, and the stub's section must still hold it.
        E.watchWatchedSel[tab].add(E.opinionOf(target.tmdb_id));
        const rows = E.scopeRows().filter(E.filmMatchesWatchedFilter);
        const ac = E.cascades.find(c => c.id === ids[0]);
        const groups = E.listingGroups(rows, ac);
        const total = groups.reduce((n, x) => n + x.items.length, 0);
        assert.equal(total, rows.length,
          "every row must land in exactly one group — the card and the section headers must describe the same set");
        const grp = groups.find(x => x.items.some(m => m.tmdb_id === target.tmdb_id));
        assert.ok(grp, "the stub's own section must still hold it, not silently drop it from the count");
      } finally {
        E.watchWatchedSel[tab].clear();
        savedSel.forEach(k => E.watchWatchedSel[tab].add(k));
        if(!wasWatched) E.watched.delete(target.tmdb_id);
      }
    });
  } finally {
    unseedCascades(ids);
  }
});

// ---- CONDENSED CARD STATS ROW IS A PER-FILM DECISION (CAS-686) --------------------------------------------
// CAS-624 gated the condensed card's money-vs-scores row on the LISTING (#groups.cinema-listing — every card
// under a cinema agent got the money row, no matter what the film itself held). CAS-686 replaces that with a
// per-FILM rule: a film showing the scores row needs at least one of a reliable IMDb rating, an RT critic
// score or a Metacritic score; a film with none of the three gets the money row instead — a count or a row
// that doesn't describe the film beside it is this project's own repeat failure mode (CAS-680, CAS-682), so
// this asserts the predicate directly rather than spot-checking a rendered card.
test("CAS-686: condensedShowsScores agrees with the three-source rule, over fixture films covering every combination", () => {
  const threeSourceRule = m => E.imdbReliable(m) || m.rt_critic!=null || m.metacritic!=null;
  const fixtures = [
    { title: "None",             imdb_rating: null, imdb_votes: 0 },
    { title: "IMDb only, reliable",    imdb_rating: 7.1, imdb_votes: E.IMDB_MIN_VOTES },
    { title: "IMDb only, below floor", imdb_rating: 8.5, imdb_votes: E.IMDB_MIN_VOTES - 1 },
    { title: "RT only",          imdb_rating: null, imdb_votes: 0, rt_critic: 90 },
    { title: "Meta only",        imdb_rating: null, imdb_votes: 0, metacritic: 55 },
    { title: "RT + Meta, no IMDb", imdb_rating: null, imdb_votes: 0, rt_critic: 40, metacritic: 45 },
    { title: "IMDb reliable + RT", imdb_rating: 6.0, imdb_votes: E.IMDB_MIN_VOTES, rt_critic: 20 },
    { title: "All three",        imdb_rating: 5.5, imdb_votes: E.IMDB_MIN_VOTES, rt_critic: 60, metacritic: 60 },
    { title: "Below-floor IMDb + RT + Meta", imdb_rating: 9.9, imdb_votes: E.IMDB_MIN_VOTES - 1, rt_critic: 30, metacritic: 35 },
  ];
  for(const m of fixtures){
    assert.equal(E.condensedShowsScores(m), threeSourceRule(m),
      `${m.title}: condensedShowsScores disagrees with the three-source rule`);
  }
  // …and over the real catalogue, so the invariant also holds for whatever the fixture list didn't think of.
  for(const m of E.MOVIES){
    assert.equal(E.condensedShowsScores(m), threeSourceRule(m),
      `${m.title}: condensedShowsScores disagrees with the three-source rule`);
  }
});

// ---- CAS-695: THE CINEMA (PRE-RELEASE) CASCADE SCORE -------------------------------------------------------
// Before this, qScore (People's vote/Critics) was the only Cascade score, and it scores from reviews that a
// pre-release film cannot have yet — 85% of Upcoming and 79% of In Cinema carried no score. cascadeScore picks
// its basis by where the film is in its life: the cinema score (buzz percentile, CAS-722) pre-release, the
// streaming score (qScore) once released. PVOD sits on the streaming side by decision (it is released).
test("CAS-695 AC1: the score's basis switches on isPreRelease — cinema (buzz) before release, streaming (qScore) after", () => {
  const preReleaseFilm = E.MOVIES.find(m => isPreRelease(m) && E.cascadeScore(m) >= 0);
  assert.ok(preReleaseFilm, "no scored pre-release film found — this test would prove nothing");
  assert.equal(E.cascadeScore(preReleaseFilm), E.cinemaScore(preReleaseFilm),
    `${preReleaseFilm.title}: pre-release film's Cascade score is not its cinema score`);

  const releasedFilm = E.MOVIES.find(m => !isPreRelease(m) && E.qScore(m) >= 0);
  assert.ok(releasedFilm, "no scored released film found — this test would prove nothing");
  assert.equal(E.cascadeScore(releasedFilm), E.qScore(releasedFilm),
    `${releasedFilm.title}: released film's Cascade score is not its (streaming) qScore`);

  // Whole catalogue: the same dispatch, never the other formula.
  for(const m of E.MOVIES){
    const expected = isPreRelease(m) ? E.cinemaScore(m) : E.qScore(m);
    assert.equal(E.cascadeScore(m), expected, `${m.title}: cascadeScore disagrees with the basis its own status picks`);
  }
});

// ---- CAS-722: THE CINEMA SCORE'S BASIS NARROWS TO BUZZ ALONE -----------------------------------------------
// Measured against the 5,750-film catalogue: of the 995 cohort films that carried both buzz and budget
// terms, dropping budget changed cinemaScore by a median of 0, and only 60 (6%) moved by more than 10
// points. Budget is becoming an admission REQUIREMENT on a separate ticket, and nothing which admits a film
// is also a term in its score — so budget leaves cinemaScore entirely in this release (AC1).
test("CAS-722 AC1: cinemaScore is exactly buzzPctlOf for a cohort film, -1 with no numeric popularity", () => {
  const cohort = E.MOVIES.filter(m => E.inLadderCohort(m));
  const scored = cohort.filter(m => typeof m.popularity === "number");
  const unscored = cohort.filter(m => typeof m.popularity !== "number");
  assert.ok(scored.length > 0, "no cohort film with numeric popularity found — this test would prove nothing");
  assert.ok(unscored.length > 0, "no cohort film with no numeric popularity found — this test would prove nothing");
  for(const m of scored){
    assert.equal(E.cinemaScore(m), E.buzzPctlOf(m), `${m.title}: cinemaScore disagrees with buzzPctlOf`);
  }
  for(const m of unscored){
    assert.equal(E.cinemaScore(m), -1, `${m.title}: a cohort film with no numeric popularity should not score`);
  }
});

// AC2: percentile makes the buzz axis agree with the ladder's own badges "for free" now that cinemaScore IS
// buzzPctlOf — a film clearing a badge always carries a Cascade score at or above that badge's own cut. (The
// converse — a score at or above a floor always implying that exact badge — does not hold: buzzStop's
// BUZZ_CUTS cutoffs are looked up by raw popularity against a floor-indexed array value, while the score is
// a rounded percentile RANK, so a film can round up to a threshold's score without its raw popularity having
// crossed the value recorded at that index. Measured on the real catalogue: 15 of 995 cohort films sit in
// that seam — a pre-existing property of the two lookups, not a defect this ticket introduces, so this only
// asserts the direction that is actually guaranteed.)
test("CAS-722 AC2: a badge-tier film's Cascade score is always at or above that badge's own floor", () => {
  const FLOOR = { anticipated: E.BUZZ_PCTL[1], blockbuster: E.BUZZ_PCTL[2], mustsee: E.BUZZ_PCTL[3] };
  let checked = 0;
  for(const m of E.MOVIES){
    const badge = E.scaleTier(m);
    if(!FLOOR[badge]) continue;
    checked++;
    const score = E.cinemaScore(m);
    assert.ok(score >= FLOOR[badge], `${m.title}: badged ${badge} but Cascade score is ${score}, under the ${FLOOR[badge]} floor`);
  }
  assert.ok(checked > 0, "no badged film found — this test would prove nothing");
});

// AC4: the cohort's sorted popularity and budget arrays are module-level consts, built once at load — never
// re-sorted per card. Asserted the same way CAS-678's own performance claim is: the same array reference
// (by identity) comes back on repeat reads, and it is already sorted ascending.
test("CAS-695 AC4: the cohort's popularity and budget arrays are sorted once, not per card", () => {
  assert.ok(E.BUZZ_POP_VALS.length > 0 && E.CINEMA_BUDGET_VALS.length > 0, "the cohort arrays are empty — this test would prove nothing");
  for(let i = 1; i < E.BUZZ_POP_VALS.length; i++) assert.ok(E.BUZZ_POP_VALS[i] >= E.BUZZ_POP_VALS[i - 1], "BUZZ_POP_VALS is not sorted ascending");
  for(let i = 1; i < E.CINEMA_BUDGET_VALS.length; i++) assert.ok(E.CINEMA_BUDGET_VALS[i] >= E.CINEMA_BUDGET_VALS[i - 1], "CINEMA_BUDGET_VALS is not sorted ascending");
  // Reading buzzPctlOf/pctRankOf a second time for the same films must not mutate or resize the arrays.
  // CAS-722 retired budgetPctlOf itself (budget left the score); CINEMA_BUDGET_VALS survives only for
  // missionScoreStats' cinema Budget dial, so this reads it the same way that call site does.
  const popLen = E.BUZZ_POP_VALS.length, budgetLen = E.CINEMA_BUDGET_VALS.length;
  for(const m of E.MOVIES.filter(m => E.inLadderCohort(m)).slice(0, 20)){
    E.buzzPctlOf(m);
    E.pctRankOf(E.CINEMA_BUDGET_VALS, m.budget || m.worldwide_gross || 0);
  }
  assert.equal(E.BUZZ_POP_VALS.length, popLen, "BUZZ_POP_VALS changed size after scoring films");
  assert.equal(E.CINEMA_BUDGET_VALS.length, budgetLen, "CINEMA_BUDGET_VALS changed size after scoring films");
});

// AC4 (CAS-722): the card's own tooltip must name only Buzz for a pre-release film now — never a budget term
// that no longer exists — and keep naming the streaming axes exactly as qScoreSourcesText does once released.
test("CAS-722 AC4: cascadeScoreSourcesText names only Buzz pre-release, never Budget", () => {
  const cohort = E.MOVIES.filter(m => E.inLadderCohort(m));
  const buzzed = cohort.find(m => E.buzzPctlOf(m) != null);
  assert.ok(buzzed, "no buzz-scored cohort film found — this test would prove nothing");
  assert.equal(E.cascadeScoreSourcesText(buzzed), "Buzz");
  for(const name of ["Budget", "People's vote", "Critics"]){
    assert.ok(!E.cascadeScoreSourcesText(buzzed).includes(name), `cascadeScoreSourcesText named ${name} on a pre-release film`);
  }

  const releasedFilm = E.MOVIES.find(m => !isPreRelease(m) && E.qScore(m) >= 0);
  assert.ok(releasedFilm, "no scored released film found — this test would prove nothing");
  assert.equal(E.cascadeScoreSourcesText(releasedFilm), E.qScoreSourcesText(releasedFilm),
    `${releasedFilm.title}: released film's basis text should be exactly qScoreSourcesText's`);
});

// CAS-724: an agent saved before c.scoreFloor existed migrates it, once, from whichever legacy Mission dials
// it had ON — the same formula the retired missionScoreStats used, now a one-time normCascade migration
// rather than a live admission input. Exercised through the public migration path, not a retired internal
// function (removed with the OR block it served).
test("CAS-724: an agent's scoreFloor migrates once from its legacy Mission dials' own mean", () => {
  const migrate = overrides => E.normCascade({ ...overrides }, { template: true }).scoreFloor;
  assert.equal(migrate({ kind: "cinema", selBuzz: 0, selScale: 0 }), 0, "no cinema dial on should migrate to a floor of 0");
  assert.equal(migrate({ kind: "cinema", selBuzz: 2, selScale: 0 }), E.BUZZ_PCTL[2], "Buzz alone should migrate to its own percentile");
  const scaleFloorD = E.CINEMA_BUDGET_VALS[Math.floor(E.CINEMA_BUDGET_VALS.length / 2)];
  const scalePctl = E.pctRankOf(E.CINEMA_BUDGET_VALS, scaleFloorD);
  assert.equal(migrate({ kind: "cinema", selBuzz: 0, selScale: scaleFloorD }), scalePctl,
    "Budget alone should migrate to its dollar floor's own percentile");
  assert.equal(migrate({ kind: "cinema", selBuzz: 2, selScale: scaleFloorD }),
    Math.round((E.BUZZ_PCTL[2] + scalePctl) / 2), "both cinema dials on should migrate to their mean");

  // The stream lane keeps CAS-694's own formula exactly — a kind other than "cinema" must not be re-routed.
  assert.equal(migrate({ kind: "stream", selCrowd: 7.5, selCritScore: 0, selBuzz: 0, selScale: 0 }), 75,
    "a stream agent's migrated floor changed even though its own dials (People's vote/Critics) are untouched by this ticket");

  // Once set, scoreFloor is authoritative and is never recomputed from the dials again.
  assert.equal(migrate({ kind: "cinema", selBuzz: 2, selScale: 0, scoreFloor: 40 }), 40,
    "an agent that already carries scoreFloor had it overwritten by the legacy migration formula");
});

// ---- CAS-697: RECALIBRATED BUZZ LADDER + THE $1M CINEMA BUDGET FLOOR --------------------------------------
// The cinema Mission target was unusable: a Budget dial at its minimum already read 57, and any Buzz setting
// pushed it to 90. Two input constants were wrong, not the formula — BUZZ_PCTL widens 95/97/99 to 65/85/95,
// and CINEMA_BUDGET_VALS drops the sub-$1M TMDB placeholder rows that were dragging the budget percentile
// down. Asserted against the live constants, never fixed counts, so a catalogue refresh cannot go stale.
test("CAS-697 AC1/AC2: the Buzz ladder moved to [0,65,85,95] and badges a materially wider slice of the cohort", () => {
  assert.deepEqual([...E.BUZZ_PCTL], [0, 65, 85, 95], "the ladder's percentile stops have not moved to CAS-697's values");
  const cohort = E.MOVIES.filter(m => E.inLadderCohort(m));
  assert.ok(cohort.length > 0, "the cohort is empty — this test would prove nothing");
  const badged = cohort.filter(m => E.buzzBandOf(m));
  // Measured on the catalogue at ticket time: 5% under the old [0,95,97,99] ladder, 35% under the new one.
  // 20% is a safe threshold well clear of both, so a normal day-to-day catalogue refresh cannot flip this.
  assert.ok(badged.length / cohort.length > 0.2,
    `only ${badged.length} of ${cohort.length} cohort films are badged — the wider ladder does not appear to be in effect`);
});

// CAS-722 retired the score-path half of this (budget never contributes to cinemaScore any more — covered
// generally by the CAS-722 AC1 test above). CINEMA_BUDGET_VALS itself survives for missionScoreStats' cinema
// Budget dial, so the floor property is still worth keeping as its own invariant.
test("CAS-697 AC3: CINEMA_BUDGET_VALS is floored at CINEMA_BUDGET_MIN", () => {
  assert.ok(E.CINEMA_BUDGET_VALS.length > 0, "CINEMA_BUDGET_VALS is empty — this test would prove nothing");
  for(const v of E.CINEMA_BUDGET_VALS){
    assert.ok(v >= E.CINEMA_BUDGET_MIN, `CINEMA_BUDGET_VALS holds ${v}, below the CINEMA_BUDGET_MIN floor`);
  }
});

test("CAS-697 AC5: selScaleMatch (admission) reads every real budget with no CINEMA_BUDGET_MIN floor", () => {
  const small = { title: "Indie $500K", budget: 500000, worldwide_gross: 0 };
  assert.equal(E.selScaleMatch(small, { selScale: 100000 }), true,
    "a $500K film was not admitted by a $100K Budget dial — the score floor leaked into admission");
  // Whole catalogue: every sub-floor-budget cohort film must still be admitted by a dial set at or below its
  // own figure — this is the one way this ticket could quietly break every cinema agent.
  const cohort = E.MOVIES.filter(m => E.inLadderCohort(m));
  const subFloor = cohort.filter(m => {
    const v = m.budget || m.worldwide_gross || 0;
    return v > 0 && v < E.CINEMA_BUDGET_MIN;
  });
  assert.ok(subFloor.length > 0, "no sub-floor-budget cohort film found — this test would prove nothing");
  for(const m of subFloor){
    const v = m.budget || m.worldwide_gross || 0;
    assert.equal(E.selScaleMatch(m, { selScale: v }), true,
      `${m.title}: a $${v} film was not admitted by a Budget dial set at its own figure`);
  }
});

// ---- FILM_WATCH.SOURCES + AGENT_FILMS SURVIVE A RELOAD (CAS-726) ------------------------------------------
// Two pieces of state the rest of the "one score model" epic needs do not survive a page load on another
// device today: Watch On provenance (auto/manual per window) and the admitted set. These exercise the real
// seam (window.CascadePersistence) against a minimal fake Supabase client — same style as the CAS-681
// watch-list harness above (chainable enough for select()/upsert()/delete().eq().eq()…, no more), and reuse
// that section's signInWithClient/signOut since a signed-in fake client is exactly what both need.
function fakeCas726Supabase(seed){
  const state = { film_watch: (seed.film_watch || []).map(r => ({ ...r })),
                  agent_films: (seed.agent_films || []).map(r => ({ ...r })) };
  const keyOf = { film_watch: r => `${r.user_id}:${r.movie_id}`,
                  agent_films: r => `${r.user_id}:${r.cascade_id}:${r.movie_id}` };
  function selectBuilder(rows){
    return { then(resolve, reject){
      return Promise.resolve({ data: rows.map(r => ({ ...r })), error: null }).then(resolve, reject);
    } };
  }
  function deleteBuilder(table){
    const conds = [];
    const builder = {
      eq(col, val){ conds.push([col, val]); return builder; },
      then(resolve, reject){
        state[table] = state[table].filter(r => !conds.every(([c, v]) => r[c] === v));
        return Promise.resolve({ error: null }).then(resolve, reject);
      },
    };
    return builder;
  }
  const client = {
    from(table){
      return {
        select(){ return selectBuilder(state[table]); },
        upsert(rows){
          rows.forEach(row => {
            const i = state[table].findIndex(x => keyOf[table](x) === keyOf[table](row));
            if(i >= 0) state[table][i] = { ...state[table][i], ...row }; else state[table].push({ ...row });
          });
          return Promise.resolve({ error: null });
        },
        delete(){ return deleteBuilder(table); },
      };
    },
  };
  return { client, state };
}
function withCas726State(fn){
  const savedNotify = { ...E.notify };
  return (async () => {
    try { await fn(); }
    finally {
      Object.keys(E.notify).forEach(k => delete E.notify[k]);
      Object.assign(E.notify, savedNotify);
      signOut();
    }
  })();
}

test("CAS-726 AC2: a manual Watch On tick round-trips through film_watch.sources as \"manual\"", () => withCas726State(async () => {
  const m = E.MOVIES[0];
  const level = E.watchLevelsFor(m.tmdb_id).find(l => !l.spent);
  assert.ok(level, "no un-spent level to test on this film — the harness catalogue looks wrong");
  const { client } = fakeCas726Supabase({});
  signInWithClient(client);

  E.toggleFilmOpt(m.tmdb_id, level.key);          // the real manual-tick wire code, not a direct field poke
  await E.CascadePersistence.syncWatchesNow();
  await E.CascadePersistence.loadFilmWatches();    // simulate a reload: refetch the account from scratch

  assert.equal(E.filmWatchSource(m.tmdb_id), "manual",
    "a hand-ticked Watch On value must read back as manual provenance after a reload");
}));

test("CAS-726 AC2: an agent-armed Watch On value round-trips through film_watch.sources as \"auto\"", () => withCas726State(async () => {
  const m = E.MOVIES[1];
  const level = E.watchLevelsFor(m.tmdb_id).find(l => !l.spent);
  assert.ok(level, "no un-spent level to test on this film — the harness catalogue looks wrong");
  const remoteRow = { user_id: "cas681-test-user", movie_id: String(m.tmdb_id),
    windows: [level.key], sources: { [level.key]: "auto" } };
  const { client } = fakeCas726Supabase({ film_watch: [remoteRow] });
  signInWithClient(client);

  await E.CascadePersistence.loadFilmWatches();

  assert.equal(E.filmWatchSource(m.tmdb_id), "auto",
    "a remote row whose stored source is auto must read back as auto provenance");
}));

test("CAS-726 AC3: an existing film_watch row with no sources entry loads without error and reads as unset", () => withCas726State(async () => {
  const m = E.MOVIES[2];
  const level = E.watchLevelsFor(m.tmdb_id).find(l => !l.spent);
  assert.ok(level, "no un-spent level to test on this film — the harness catalogue looks wrong");
  // A row exactly as it existed before this ticket: windows only, no sources column value at all.
  const remoteRow = { user_id: "cas681-test-user", movie_id: String(m.tmdb_id), windows: [level.key] };
  const { client } = fakeCas726Supabase({ film_watch: [remoteRow] });
  signInWithClient(client);

  await assert.doesNotReject(() => E.CascadePersistence.loadFilmWatches());
  assert.equal(E.filmWatchSource(m.tmdb_id), null,
    "a pre-CAS-726 row must read back as source-unknown, not throw or invent a provenance");
}));

test("CAS-726 AC4: agent_films rows survive a reload and are readable by cascade_id", () => withCas726State(async () => {
  const cascadeIdA = "cas726-0000-4000-8000-000000000001";
  const cascadeIdB = "cas726-0000-4000-8000-000000000002";
  const filmA = E.MOVIES[3], filmB = E.MOVIES[4];
  const remoteRows = [
    { user_id: "cas681-test-user", cascade_id: cascadeIdA, movie_id: String(filmA.tmdb_id),
      admitted_at: "2026-09-01T00:00:00.000Z", admission_score: 88, admission_status: "in_cinema", agent_sig: "sig-a" },
    { user_id: "cas681-test-user", cascade_id: cascadeIdB, movie_id: String(filmB.tmdb_id),
      admitted_at: "2026-09-01T00:00:00.000Z", admission_score: 70, admission_status: "rental", agent_sig: "sig-b" },
  ];
  const { client } = fakeCas726Supabase({ agent_films: remoteRows });
  signInWithClient(client);

  await E.CascadePersistence.loadAgentFilms();

  const rowsA = E.CascadePersistence.agentFilmsFor(cascadeIdA);
  assert.equal(rowsA.length, 1, "agentFilmsFor must be scoped to the cascade it was asked about");
  assert.equal(rowsA[0].movie_id, String(filmA.tmdb_id));
  assert.equal(rowsA[0].admission_score, 88);
  assert.equal(rowsA[0].admission_status, "in_cinema");
  assert.equal(rowsA[0].agent_sig, "sig-a");
  assert.equal(E.CascadePersistence.agentFilmsFor(cascadeIdB).length, 1,
    "the other cascade's own row must not leak into cascadeIdA's read");
}));

test("CAS-726: a locally-written agent_films row (setAgentFilm) survives a push-then-reload round trip", () => withCas726State(async () => {
  const cascadeId = "cas726-0000-4000-8000-000000000003";
  const m = E.MOVIES[5];
  const { client } = fakeCas726Supabase({});
  signInWithClient(client);

  E.CascadePersistence.setAgentFilm(cascadeId, m.tmdb_id,
    { admission_score: 91, admission_status: "upcoming", agent_sig: "sig-c" });
  await E.CascadePersistence.syncAgentFilmsNow();
  await E.CascadePersistence.loadAgentFilms();   // simulate a reload

  const rows = E.CascadePersistence.agentFilmsFor(cascadeId);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].movie_id, String(m.tmdb_id));
  assert.equal(rows[0].admission_score, 91);
  assert.equal(rows[0].agent_sig, "sig-c");
}));

// ---- STICKY ADMISSION (CAS-728) -----------------------------------------------------------------------
// Once an agent admits a film, agent_films (CAS-726) holds it — recomputeFound stops re-testing it every
// pass — until the user watches/dismisses the film (out of scope for these) or the agent's OWN cascSigOf
// moves. Rows are seeded directly via CascadePersistence.setAgentFilm, the same seam CAS-726's own tests
// above use, rather than by hoping the live catalogue admits a chosen film through real dial values —
// CAS-727's placement tests solve that with a pin instead, but a pin bypasses admission entirely, which
// would prove nothing about IT. `withCas728State` mirrors withCas726State's own notify save/restore: the
// permissive test agents below can incidentally admit other real films while they're alive (arrivals are
// still tested normally), and restoring the whole of `E.notify` afterwards, not just the one id under test,
// is what actually cleans that up rather than leaving stray provenance on unrelated films.
function withCas728State(fn){
  const savedNotify = { ...E.notify };
  try { fn(); }
  finally {
    Object.keys(E.notify).forEach(k => delete E.notify[k]);
    Object.assign(E.notify, savedNotify);
  }
}
function pastCinemaUnwatchedFilm(excludeId){
  const m = E.MOVIES.find(x => !E.watched.has(x.tmdb_id) && x.tmdb_id !== excludeId
    && E.primaryStatus(x) === "rental");
  if(!m) throw new Error("no unwatched 'rental' film in the harness catalogue — this test would prove nothing");
  return m;
}
const STICKY_WATCH_PREFS = {
  in_cinema: { list: true, notify: false }, premium: { list: false, notify: false },
  rent: { list: true, notify: false }, stream: { list: true, notify: false },
};
// A near-impossible floor (99) keeps a freshly-seeded agent from also admitting half the catalogue as
// "arrivals" the moment recomputeFound runs — the row under test is written directly, below, regardless.
function stickyTestCascade(id, floor){
  const c = E.normCascade({ kind: "stream", status: [] });
  c.id = id; c.paused = false; c.order = 0;
  c.watchMarkers = { in_cinema: floor, premium: null, rent: floor, stream: floor };
  return c;
}

test("CAS-728 AC2: an unedited agent keeps a film admitted after it moves past its admission window", () => withCas728State(() => {
  withWatchPrefs(STICKY_WATCH_PREFS, () => {
    const film = pastCinemaUnwatchedFilm();
    const id = film.tmdb_id;
    const c = stickyTestCascade("cas728-ac2", 99);
    E.cascades.push(c);
    const sig = E.cascSigOf(c);
    try {
      E.CascadePersistence.setAgentFilm(c.id, id,
        { admission_score: 90, admission_status: "in_cinema", agent_sig: sig });
      E.recomputeFound();
      const row = E.CascadePersistence.agentFilmsFor(c.id).find(r => r.movie_id === String(id));
      assert.ok(row, "an unedited agent must not drop a film whose status has simply moved on");
      assert.equal(row.admission_score, 90, "the stored admission_score must survive untouched — no retest happened");
    } finally { unseedCascade(c.id); }
  });
}));

test("CAS-728 AC3: raising the floor past a film's stored admission_score drops it on re-evaluation", () => withCas728State(() => {
  withWatchPrefs(STICKY_WATCH_PREFS, () => {
    const film = pastCinemaUnwatchedFilm();
    const id = film.tmdb_id;
    const c = stickyTestCascade("cas728-ac3", 99);
    E.cascades.push(c);
    const sigBefore = E.cascSigOf(c);
    try {
      E.CascadePersistence.setAgentFilm(c.id, id,
        { admission_score: 90, admission_status: "in_cinema", agent_sig: sigBefore });
      c.watchMarkers = { in_cinema: 95, premium: null, rent: 95, stream: 95 };   // new floor 95 > stored 90
      assert.notEqual(E.cascSigOf(c), sigBefore, "this test's own edit must actually move cascSigOf(c)");
      E.recomputeFound();
      const row = E.CascadePersistence.agentFilmsFor(c.id).find(r => r.movie_id === String(id));
      assert.ok(!row, "a floor raised past the stored admission_score must drop the film on re-evaluation");
    } finally { unseedCascade(c.id); }
  });
}));

test("CAS-728 AC4: a floor below the stored admission_score keeps the film — the stored score, not a live one", () => withCas728State(() => {
  withWatchPrefs(STICKY_WATCH_PREFS, () => {
    const film = pastCinemaUnwatchedFilm();
    const id = film.tmdb_id;
    const saved = { rt_critic: film.rt_critic, metacritic: film.metacritic, imdb_votes: film.imdb_votes };
    // Zero the film's LIVE cascadeScore to -1 — no review signal at all — so a re-test that wrongly read the
    // live score would fail at ANY floor. Only a re-test against the stored admission_score of 90 can pass.
    film.rt_critic = null; film.metacritic = null; film.imdb_votes = 0;
    assert.equal(E.cascadeScore(film), -1, "this test's own setup must actually zero out the live score");
    const c = stickyTestCascade("cas728-ac4", 99);
    E.cascades.push(c);
    const sigBefore = E.cascSigOf(c);
    try {
      E.CascadePersistence.setAgentFilm(c.id, id,
        { admission_score: 90, admission_status: "in_cinema", agent_sig: sigBefore });
      c.watchMarkers = { in_cinema: 80, premium: null, rent: 80, stream: 80 };   // 80 <= stored 90, > live (-1)
      E.recomputeFound();
      const row = E.CascadePersistence.agentFilmsFor(c.id).find(r => r.movie_id === String(id));
      assert.ok(row, "a floor of 80 against a stored admission_score of 90 must keep the film — a live-score " +
        "re-test would fail unconditionally here (-1), so this only passes off the stored score");
    } finally { unseedCascade(c.id); Object.assign(film, saved); }
  });
}));

test("CAS-728 AC5: a manual Watch On value survives a re-evaluation that removes the film from its agent", () => withCas728State(() => {
  withWatchPrefs(STICKY_WATCH_PREFS, () => {
    const film = pastCinemaUnwatchedFilm();
    const id = film.tmdb_id;
    const c = stickyTestCascade("cas728-ac5", 99);
    E.cascades.push(c);
    const sigBefore = E.cascSigOf(c);
    try {
      E.CascadePersistence.setAgentFilm(c.id, id,
        { admission_score: 90, admission_status: "in_cinema", agent_sig: sigBefore });
      const level = E.watchLevelsFor(id).find(l => !l.spent);
      assert.ok(level, "no un-spent Watch level on this film — the harness catalogue looks wrong");
      E.toggleFilmOpt(id, level.key);
      assert.equal(E.notify[id].wins[level.key], true, "setup: the manual tick must actually land");
      c.watchMarkers = { in_cinema: 95, premium: null, rent: 95, stream: 95 };   // drops the film, as in AC3
      E.recomputeFound();
      const row = E.CascadePersistence.agentFilmsFor(c.id).find(r => r.movie_id === String(id));
      assert.ok(!row, "setup: the film must actually leave the agent for this to test anything");
      assert.equal(E.notify[id].wins[level.key], true, "AC5: a manual Watch On value must survive the removal");
      assert.equal(E.notify[id].winsSource[level.key], "manual");
    } finally { unseedCascade(c.id); }
  });
}));

test("CAS-728 AC6: a cascSigOf change on one agent never re-evaluates another agent's rows", () => withCas728State(() => {
  withWatchPrefs(STICKY_WATCH_PREFS, () => {
    const filmA = pastCinemaUnwatchedFilm();
    const filmB = pastCinemaUnwatchedFilm(filmA.tmdb_id);
    const idA = filmA.tmdb_id, idB = filmB.tmdb_id;
    const a = stickyTestCascade("cas728-ac6-a", 99);
    // B's floor already exceeds its own stored admission_score — if B were ever re-evaluated it would drop,
    // so B surviving is proof its own re-evaluation branch never ran off agent A's edit.
    const b = stickyTestCascade("cas728-ac6-b", 50);
    E.cascades.push(a, b);
    const sigA = E.cascSigOf(a), sigB = E.cascSigOf(b);
    try {
      E.CascadePersistence.setAgentFilm(a.id, idA, { admission_score: 90, admission_status: "in_cinema", agent_sig: sigA });
      E.CascadePersistence.setAgentFilm(b.id, idB, { admission_score: 10, admission_status: "in_cinema", agent_sig: sigB });
      a.watchMarkers = { in_cinema: 95, premium: null, rent: 95, stream: 95 };   // only A's own cascSigOf moves
      E.recomputeFound();
      const rowB = E.CascadePersistence.agentFilmsFor(b.id).find(r => r.movie_id === String(idB));
      assert.ok(rowB, "B's row must survive untouched — only A's own cascSigOf changed");
      assert.equal(rowB.agent_sig, sigB, "B's agent_sig must not be rewritten by an edit to a different agent");
    } finally { unseedCascade(a.id); unseedCascade(b.id); }
  });
}));

// ---- CASCADES ACCOUNT CONVERGENCE (CAS-734) --------------------------------------------------------------
// Two devices signed in to the same account held permanently different agent sets: loadAccount resolved
// every conflict in favour of the local cache unconditionally (no comparison of anything), reconcileCascades
// resolved every conflict the OPPOSITE way (remote always wins), and a single edit upserted the whole array
// instead of just the changed row. These tests exercise the real seam (window.CascadePersistence) against a
// minimal fake Supabase client, same style as the CAS-681/CAS-726 harnesses above.
const uuidFor = n => `00000734-0000-4000-8000-${String(n).padStart(12, "0")}`;
function fakeCascadesSupabase(seed){
  const state = { rows: (seed || []).map(r => ({ ...r })), upsertCalls: [] };
  function selectBuilder(){
    const builder = {
      order(){ return builder; },   // the real query's ORDER BY — the fake does its own client-side sort
      then(resolve, reject){
        return Promise.resolve({ data: state.rows.map(r => ({ ...r })), error: null }).then(resolve, reject);
      },
    };
    return builder;
  }
  function deleteBuilder(){
    const conds = [];
    const builder = {
      eq(col, val){ conds.push([col, v => v === val]); return builder; },
      in(col, vals){ const set = new Set(vals); conds.push([col, v => set.has(v)]); return builder; },
      then(resolve, reject){
        state.rows = state.rows.filter(r => !conds.every(([c, test]) => test(r[c])));
        return Promise.resolve({ error: null }).then(resolve, reject);
      },
    };
    return builder;
  }
  const client = {
    from(table){
      assert.equal(table, "cascades", "the cascades persistence seam must only ever touch the cascades table");
      return {
        select: () => selectBuilder(),
        upsert(rows){
          state.upsertCalls.push(rows);
          const nowIso = new Date().toISOString();
          const written = rows.map(r => {
            const i = state.rows.findIndex(x => x.id === r.id);
            const createdAt = (i >= 0 && state.rows[i].created_at) || r.created_at || nowIso;
            const stored = { ...r, created_at: createdAt, updated_at: nowIso };
            if(i >= 0) state.rows[i] = stored; else state.rows.push(stored);
            return stored;
          });
          const result = { data: written.map(r => ({ id: r.id, updated_at: r.updated_at })), error: null };
          return { select: async () => result, then(resolve, reject){ return Promise.resolve(result).then(resolve, reject); } };
        },
        delete: () => deleteBuilder(),
      };
    },
  };
  return { client, state };
}
function withCas734State(fn){
  const savedCascades = E.cascades.slice();
  const savedKnown = new Map(E.CascadePersistence.cascadeKnown);
  const savedEdited = new Map(E.CascadePersistence.cascadeEditedAt);
  E.CascadePersistence.cascadeKnown.clear();
  E.CascadePersistence.cascadeEditedAt.clear();
  return (async () => {
    try { await fn(); }
    finally {
      E.cascades.length = 0; savedCascades.forEach(c => E.cascades.push(c));
      E.CascadePersistence.cascadeKnown.clear();
      savedKnown.forEach((v, k) => E.CascadePersistence.cascadeKnown.set(k, v));
      E.CascadePersistence.cascadeEditedAt.clear();
      savedEdited.forEach((v, k) => E.CascadePersistence.cascadeEditedAt.set(k, v));
      signOut();
    }
  })();
}

test("CAS-734 AC2: app_template.html no longer justifies any rule with \"the local copy is the newer state\"", () => {
  const src = fs.readFileSync(path.join(ROOT, "app_template.html"), "utf8");
  assert.equal((src.match(/the local copy is the newer state/g) || []).length, 0);
});

test("CAS-734 AC5: both cascades account reads carry an explicit ORDER BY", () => {
  const src = fs.readFileSync(path.join(ROOT, "app_template.html"), "utf8");
  const matches = src.match(/\.order\("(created_at|updated_at)"/g) || [];
  assert.ok(matches.length >= 2, `expected at least 2 explicit ORDER BY clauses on the cascades reads, found ${matches.length}`);
});

test("CAS-734 AC4: the order comparator is a total order — a tie on .order resolves via created_at then id, never 0", () => {
  const cmp = E.CascadePersistence.cascadeOrderCmp;
  const a = { id: "aaaaaaaa-0000-4000-8000-000000000001", order: 5, created_at: "2026-01-01T00:00:00.000Z" };
  const b = { id: "bbbbbbbb-0000-4000-8000-000000000001", order: 5, created_at: "2026-02-01T00:00:00.000Z" };
  assert.notEqual(cmp(a, b), 0, "a tie on .order must not resolve to 0");
  assert.ok(cmp(a, b) < 0, "the earlier created_at must sort first");
  assert.ok(cmp(b, a) > 0, "the comparator must be antisymmetric");
  // A tie on BOTH .order and created_at too — id is the final tie-break, and it must still be non-zero and
  // consistent both ways (never the "whatever arrived first" answer the old bare .order subtraction gave).
  const c = { id: "aaaaaaaa-0000-4000-8000-000000000001", order: 5, created_at: "2026-01-01T00:00:00.000Z" };
  const d = { id: "bbbbbbbb-0000-4000-8000-000000000001", order: 5, created_at: "2026-01-01T00:00:00.000Z" };
  assert.notEqual(cmp(c, d), 0, "a tie on both .order and created_at must still resolve via id, never 0");
  assert.equal(Math.sign(cmp(c, d)), -Math.sign(cmp(d, c)), "the comparator must be stable/antisymmetric on id too");
});

test("CAS-734 AC6: a single-agent rename upserts exactly one row, not the whole array", () => withCas734State(async () => {
  const idA = uuidFor(1), idB = uuidFor(2);
  const a = E.normCascade({ id: idA, name: "Agent A", order: 0 });
  const b = E.normCascade({ id: idB, name: "Agent B", order: 1 });
  E.cascades.length = 0; E.cascades.push(a, b);
  const { client, state } = fakeCascadesSupabase([]);
  signInWithClient(client);

  // Establish both as already-confirmed by the account (this first push isn't what the AC is about).
  await E.CascadePersistence.syncNow();
  state.upsertCalls.length = 0;

  a.name = "Agent A renamed";
  E.CascadePersistence.saveCascades();
  await E.CascadePersistence.syncNow();

  const lastUpsert = state.upsertCalls[state.upsertCalls.length - 1] || [];
  assert.equal(lastUpsert.length, 1, "a one-agent rename must upsert exactly one row");
  assert.equal(lastUpsert[0].id, idA, "the one row upserted must be the agent that actually changed");
}));

test("CAS-734 AC3(a): a local edit older than the account's own row loses — the account row is what ends up in cascades", () => withCas734State(async () => {
  const id = uuidFor(3);
  const remoteRow = { id, user_id: "cas681-test-user", name: "Account version",
    criteria: { order: 0 }, alert_moments: [], active: true,
    created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-06-01T00:00:00.000Z" };
  const { client } = fakeCascadesSupabase([remoteRow]);
  signInWithClient(client);

  const local = E.normCascade({ id, name: "Local version (stale)", order: 0 });
  E.cascades.length = 0; E.cascades.push(local);
  // This device's own record of when IT last changed this agent — BEFORE the account row's own updated_at
  // above, so the account is the newer copy even though the content genuinely differs.
  E.CascadePersistence.cascadeEditedAt.set(id, "2026-03-01T00:00:00.000Z");

  await E.CascadePersistence.loadAccount();

  const kept = E.cascades.find(c => c.id === id);
  assert.ok(kept, "the agent must still be present");
  assert.equal(kept.name, "Account version", "the account's newer row must win when the local edit is older");
}));

test("CAS-734 AC3(b): a local edit newer than the account's own row wins and is pushed", () => withCas734State(async () => {
  const id = uuidFor(4);
  const remoteRow = { id, user_id: "cas681-test-user", name: "Account version",
    criteria: { order: 0 }, alert_moments: [], active: true,
    created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-05T00:00:00.000Z" };
  const { client, state } = fakeCascadesSupabase([remoteRow]);
  signInWithClient(client);

  const local = E.normCascade({ id, name: "Local version (newer)", order: 0 });
  E.cascades.length = 0; E.cascades.push(local);
  // This device changed it AFTER the account row's own updated_at above.
  E.CascadePersistence.cascadeEditedAt.set(id, "2026-06-01T00:00:00.000Z");

  await E.CascadePersistence.loadAccount();
  const kept = E.cascades.find(c => c.id === id);
  assert.equal(kept.name, "Local version (newer)", "the newer local edit must win");

  await E.CascadePersistence.syncNow();
  const lastUpsert = state.upsertCalls[state.upsertCalls.length - 1] || [];
  assert.ok(lastUpsert.some(r => r.id === id && r.name === "Local version (newer)"),
    "the winning local edit must actually be pushed back to the account");
}));

test("CAS-734 AC3(c): loadAccount and reconcileCascades resolve conflicts through the SAME function", () => withCas734State(async () => {
  // Structural: one definition, exactly two call sites (loadAccount, reconcileCascades) — not two inline
  // rules that happen to agree, which is exactly the shape that let them silently disagree before this fix.
  const src = fs.readFileSync(path.join(ROOT, "app_template.html"), "utf8");
  const iifeSrc = src.slice(src.indexOf("function cascadeToRow("), src.indexOf("window.CascadePersistence = {"));
  const defCount = (iifeSrc.match(/function resolveCascadeConflict\(/g) || []).length;
  const totalCount = (iifeSrc.match(/resolveCascadeConflict\(/g) || []).length;
  assert.equal(defCount, 1, "resolveCascadeConflict must be defined exactly once");
  assert.equal(totalCount, 3, "resolveCascadeConflict's one definition plus exactly two call sites (loadAccount, reconcileCascades)");

  // Behavioural: the identical conflict resolves identically whichever path is called.
  const id = uuidFor(5);
  const remoteRow = { id, user_id: "cas681-test-user", name: "Account version",
    criteria: { order: 0 }, alert_moments: [], active: true,
    created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-06-01T00:00:00.000Z" };
  const { client } = fakeCascadesSupabase([remoteRow]);
  signInWithClient(client);
  const local = E.normCascade({ id, name: "Local version (stale)", order: 0 });
  E.cascades.length = 0; E.cascades.push(local);
  E.CascadePersistence.cascadeEditedAt.set(id, "2026-03-01T00:00:00.000Z");

  await E.CascadePersistence.reconcileCascades();
  const kept = E.cascades.find(c => c.id === id);
  assert.equal(kept.name, "Account version", "reconcileCascades must resolve this exactly as loadAccount's own AC3(a) test does");
}));

test("CAS-734 AC3(d): an agent present only on this device, with an id the account has never confirmed, is left alone", () => withCas734State(async () => {
  const otherId = uuidFor(6), localOnlyId = uuidFor(7);
  const remoteRow = { id: otherId, user_id: "cas681-test-user", name: "Some other agent",
    criteria: { order: 0 }, alert_moments: [], active: true,
    created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z" };
  const { client } = fakeCascadesSupabase([remoteRow]);
  signInWithClient(client);

  const localOnly = E.normCascade({ id: localOnlyId, name: "Brand new, unsynced", order: 1 });
  E.cascades.length = 0; E.cascades.push(localOnly);
  // Never confirmed by the account: withCas734State starts cascadeKnown empty, and this id isn't in it.

  await E.CascadePersistence.loadAccount();

  const kept = E.cascades.find(c => c.id === localOnlyId);
  assert.ok(kept, "a genuinely new, never-synced local agent must survive a loadAccount call");
  assert.equal(kept.name, "Brand new, unsynced");
}));

// ---- MANUAL WATCH ON NEVER OVERWRITTEN, EVEN ACROSS DEVICES (CAS-735) -----------------------------------
// Two independent gaps let an explicit manual Watch On pick get silently reverted to auto: applyWatchRows
// carried no precedence rule at all (a remote row that simply didn't mention the ticked rung was enough to
// wipe it), and recomputeFound could re-arm auto off a device's still-stale local cache before its own
// film_watch load for the session had resolved — a device that hadn't yet heard about another device's
// manual pick would re-write auto over it and push that stale value to the account. These exercise each
// seam directly against the real functions.

test("CAS-735 AC2: applyWatchRows never lets a remote row with no manual claim overwrite a local manual pick", () => {
  const id = E.MOVIES[6].tmdb_id;
  try {
    const e = E.entryFor(id);
    e.wins = { in_cinema: false, premium: false, rent: false, stream: true };
    e.winsSource = { stream: "manual" };
    E.CascadePersistence.applyWatchRows([
      { movie_id: String(id), windows: ["in_cinema"], sources: { in_cinema: "auto" },
        updated_at: "2026-09-03T00:00:00.000Z" },
    ]);
    const after = E.notify[id];
    assert.equal(after.wins.stream, true,
      "a local manual pick must survive a remote row claiming a different, auto rung");
    assert.equal(after.winsSource.stream, "manual");
  } finally {
    delete E.notify[id];
  }
});

test("CAS-735 AC3: a full recomputeFound() pass never changes an entry carrying a manual source on its currently-set key, for every window and marker configuration", () => {
  const film = scoredUnwatchedFilm(["in_cinema"]);
  const id = film.tmdb_id;
  const savedStatus = film.status;
  const cId = seedMarkerCascade({});
  try {
    pinFilm(id, cId);
    const c = E.cascades.find(x => x.id === cId);
    const score = E.cascadeScore(film) === -1 ? 50 : E.cascadeScore(film);
    const combos = [
      { in_cinema: score - 1, rent: score - 20, stream: score - 30 },
      { in_cinema: null, rent: null, stream: null },
      { in_cinema: 0, rent: 0, stream: 0 },
      { in_cinema: score + 40, rent: score + 20, stream: score + 10 },
    ];
    withWatchPrefs(PLACEMENT_WATCH_PREFS, () => {
      for (const manualKey of E.WATCH_LEVEL_KEYS) {
        const e = E.entryFor(id);
        e.wins = Object.fromEntries(E.WATCH_LEVEL_KEYS.map(k => [k, k === manualKey]));
        e.winsSource = { [manualKey]: "manual" };
        const before = JSON.stringify([e.wins, e.winsSource]);
        for (const markers of combos) {
          c.watchMarkers = { in_cinema: null, premium: null, rent: null, stream: null, ...markers };
          for (const status of [["upcoming"], ["in_cinema"], ["rental"], ["included_streaming"]]) {
            film.status = status;
            E.recomputeFound();
            assert.equal(JSON.stringify([e.wins, e.winsSource]), before,
              `manualKey=${manualKey} must survive recompute: markers=${JSON.stringify(markers)} status=${status}`);
          }
        }
      }
    });
  } finally {
    delete E.notify[id];
    unseedCascade(cId);
    film.status = savedStatus;
  }
});

test("CAS-735 AC4: toggleFilmOpt leaves exactly one key set in wins and exactly one entry in winsSource", () => {
  const m = E.MOVIES.find(x => E.watchLevelsFor(x.tmdb_id).some(l => !l.spent));
  assert.ok(m, "no film with an un-spent Watch level — the harness catalogue looks wrong");
  const id = m.tmdb_id;
  const level = E.watchLevelsFor(id).find(l => !l.spent);
  try {
    E.toggleFilmOpt(id, level.key);
    const e = E.notify[id];
    const onKeys = E.WATCH_LEVEL_KEYS.filter(k => e.wins[k]);
    assert.equal(onKeys.length, 1, `expected exactly one key set in wins, found ${JSON.stringify(onKeys)}`);
    assert.equal(onKeys[0], level.key);
    assert.equal(Object.keys(e.winsSource).length, 1,
      `expected exactly one entry in winsSource, found ${JSON.stringify(e.winsSource)}`);
    assert.equal(e.winsSource[level.key], "manual");
  } finally {
    delete E.notify[id];
  }
});

test("CAS-735 AC5: recomputeFound() writes no placement value before this session's first film_watch load has resolved", () => {
  const film = scoredUnwatchedFilm(["upcoming"]);
  const id = film.tmdb_id;
  const savedStatus = film.status;
  const score = E.cascadeScore(film);
  const cId = seedMarkerCascade({ in_cinema: score - 1, rent: score - 20, stream: score - 30 });
  const savedReady = E.CascadePersistence.filmWatchReady;
  try {
    pinFilm(id, cId);
    E.CascadePersistence.filmWatchReady = false;
    withWatchPrefs(PLACEMENT_WATCH_PREFS, () => { E.recomputeFound(); });
    const e = E.notify[id];
    const picked = !!(e && e.wins && Object.values(e.wins).some(Boolean));
    assert.ok(!picked, "recomputeFound must write no placement value while filmWatchReady is false");

    E.CascadePersistence.filmWatchReady = true;
    withWatchPrefs(PLACEMENT_WATCH_PREFS, () => { E.recomputeFound(); });
    assert.equal(E.notify[id].wins.in_cinema, true, "sanity: once ready, the same film places normally");
  } finally {
    delete E.notify[id];
    unseedCascade(cId);
    film.status = savedStatus;
    E.CascadePersistence.filmWatchReady = savedReady;
  }
});
