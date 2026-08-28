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

// ---- 8. THE CASCADE SCORE (CAS-603) ---------------------------------------------------------------------
// One number from the three the card already prints, so a thin-voted IMDb average can no longer outrank a
// broadly-agreed film just because nothing else was reading the critic scores.
test("cascade score: critic agreement beats a below-floor IMDb rating with no critic backing, and sourceless films sort last", () => {
  const wellReviewed  = { title: "Well Reviewed",  imdb_rating: 8.2, imdb_votes: 1000000, metacritic: 90, rt_critic: 93 };
  const belowFloor    = { title: "Below Floor",    imdb_rating: 9.9, imdb_votes: E.IMDB_MIN_VOTES - 1 };
  const noSources      = { title: "No Sources",     imdb_rating: null, imdb_votes: 0 };

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

// ---- 9. THE CASCADE SCORE FROM WHATEVER SOURCES ARE PRESENT, NARROWED BY CAS-669 -----------------------
// CAS-660 let qScore score from whichever of the three sources a film carries, one reliable source being
// enough. CAS-669 narrows that: Metacritic and RT carry no reliability gate the way IMDb does, so a lone
// ungated critic score (a 100% RT off a handful of reviews) was outranking films with real corroboration.
// A film now needs a gated source (an IMDb rating above IMDB_MIN_VOTES) or at least two sources agreeing.
test("cascade score: scored from a gated source or two corroborating sources, not one ungated source alone", () => {
  // AC1: no film whose only source is rt_critic (or only metacritic) has a qScore other than -1.
  for(const m of E.MOVIES){
    if(E.ratingOf(m) != null) continue;
    if(m.metacritic != null && m.rt_critic == null) assert.equal(E.qScore(m), -1, `${m.title}: Metacritic-only film scored`);
    if(m.rt_critic != null && m.metacritic == null) assert.equal(E.qScore(m), -1, `${m.title}: RT-only film scored`);
  }
  const metaOnly = { title: "Metacritic Only", imdb_rating: null, imdb_votes: 0, metacritic: 61 };
  const rtOnly   = { title: "RT Only",         imdb_rating: null, imdb_votes: 0, rt_critic: 88 };
  assert.equal(E.qScore(metaOnly), -1, "a lone Metacritic score should not score (CAS-669)");
  assert.equal(E.qScore(rtOnly), -1, "a lone RT score should not score (CAS-669)");

  // AC2: a film whose only source is a gated-eligible IMDb rating still scores, as the rating x10.
  const imdbOnly = { title: "IMDb Only", imdb_rating: 7.3, imdb_votes: 1000000 };
  assert.equal(E.qScore(imdbOnly), Math.round(7.3*10), "IMDb-only score should be the IMDb rating x10, rounded");

  // AC3: Metacritic + RT together, with no eligible IMDb, score as their mean.
  const bothCritics = { title: "Both Critics", imdb_rating: null, imdb_votes: 0, metacritic: 60, rt_critic: 90 };
  assert.equal(E.qScore(bothCritics), 75, "Metacritic + RT together should score their mean");

  // For every scorable film, qScore lies between the min and max of its counted parts, inclusive.
  for(const m of E.MOVIES){
    const q = E.qScore(m);
    if(q === -1) continue;
    const r = E.ratingOf(m);
    const parts = [];
    if(r != null) parts.push(r*10);
    if(m.metacritic != null) parts.push(m.metacritic);
    if(m.rt_critic != null) parts.push(m.rt_critic);
    assert.ok(q >= Math.min(...parts) && q <= Math.max(...parts),
      `${m.title}: qScore ${q} falls outside [${Math.min(...parts)}, ${Math.max(...parts)}]`);
  }
});

// ---- 9b. A SINGLE UNGATED SOURCE NO LONGER LEADS THE TOP OF THE LIST (CAS-669) ---------------------------
// AC4: strictly fewer films score 90+ than under the CAS-660 rule (any single present source was enough),
// and none of the survivors rest on a single ungated source.
test("cascade score: fewer films score 90+ once a lone ungated source stops counting, and none of the survivors are lone-sourced", () => {
  const cas660Score = m => {
    const r = E.ratingOf(m);
    const p = [];
    if(r != null) p.push(r*10);
    if(m.metacritic != null) p.push(m.metacritic);
    if(m.rt_critic != null) p.push(m.rt_critic);
    if(!p.length) return -1;
    return Math.round(p.reduce((x,y)=>x+y,0)/p.length);
  };
  const oldTop = E.MOVIES.filter(m => cas660Score(m) >= 90).length;
  const newTop = E.MOVIES.filter(m => E.qScore(m) >= 90).length;
  assert.ok(newTop < oldTop, `expected fewer films scoring 90+ under the new rule: old ${oldTop}, new ${newTop}`);

  for(const m of E.MOVIES){
    if(E.qScore(m) < 90) continue;
    const gated = E.ratingOf(m) != null;
    const corroborated = (m.metacritic != null ? 1 : 0) + (m.rt_critic != null ? 1 : 0) >= 2;
    assert.ok(gated || corroborated, `${m.title}: scores 90+ resting on a single ungated source`);
  }
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

test("mission OR AC1: with only People's vote set, the matching set is exactly what selCrowdOK admits, pre-release films aside", () => {
  const open = missionCase();
  const withCrowd = missionCase({ selCrowd: 7.5 });
  const got = new Set(E.MOVIES.filter(m => E.matchesCriteria(m, withCrowd)));
  const expected = new Set(E.MOVIES.filter(m => E.matchesCriteria(m, open)
    && (isPreRelease(m) || E.selCrowdOK(m, withCrowd))));
  assert.equal(got.size, expected.size, `expected ${expected.size} films clearing selCrowdOK, got ${got.size}`);
  for(const m of got) assert.ok(expected.has(m), `${m.title} matched with only People's vote set but fails selCrowdOK`);
  for(const m of expected) assert.ok(got.has(m), `${m.title} clears selCrowdOK (and the open block) but did not match`);
});

// CAS-663 AC1/AC2 (ticket's own wording): the quality dials never gate a pre-release film, and the same
// recipe's behaviour within a released window (included_streaming) is unchanged.
test("CAS-663: People's vote does not gate upcoming or in_cinema films, but still gates a released window", () => {
  const open = missionCase();
  const withCrowd = missionCase({ selCrowd: 7.5 });
  const preReleaseMovies = E.MOVIES.filter(isPreRelease);
  assert.ok(preReleaseMovies.length > 0, "no upcoming/in_cinema films in the fixture catalogue to exercise this on");
  for(const m of preReleaseMovies){
    if(!E.matchesCriteria(m, open)) continue;   // must clear the open block first
    assert.ok(E.matchesCriteria(m, withCrowd),
      `${m.title} (${E.primaryStatus(m)}) was excluded by People's vote despite being pre-release`);
  }
  const streamOnly = E.MOVIES.filter(m => E.primaryStatus(m) === "included_streaming");
  for(const m of streamOnly){
    if(!E.matchesCriteria(m, open)) continue;
    assert.equal(E.matchesCriteria(m, withCrowd), E.selCrowdOK(m, withCrowd),
      `${m.title}: included_streaming film's People's vote gating changed`);
  }
});

test("mission OR AC2: two dials set is a strict superset of either dial alone", () => {
  const crowdOnly   = new Set(E.MOVIES.filter(m => E.matchesCriteria(m, missionCase({ selCrowd: 7.5 }))));
  const criticsOnly = new Set(E.MOVIES.filter(m => E.matchesCriteria(m, missionCase({ selCritScore: 60 }))));
  const both        = new Set(E.MOVIES.filter(m =>
    E.matchesCriteria(m, missionCase({ selCrowd: 7.5, selCritScore: 60 }))));
  for(const m of crowdOnly) assert.ok(both.has(m), `${m.title} clears People's vote alone but not the OR of both`);
  for(const m of criticsOnly) assert.ok(both.has(m), `${m.title} clears Critics score alone but not the OR of both`);
  assert.ok(both.size > crowdOnly.size,
    `combining should add films over People's vote alone: ${crowdOnly.size} → ${both.size}`);
  assert.ok(both.size > criticsOnly.size,
    `combining should add films over Critics score alone: ${criticsOnly.size} → ${both.size}`);
});

test("mission OR AC3: tightening the sole active dial only ever narrows", () => {
  const sets = [6.0, 7.0, 7.5].map(v =>
    new Set(E.MOVIES.filter(m => E.matchesCriteria(m, missionCase({ selCrowd: v })))));
  for(let i = 1; i < sets.length; i++){
    assert.ok(sets[i].size <= sets[i - 1].size,
      `raising People's vote widened the set: ${sets[i - 1].size} → ${sets[i].size}`);
    for(const m of sets[i]) assert.ok(sets[i - 1].has(m),
      `${m.title} clears the higher People's-vote bar but not the lower one — the dial does not nest`);
  }
});

test("mission OR AC4: with every dial off, the block is exactly as if it were not there", () => {
  const open = new Set(E.MOVIES.filter(m => E.matchesCriteria(m, missionCase())));
  // Max out every dial and then reopen them all — if the block still leaked a restriction while every dial
  // reads its own zero stop, this would come back smaller than `open`.
  const reopened = new Set(E.MOVIES.filter(m => E.matchesCriteria(m, missionCase({
    selCrowd: 0, selCritScore: 0, selAwards: 0, selScale: 0, selBuzz: 0, cinemaReleaseOnly: false,
  }))));
  assert.equal(reopened.size, open.size,
    `every dial off should equal the open set (${open.size}), got ${reopened.size}`);
  for(const m of open) assert.ok(reopened.has(m), `${m.title} is in the open set but not the all-dials-off set`);
});

test("mission OR AC5: every zero stop reads Off, and the Cinema Release control drops \"Only\"", () => {
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

// ---- WATCH-LIST SELECTION LOADS ITS OWN RECORD (CAS-666) ------------------------------------------------
// deckSelect/wlRailCreate are the LIVE deck's own selection/creation paths — the ones that shipped without
// applyActiveWatchlist(), so the ymSvcOn/etc scratch state kept whichever list was previously open and
// ymPersist() then stamped those stale values into the newly selected list's own saved record.
// Records built or read back through the vm sandbox carry vm-realm Arrays, which deepStrictEqual (this
// file imports assert/strict) treats as unequal to a same-looking native array — every array assertion in
// data-integrity.test.mjs hits the same thing and spreads first; this does the same for a whole record.
const plainRecord = r => ({
  svcOn: [...r.svcOn], cascOff: [...r.cascOff], watchedOn: [...r.watchedOn],
  watchTiers: [...r.watchTiers], sort: r.sort, excludeTags: [...r.excludeTags],
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
  assert.deepEqual(plainRecord(a), { svcOn: ["stream"], cascOff: ["only-a"], watchedOn: [], watchTiers: [], sort: null, excludeTags: [] },
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

// ---- MOVING NEVER RENDERS A PROVISIONAL LEDGER (CAS-667) -------------------------------------------------
// movingData() branches on window.CascadePersistence.accountActive() — flip window.CascadeAuth's real fields
// (enabled/client/session) the same way sign-in for real does, rather than a stand-in predicate, so the
// signed-in branch runs through the exact same check the shipped code runs.
function setSignedIn(signedIn){
  const auth = E.CascadeAuth;
  auth.enabled = signedIn;
  auth.client = signedIn ? {} : null;
  auth.session = signedIn ? { user: { id: "cas667-test-user" } } : null;
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

// ---- THE MOVING BADGE COUNTS THE SAME WINDOW THE SCREEN SHOWS (CAS-668) -----------------------------------
// The chip badge used to count unseen rows across every window while renderMovingScreen only ever showed one,
// so the two numbers could never agree. movingWindowRows(win, cutoff) is now the one recipe both read
// through — see app_template.html for movingBadgeWindow's live-vs-predicted split.
const daysAgoISO = n => new Date(Date.now() - n * 864e5).toISOString();
function unwatchedFilms(n){
  return E.MOVIES.filter(m => !E.watched.has(m.tmdb_id)).slice(0, n);
}

test("CAS-668 AC1: the badge equals the unseen count of the exact row set the window would show", () => {
  const [filmA, filmB] = unwatchedFilms(2);
  const idA = String(filmA.tmdb_id), idB = String(filmB.tmdb_id);
  E.firstFound[idA] = daysAgoISO(0);
  E.firstFound[idB] = daysAgoISO(0);
  delete E.movingSeen[idA]; delete E.movingSeen[idB];

  // Predicted window/cutoff — what openMovingScreen would compute if opened right now (Moving is closed).
  assert.equal(E.movingIsOpen, false, "sanity: Moving must be closed for the predicted-window branch to run");
  const { win, cutoff } = E.movingBadgeWindow();
  const predicted = E.movingWindowRows(win, cutoff);
  const predictedIds = predicted.shownNew.map(r => r.filmId);
  assert.ok(predictedIds.includes(idA) && predictedIds.includes(idB),
    "sanity: both seeded rows must land in the window the badge predicts");
  const expectedUnseen = [...predicted.shownCan, ...predicted.shownNew, ...predicted.shownChanged]
    .filter(r => E.movingSeen[r.filmId] !== r.groupKey).length;
  assert.equal(E.movingUnseenCount(), expectedUnseen,
    "the badge must equal the unseen count of movingWindowRows' own filtered set, not every row across all windows");

  // Actually opening must land on the same window and show exactly that predicted set.
  E.openMovingScreen();
  assert.equal(E.movingWindow, win, "openMovingScreen must land on the window the badge predicted");
  const rendered = E.movingWindowRows(E.movingWindow, E.movingVisitCutoff);
  assert.deepEqual(rendered.shownNew.map(r => r.filmId).sort(), predictedIds.sort(),
    "renderMovingScreen's own filtered row set must match exactly what the badge predicted");
  assert.equal(E.movingUnseenCount(), 0, "every row just shown must now count as seen");
  E.closeMovingScreen();

  delete E.firstFound[idA]; delete E.firstFound[idB];
  delete E.movingSeen[idA]; delete E.movingSeen[idB];
});

test("CAS-668 AC2: rendering a window does not clear the unseen state of rows outside it", () => {
  const [filmA, filmB] = unwatchedFilms(2);
  const idA = String(filmA.tmdb_id), idB = String(filmB.tmdb_id);

  // Warm up the cutoff, then seed only filmB (3 days old) so the very first open auto-picks "week" cleanly
  // (since_last/today are both empty, week is the first window with >=1 row).
  E.openMovingScreen();
  E.closeMovingScreen();
  E.firstFound[idB] = daysAgoISO(3);   // inside "week"/"2weeks"/"month", outside "today"
  delete E.movingSeen[idB];
  E.openMovingScreen();
  assert.equal(E.movingWindow, "week", "sanity: a single 3-day-old row must auto-open on the week window");

  // Now filmA appears (10 days old — outside "today"/"week", inside "2weeks"/"month" only). Switching away
  // from and back to "week" re-renders it with filmA present in the underlying data but outside this window.
  E.firstFound[idA] = daysAgoISO(10);
  delete E.movingSeen[idA];
  E.setMovingWindow("today");
  E.setMovingWindow("week");
  const { shownNew } = E.movingWindowRows("week", E.movingVisitCutoff);
  const weekIds = shownNew.map(r => r.filmId);
  assert.ok(weekIds.includes(idB) && !weekIds.includes(idA), "sanity: filmB is in the week window, filmA is not");

  assert.equal(E.movingSeen[idB], "new_agents", "the row actually shown in the rendered window must be marked seen");
  assert.ok(!(idA in E.movingSeen), "a row outside the rendered window must not have its unseen state touched");
  E.closeMovingScreen();

  delete E.firstFound[idA]; delete E.firstFound[idB];
  delete E.movingSeen[idA]; delete E.movingSeen[idB];
});

test("CAS-668 AC3: opening Moving twice with no data change and no user action selects the same window and rows", () => {
  const [film] = unwatchedFilms(1);
  const id = String(film.tmdb_id);
  // Warm up the cutoff first so "since_last"/"today" are already settled (empty) before the two opens being
  // compared — otherwise the very first-ever open (cutoff 0) is a special case that always wins on since_last.
  E.openMovingScreen();
  E.closeMovingScreen();

  E.firstFound[id] = daysAgoISO(3);   // inside "week"/"2weeks"/"month" only, stable across the cutoff advance
  delete E.movingSeen[id];

  E.openMovingScreen();
  const window1 = E.movingWindow;
  const rows1 = E.movingWindowRows(window1, E.movingVisitCutoff).shownNew.map(r => r.filmId).sort();
  E.closeMovingScreen();

  E.openMovingScreen();
  const window2 = E.movingWindow;
  const rows2 = E.movingWindowRows(window2, E.movingVisitCutoff).shownNew.map(r => r.filmId).sort();
  E.closeMovingScreen();

  assert.equal(window2, window1, "reopening with no data change and no user action must pick the same window");
  assert.deepEqual(rows2, rows1, "reopening with no data change and no user action must show the same rows");

  delete E.firstFound[id];
  delete E.movingSeen[id];
});

test("CAS-668 AC4: an empty window's badge reads 0, not a count borrowed from a different window", () => {
  const [film] = unwatchedFilms(1);
  const id = String(film.tmdb_id);
  E.firstFound[id] = daysAgoISO(10);  // real, unseen, but never inside "today"
  delete E.movingSeen[id];

  E.openMovingScreen();
  E.setMovingWindow("today");
  const { shownNew } = E.movingWindowRows("today", E.movingVisitCutoff);
  assert.equal(shownNew.length, 0, "sanity: \"today\" really is empty for this seeded data");
  assert.equal(E.movingUnseenCount(), 0,
    "the badge must read 0 for an empty window even though an unseen row exists in a different window");
  E.closeMovingScreen();

  delete E.firstFound[id];
  delete E.movingSeen[id];
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

// ---- AUTO-NOTIFY ARMS A FILM'S EARLIEST WINDOW (CAS-613) --------------------------------------------------
// recomputeFound() auto-ticks notify[id].wins for a film found by an autoNotify agent, mirroring
// toggleFilmOpt's manual cascade-down tick, gated by watchPrefs and guarded by a once-ever `autoNotified`
// flag. A synthetic cascade pinned onto one real film (pinnedInto, not criteria matching) keeps the film's
// real catalogue status out of the assertions — except for `stream`, WINDOW_RUNG's last rung, which is
// never spent for any film, so it is the one deterministic target these tests arm.
function seedAutoNotifyCascade(on){
  const id = "cas613-test-cascade";
  // A full normCascade(), not a bare object: watchesFilm/matchesCriteria run against EVERY film in
  // MOVIES.forEach (recomputeFound loops the whole catalogue per cascade), and a bare {id,autoNotify}
  // crashes on the first film that isn't the one this test pins in. imdb:10.1 is above the real 0-10
  // scale, so criteria matching admits nothing — only pinFilm's pinnedInto override reaches this cascade.
  const c = E.normCascade({ kind: "stream", status: [], imdb: 10.1 });
  c.id = id; c.paused = false; c.autoNotify = on;
  E.cascades.push(c);
  return id;
}
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

test("CAS-613 AC2/AC3: autoNotify arms the earliest window with notify on, and nothing when none is", () => {
  const [film] = unwatchedFilms(1);
  const id = film.tmdb_id;
  const cId = seedAutoNotifyCascade(true);
  try {
    pinFilm(id, cId);
    withWatchPrefs({ in_cinema: { list: true, notify: false }, rent: { list: true, notify: false },
                     stream: { list: true, notify: false } }, () => {
      E.recomputeFound();
      const e = E.notify[id];
      assert.ok(!e || !e.wins || !e.wins.stream, "AC3: nothing must be ticked when no window has notify on");
      assert.ok(!e || !e.autoNotified, "AC3: the once-ever guard must not be set when nothing qualified");
    });

    withWatchPrefs({ in_cinema: { list: true, notify: false }, rent: { list: true, notify: false },
                     stream: { list: true, notify: true } }, () => {
      E.recomputeFound();
      const e = E.notify[id];
      assert.equal(e.wins.stream, true, "AC2: the qualifying window must be ticked");
      assert.equal(e.autoNotified, true, "the once-ever guard must be set once armed");
      assert.equal(e.streamTier, "must", "the cascade-down tick must set the same default tier toggleFilmOpt sets");
      assert.equal(e.muted, false, "the cascade-down tick must unmute, same as toggleFilmOpt");
    });
  } finally {
    delete E.notify[id];
    unseedCascade(cId);
  }
});

test("CAS-613 AC4/AC6: a once-armed film is never re-armed after a manual untick, or unticked when autoNotify goes off", () => {
  const [film] = unwatchedFilms(1);
  const id = film.tmdb_id;
  const cId = seedAutoNotifyCascade(true);
  try {
    pinFilm(id, cId);
    withWatchPrefs({ stream: { list: true, notify: true } }, () => {
      E.recomputeFound();
      assert.equal(E.notify[id].wins.stream, true, "sanity: the first pass arms it");

      E.notify[id].wins.stream = false;   // the user's manual untick
      E.recomputeFound();                 // a second pass, same agent, same watchPrefs
      assert.equal(E.notify[id].wins.stream, false,
        "AC4: a manually-unticked auto-armed film must not be re-armed on a later pass");

      const c = E.cascades.find(x => x.id === cId);
      c.autoNotify = false;               // AC6: turning the agent's switch off
      E.notify[id].wins.stream = true;    // restore the armed state to isolate AC6 from AC4's untick
      E.recomputeFound();
      assert.equal(E.notify[id].wins.stream, true,
        "AC6: turning autoNotify off must not untick a film already armed");
    });
  } finally {
    delete E.notify[id];
    unseedCascade(cId);
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
