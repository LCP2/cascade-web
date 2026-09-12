// CAS-929: window.shareFilm's navigator.share({title, text, url}) call is gone — CAS-272/284/928/930/931
// replaced the old Web Share sheet with the friends-picker invite flow entirely, so the Outlook-drops-the-
// url bug this ticket named can no longer happen on that path. What survives is openNextInviteChannel's
// (and its Recommend twin openNextRecommendChannel's) clipboard fallback — the one place CAS-929's own
// ticket text says to apply the same rule instead: "a target that reads only text still gets the link".
// These drive the real fallback functions (window.open is stubbed to always return null in this harness,
// so the clipboard branch always fires) and assert the copied text actually carries the full URL.
import test from "node:test";
import assert from "node:assert/strict";
import { loadEngine } from "./engine.mjs";

const E = loadEngine();

function withCapturedClipboard(fn){
  const saved = E.navigator.clipboard;
  let captured = null;
  E.navigator.clipboard = { writeText: text => { captured = text; return Promise.resolve(); } };
  try{ fn(() => captured); }
  finally{ E.navigator.clipboard = saved; }
}

test("CAS-929: openNextInviteChannel's clipboard fallback carries the full invite URL", () => withCapturedClipboard(get => {
  const [m] = E.MOVIES;
  const token = "abc123tok9";
  const url = E.inviteUrlFor(token, m);
  E.openNextInviteChannel([{ friend: { name: "Alex", mobile: "0412345678" }, channel: "sms", token }], m);
  const text = get();
  assert.ok(text, "AC2: the clipboard fallback must have run");
  assert.ok(text.includes(url), "AC2: the copied text must include the full invite URL");
}));

test("CAS-929: openNextRecommendChannel's clipboard fallback carries the full cascademovies.com link", () => withCapturedClipboard(get => {
  E.openNextRecommendChannel([{ friend: { name: "Sam", mobile: "0412345678" }, channel: "whatsapp", message: "Come try Cascade" }]);
  const text = get();
  assert.ok(text, "AC2: the clipboard fallback must have run");
  assert.ok(text.includes("https://cascademovies.com"), "AC2: the copied text must include the full link");
}));
