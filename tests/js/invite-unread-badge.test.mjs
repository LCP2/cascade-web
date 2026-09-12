// CAS-968: a bare dot read as decoration, not news, once a real reply landed. This asserts the count that
// every unread badge (hamburger corner + dropdown Invites item, wired through invitesBadgeText) actually
// shows, and that the Invites screen's own New pill (inviteRowHTML) appears on an unread row and not a
// read one — the two behaviours CAS-968's AC2/AC3 name directly.
import test from "node:test";
import assert from "node:assert/strict";
import { loadEngine } from "./engine.mjs";

const E = loadEngine();

function reply(seenAt){
  return { id: "r1", answer: "yes", created_at: "2026-09-12T10:00:00.000Z", seen_at: seenAt };
}
function invite(overrides){
  return {
    token: "tok1", tmdb_id: 999999, film_title: "Cascade Test", to_name: "Alex",
    created_at: "2026-09-11T10:00:00.000Z", invite_replies: [reply(null)],
    ...overrides,
  };
}

test("CAS-968 AC2: invitesBadgeText renders the unread count, and nothing once it's zero", () => {
  E.setInvites([
    invite({ invite_replies: [reply(null)] }),
    invite({ token: "tok2", invite_replies: [reply(null)] }),
  ]);
  assert.equal(E.invitesUnseenCount(), 2, "two replies, neither seen");
  assert.equal(E.invitesBadgeText(), "2", "AC2: badge text is the literal count");

  E.setInvites([]);
  assert.equal(E.invitesUnseenCount(), 0);
  assert.equal(E.invitesBadgeText(), "", "AC2: no badge at all once nothing is unread");
});

test("CAS-968 AC3: an unread Invites row carries the New pill, a read row does not", () => {
  const unreadRow = E.inviteRowHTML(invite({ invite_replies: [reply(null)] }), "new");
  assert.match(unreadRow, /class="invrow unread"/, "unread row gets the tinted-card class");
  assert.match(unreadRow, /class="pill invnew pulse">New</, "unread row carries the New pill");

  const readRow = E.inviteRowHTML(invite({ invite_replies: [reply("2026-09-12T11:00:00.000Z")] }), "earlier");
  assert.doesNotMatch(readRow, /invrow unread/, "a read row is not given the unread card treatment");
  assert.doesNotMatch(readRow, /invnew/, "a read row carries no New pill");
});
