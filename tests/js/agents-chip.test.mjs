// CAS-786: the agent chip (agentChipHTML) gains the same gold/blue provenance convention CAS-712 gave the
// Watch On chip — csrc-manual when the film's owner is a hand placement (notify[id].pinnedTo), csrc-auto
// when the owner came from rank, neither class when the film has no owner.
import test from "node:test";
import assert from "node:assert/strict";
import { loadEngine } from "./engine.mjs";

const E = loadEngine();

function withNotifyAndCascadeState(fn){
  const savedNotify = { ...E.notify };
  const savedCascades = [...E.cascades];
  try{ fn(); }
  finally{
    Object.keys(E.notify).forEach(k => delete E.notify[k]);
    Object.assign(E.notify, savedNotify);
    E.cascades.length = 0;
    E.cascades.push(...savedCascades);
  }
}
function broadCascade(id){
  const c = E.normCascade({ kind: "stream", status: [] });
  c.id = id; c.paused = false; c.order = 1;
  return c;
}

test("CAS-786 AC1: a hand-placed owner reads csrc-manual, not csrc-auto", () => withNotifyAndCascadeState(() => {
  const c = broadCascade("cas786-manual");
  E.cascades.push(c);
  const id = 786001;
  E.notify[id] = { cascadeIds: [c.id], pinnedTo: [c.id] };

  const html = E.agentChipHTML(id);
  assert.match(html, /\bcsrc-manual\b/, "a hand-placed owner must carry csrc-manual");
  assert.doesNotMatch(html, /\bcsrc-auto\b/, "a hand-placed owner must not also carry csrc-auto");
}));

test("CAS-786 AC1: a rank-chosen owner reads csrc-auto, not csrc-manual", () => withNotifyAndCascadeState(() => {
  const c = broadCascade("cas786-auto");
  E.cascades.push(c);
  const id = 786002;
  E.notify[id] = { cascadeIds: [c.id], pinnedTo: [] };

  const html = E.agentChipHTML(id);
  assert.match(html, /\bcsrc-auto\b/, "a rank-chosen owner must carry csrc-auto");
  assert.doesNotMatch(html, /\bcsrc-manual\b/, "a rank-chosen owner must not also carry csrc-manual");
}));

test("CAS-786 AC1: a film with no owner carries neither provenance class", () => withNotifyAndCascadeState(() => {
  const id = 786003;
  E.notify[id] = { cascadeIds: [], pinnedTo: [] };

  const html = E.agentChipHTML(id);
  assert.doesNotMatch(html, /\bcsrc-manual\b/, "an unowned film must not carry csrc-manual");
  assert.doesNotMatch(html, /\bcsrc-auto\b/, "an unowned film must not carry csrc-auto");
}));

// CAS-847: the Watch On chip's not-yet-reached icon used to be the retired ICON.bell — it now borrows the
// availability capsule's own WIN_ICON vocabulary for the level the chip names, so chip and lozenge share one
// icon set. No level picked yet falls back to WIN_ICON.upcoming, the ladder's own "nothing chosen" mark.
test("CAS-847 AC3: the Watch On chip's not-yet-reached icon borrows WIN_ICON, never the retired bell", () => withNotifyAndCascadeState(() => {
  const m = E.MOVIES.find(x => x.status.includes("upcoming"));
  assert.ok(m, "no upcoming film in the catalogue — this test would prove nothing");
  const id = m.tmdb_id;

  E.notify[id] = { wins: {} };
  let html = E.notifyChipHTML(id);
  assert.ok(html.includes("🗓️"), "an unset Watch On must show the upcoming WIN_ICON, not the retired bell");
  assert.doesNotMatch(html, /M6\.4 10\.2a5\.6/, "the retired bell glyph path must not appear in the chip's markup");

  E.notify[id] = { wins: { premium: true } };
  html = E.notifyChipHTML(id);
  assert.ok(html.includes("⭐"), "a not-yet-reached Premium pick must show the pvod WIN_ICON");
  assert.doesNotMatch(html, /M6\.4 10\.2a5\.6/, "the retired bell glyph path must not appear in the chip's markup");
}));
