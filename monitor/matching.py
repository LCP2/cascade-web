"""Match transitions to users' Cascades, then de-dupe (CAS-85 / spec 26771457 §5).

A transition (from ``transitions.py``) fires an alert for a Cascade when ALL hold:

  1. the transition's ``moment`` is one the Cascade asked for (``alert_moments``);
  2. the transition's movie is one the Cascade ADMITS — CAS-825: this is now a lookup into the
     SHIPPED engine's own answer (compute_admission(), via admit_shim.mjs), not a second, hand-
     ported field-by-field matcher;
  3. for a streaming moment, the service is one the Cascade cares about (when it names any);
  4. it hasn't been sent before — ``(cascade_id, movie_id, moment)`` not already in the
     ``notifications`` ledger.

Admission is asked of app_template.html's real ``matchesCriteria`` (loaded, unmodified, out of the
BUILT index.html — see tests/js/engine.mjs's CAS-231 harness) so an email only ever fires for a
film the user's Cascade would also surface in the app; the two can no longer drift apart the way
the old hand-port did (CAS-825 observation: 89% of Moving-screen films belonged to no agent).

Pure and side-effect free; the caller owns Supabase I/O (see store.py) and the one
``admit_shim.mjs`` subprocess call (see compute_admission() below).
"""
from __future__ import annotations

import datetime as _dt
import json
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

# tier_rank is the same monotonic-progress test transitions.py already imports; reused here (CAS-602)
# to find a film's own current window (its highest-ranked status member) rather than to guard a moment.
from poc_pipeline import tier_rank

from .transitions import Transition, _STATUS_MOMENTS, _detail_for

# CAS-825: admit_shim.mjs, invoked once per monitor run by compute_admission() below.
_SHIM_PATH = Path(__file__).resolve().parent / "admit_shim.mjs"


@dataclass
class Hit:
    """One Cascade catching one transition, for one user."""
    user_id: str
    cascade_id: str
    cascade_name: str
    transition: object      # monitor.transitions.Transition
    # CAS-244: which channels THIS agent will accept, read from criteria.channelsLive. None means the agent
    # predates the setting and takes whatever the account allows — the behaviour it already had.
    channels: Optional[dict] = None
    # CAS-849: this cascade's own _rank_key() tuple, carried on the hit so the digest can order its
    # agent sections without re-deriving rank from a cascade row it doesn't have. None for a hit with
    # no cascade (a per-film Watch it tick) — it never sorts by rank, see emailer._agent_sections.
    rank: Optional[tuple] = None

    def wants(self, channel: str) -> bool:
        """Does this agent accept delivery on `channel` ("in_app" | "email" | "push")?

        The account still decides what is AVAILABLE — this only ever narrows it, and the caller applies the
        account's own answer first. An agent that has never been asked accepts everything the account allows.

        CAS-465: "push" is not a fourth independent switch — from the user's mental model, allowing
        in-app notifications IS allowing Cascade to notify them, so push rides the same per-agent
        answer as "in_app" rather than needing its own `channelsLive` key.
        """
        if channel == "push":
            channel = "in_app"
        if not self.channels:
            return True
        return bool(self.channels.get(channel, True))

    def notification_row(self) -> dict:
        # CAS-185: the ledger is the in-app delivery as well as the email de-dupe, so it carries
        # what the bell needs to draw a row — the agent that caught the film and the film's title.
        # Deriving those in the app would mean the bell going blank for a film that has since left
        # the catalogue, and "we told you about this" is a fact about the past, not about today.
        return {
            "user_id": self.user_id,
            "cascade_id": self.cascade_id,
            "movie_id": self.transition.movie_id,
            "moment": self.transition.moment,
            "cascade_name": self.cascade_name,
            "title": self.transition.title,
        }


# --------------------------------------------------------------------------- #
# window placement (CAS-841) — window key (film_watch.windows, whether persisted there by the
# app's own auto-placement (CAS-726) or a manual Watch-it tick, CAS-484) -> the moment that
# window's arrival fires. Shared by match() below and match_film_watches() further down, which
# predates this mapping living up here.
# --------------------------------------------------------------------------- #
WINDOW_TO_MOMENT = {
    "in_cinema": "hits_cinema",
    "premium": "hits_pvod",
    "rent": "hits_rent",
    "stream": "hits_stream",
}
MOMENT_TO_WINDOW = {moment: window for window, moment in WINDOW_TO_MOMENT.items()}
WINDOW_ARRIVAL_MOMENTS = frozenset(WINDOW_TO_MOMENT.values())


def _film_watch_placements(film_watches) -> dict:
    """{(user_id, movie_id): {window_key, ...}} from film_watch rows, both stringified so lookups
    match however `transitions`/`cascades` already key their own ids. A row with an empty (or
    absent) `windows` contributes nothing — CAS-841 treats that the same as no row at all."""
    out: dict = {}
    for w in film_watches or ():
        windows = set(w.get("windows") or ())
        if not windows:
            continue
        out.setdefault((str(w.get("user_id")), str(w.get("movie_id"))), set()).update(windows)
    return out


# --------------------------------------------------------------------------- #
# taste matching — CAS-825: a lookup into the REAL engine's own admission answer, not a second port
# --------------------------------------------------------------------------- #
def compute_admission(cascades: list, catalogues: dict, account_prefs: dict = None) -> dict:
    """Ask the shipped engine, ONCE, which films each active Cascade admits — the exact question
    app_template.html's own matchesCriteria answers, via admit_shim.mjs (which loads the built
    index.html through tests/js/engine.mjs's loadEngine(), CAS-231's proven no-browser harness).
    Replaces the old hand-ported field-by-field matcher, which had drifted from the app's real one
    and was admitting ~89% more films than the app itself would ever show (CAS-825 observation).

    cascades      : rows {id, user_id, criteria, ...} — same shape `match()` etc. already take.
    catalogues    : {snapshot_label: [movie dict, ...]} — e.g. {"today": [...], "yesterday": [...]}.
                    Every snapshot a caller will later ask about must be included; matches_criteria()
                    below can only answer for what was asked here.
    account_prefs : {user_id: {langs, subServices, storeServices, filmStatuses}} — the account-level
                    facts matchesCriteria reads beyond an agent's own criteria (CAS-146 taste
                    baseline, CAS-211 services, CAS-183 watched/blocked opinions). A user absent here
                    gets the engine's own permissive "never touched this" defaults, same as a device
                    that has never opened those screens.

    Returns {cascade_id: {snapshot_label: {movie_id str, ...}}}.
    """
    account_prefs = account_prefs or {}
    by_user: dict = {}
    for c in cascades:
        by_user.setdefault(str(c.get("user_id")), []).append(
            {"id": c["id"], "criteria": c.get("criteria") or {}})

    users = []
    for uid, agents in by_user.items():
        p = account_prefs.get(uid) or {}
        users.append({
            "userId": uid,
            "langs": p.get("langs"),
            "subServices": p.get("subServices") or [],
            "storeServices": p.get("storeServices") or [],
            "filmStatuses": p.get("filmStatuses") or [],
            "agents": agents,
        })

    request = {"users": users, "catalogues": catalogues}
    proc = subprocess.run(
        ["node", str(_SHIM_PATH)], input=json.dumps(request), capture_output=True, text=True,
        encoding="utf-8", timeout=120,
    )
    if proc.returncode != 0:
        raise RuntimeError(
            f"admit_shim.mjs failed (exit {proc.returncode}): {proc.stderr.strip()}")
    try:
        result = json.loads(proc.stdout)
    except json.JSONDecodeError as err:
        raise RuntimeError(f"admit_shim.mjs produced invalid JSON: {err}\n{proc.stdout[:500]}") from err
    return {cid: {snap: set(ids) for snap, ids in snapshots.items()} for cid, snapshots in result.items()}


def matches_criteria(movie_id, cascade_id, snapshot: str, admission: dict) -> bool:
    """A lookup, not a recomputation (CAS-825): does `cascade_id` admit `movie_id` in `snapshot`,
    per the admission map compute_admission() already built for this run?"""
    return str(movie_id) in ((admission.get(cascade_id) or {}).get(snapshot) or ())


def service_ok(transition, criteria: dict) -> bool:
    """Streaming moments only fire when the arrival is on a service the Cascade named. If the
    Cascade names no services (criteria.services empty/absent), there is no service constraint.

    NB: the current front-end keeps the user's service list in device-local prefs, not in the
    Cascade, so criteria.services is usually absent -> streaming arrivals are not service-filtered.
    Populate criteria.services (list of service names) to switch that filtering on."""
    if transition.moment != "hits_stream":
        return True
    services = (criteria or {}).get("services") or []
    if not services:
        return True
    return any(s in services for s in (transition.services or []))


def suppressed_pairs(picks) -> set:
    """Normalise a personal-override list into the ``{(user_id, movie_id)}`` set ``match`` filters on.

    A "pick" row is one film one user has answered for, mirroring the front-end's ``cascade_notify``
    entry: ``{user_id, movie_id, state}`` where state is ``"mine"`` (My Pick — the user keeps it) or
    ``"off"`` (the user took it off, and it stays off). Only ``"off"`` suppresses. ``"mine"`` needs no
    rule here: a My Pick film the Cascade also matches would fire anyway, and one it does NOT match is
    kept surfaced by the app, not by an email the monitor was never going to send.
    """
    out = set()
    for p in picks or ():
        if not isinstance(p, dict):        # a JSON object instead of a list would iterate its keys as strings
            raise TypeError("picks must be a list of {user_id, movie_id, state} objects, "
                            f"got a {type(p).__name__} element")
        if (p.get("state") or "").lower() == "off":
            out.add((str(p.get("user_id")), str(p.get("movie_id"))))
    return out


def excluded_moments(prefs) -> dict:
    """Normalise the global alert-type exclude (CAS-103 AC4) into ``{user_id: {moment, ...}}``.

    A user can switch an alert TYPE off everywhere — "never alert me about Purchase" — and that
    preference outranks every one of their Cascades. `prefs` is an iterable of
    ``{user_id, excluded_moments: [...]}`` rows, or a plain ``{user_id: [moments]}`` mapping.

    Unknown moment names are kept rather than dropped: an exclude naming a moment we don't emit is
    inert, and silently discarding it would make a future rename fail open (i.e. start emailing
    about the very thing the user muted).
    """
    out: dict = {}
    if not prefs:
        return out
    items = prefs.items() if isinstance(prefs, dict) else (
        (p.get("user_id"), p.get("excluded_moments")) for p in prefs)
    for user_id, moments in items:
        if user_id is None:
            continue
        out.setdefault(str(user_id), set()).update(str(m) for m in (moments or ()) if m)
    return out


def _rank_key(cascade: dict):
    """(order, created_at, id) sort key for one cascade, lower wins (CAS-784). The agent's rank
    lives at `criteria.order` (there is no `order` column — the front end persists it inside the
    jsonb, see app_template.html ~19074). A missing or non-numeric `order` never beats a numeric
    one, so it sorts as +inf; remaining ties break on `created_at`, then `id`."""
    order = (cascade.get("criteria") or {}).get("order")
    numeric = isinstance(order, (int, float)) and not isinstance(order, bool)
    return (order if numeric else float("inf"), str(cascade.get("created_at") or ""),
            str(cascade.get("id") or ""))


def _collapse_by_rank(hits: list, rank_of: dict) -> list:
    """CAS-784: one film, one agent, one line. Two hits sharing (user_id, movie_id, moment) —
    two active Cascades both catching the same film at the same moment — collapse to the single
    hit whose cascade has the lowest `_rank_key`, mirroring the app's own unpinned-ownership rule
    (CAS-709: a film belongs to its lowest-`.order` matching agent) so the email agrees with the
    screen about which agent "owns" the film."""
    best = {}
    for h in hits:
        key = (h.user_id, h.transition.movie_id, h.transition.moment)
        cur = best.get(key)
        if cur is None or rank_of.get(h.cascade_id, (float("inf"), "", "")) < \
                rank_of.get(cur.cascade_id, (float("inf"), "", "")):
            best[key] = h
    return list(best.values())


def match(cascades: list, transitions: list, already=None, admission=None, suppressed=None,
          excluded=None, film_watches=None, placement_counts=None) -> dict:
    """Return {user_id: [Hit, ...]} — one entry per (cascade, transition) that fires and hasn't
    been sent before.

    cascades    : rows {id, user_id, name, criteria, alert_moments, active}
    transitions : list of Transition (from compute_transitions)
    already     : iterable of (cascade_id, movie_id, moment) already in the notifications ledger
    admission   : {cascade_id: {"today": {movie_id, ...}}} from compute_admission() (CAS-825) —
                  transitions describe today's catalogue, so only the "today" snapshot is read here.
                  None/missing admits nothing (fails closed, same as an unrecognised cascade_id).
    suppressed  : iterable of (user_id, movie_id) the user has turned OFF by hand (see
                  ``suppressed_pairs``). The personal override outranks the Cascade: it goes on
                  matching the film and we go on saying nothing about it, every run, until the user
                  changes their mind. Empty/None -> nothing is suppressed.
    excluded    : {user_id: {moment, ...}} of alert TYPES the user has muted globally in
                  Preferences (see ``excluded_moments``). Like `suppressed`, it outranks the
                  Cascade — a muted type never fires for that user, whatever their Cascades say.
                  Empty/None -> nothing is globally muted.
    film_watches : iterable of {user_id, movie_id, windows} — the `film_watch` table (CAS-484/
                  CAS-726). CAS-841: a window-arrival moment (hits_cinema/hits_pvod/hits_rent/
                  hits_stream) only fires when that moment's own window is present in the film's
                  placement for that user; any other window-arrival moment for that film is
                  skipped. A film with no row here (or an empty `windows`) skips EVERY
                  window-arrival moment for it — fail closed, the app would not have shown it in
                  that tab either. Non-window moments (announced, opens_soon,
                  past_opening_weekend, newly_qualifies, new_to_agent) are never gated by this.
                  None/missing behaves as "nothing is placed anywhere".
    placement_counts : an optional dict this call increments in place, so a caller can report the
                  size of CAS-841's effect: "no_placement" for a hit skipped because the film has
                  no placement row (or an empty one), "wrong_window" for a hit skipped because the
                  film IS placed, just not in the window this moment maps to. Omit to not count.

    CAS-784: when two of a user's active Cascades both catch the same film at the same moment,
    only the lowest-`criteria.order` one is kept — one film, one agent, one line, on email same
    as on screen.
    """
    seen = set(already or ())
    off = {(str(u), str(m)) for u, m in (suppressed or ())}
    muted = excluded_moments(excluded)
    admission = admission or {}
    placements = _film_watch_placements(film_watches)
    rank_of = {c["id"]: _rank_key(c) for c in cascades}
    by_user: dict = {}

    for c in cascades:
        if not c.get("active", True):
            continue
        moments = set(c.get("alert_moments") or [])
        # The global exclude is applied to the Cascade's own list, so everything downstream —
        # the de-dupe key, the ledger, the digest — simply never sees a muted moment.
        moments -= muted.get(str(c["user_id"]), set())
        criteria = c.get("criteria") or {}
        for t in transitions:
            if t.moment not in moments:
                continue
            if (str(c["user_id"]), str(t.movie_id)) in off:
                continue                                    # your answer outranks your Cascade
            if not matches_criteria(t.movie_id, c["id"], "today", admission):
                continue
            if not service_ok(t, criteria):
                continue
            if t.moment in WINDOW_ARRIVAL_MOMENTS:
                windows_here = placements.get((str(c["user_id"]), str(t.movie_id)))
                if not windows_here:
                    if placement_counts is not None:
                        placement_counts["no_placement"] = placement_counts.get("no_placement", 0) + 1
                    continue
                if MOMENT_TO_WINDOW[t.moment] not in windows_here:
                    if placement_counts is not None:
                        placement_counts["wrong_window"] = placement_counts.get("wrong_window", 0) + 1
                    continue
            key = (c["id"], t.movie_id, t.moment)
            if key in seen:
                continue
            seen.add(key)   # guard against two identical Cascades double-firing within one run
            by_user.setdefault(c["user_id"], []).append(
                Hit(user_id=c["user_id"], cascade_id=c["id"],
                    cascade_name=c.get("name", "My Cascade"), transition=t,
                    channels=agent_channels(criteria), rank=rank_of[c["id"]]))
    return {uid: _collapse_by_rank(hits, rank_of) for uid, hits in by_user.items()}


# --------------------------------------------------------------------------- #
# CAS-602: a film already held in BOTH catalogues that newly qualifies for an agent — no catalogue
# transition to hang this off, since the film was already there.
# --------------------------------------------------------------------------- #
_MOMENT_FOR_STATUS = dict((status, moment) for moment, status in _STATUS_MOMENTS)


def _current_moment(record: dict) -> Optional[str]:
    """The moment ``newly_qualifies`` maps to for one movie record: the mapped moment of its own
    CURRENT window (the highest-ranked member of its `status`, via poc_pipeline.tier_rank), or
    "announced" for a film still `upcoming`. None if the record carries no recognised window."""
    ranked = [(tier_rank([s]), s) for s in (record.get("status") or [])]
    ranked = [(r, s) for r, s in ranked if r >= 0]
    if not ranked:
        return None
    window = max(ranked)[1]
    if window == "upcoming":
        return "announced"
    return _MOMENT_FOR_STATUS.get(window)


def match_newly_qualified(cascades: list, prev_movies: list, today_movies: list, already=None,
                          admission=None, suppressed=None, excluded=None, covered=None) -> dict:
    """Return {user_id: [Hit, ...]} for a film present in both catalogues whose own attributes
    changed so it now matches an active Cascade's criteria and did NOT match yesterday (Lee's rule,
    2026-08-24) — an IMDb rating crossing the bar, a metacritic score/award/gross arriving, a genre
    or age-rating correction. Re-running the SAME criteria against both records is deliberate:
    editing an agent's criteria must never make its whole existing list "newly qualify" at once.

    Fires only for the moment the film's CURRENT window maps to — the same Alert toggle a real
    window transition for this film would use, per Lee's decision that this needs no new toggle —
    and only when that moment is one the Cascade's `alert_moments` actually asks for. The Hit it
    produces always carries ``Transition(moment="newly_qualifies", ...)`` so its ledger row and
    de-dupe key are distinct from a window transition for the same film.

    prev_movies / today_movies : lists of movie records (poc_pipeline shape).
    already, suppressed, excluded : same meaning as in ``match()``.
    admission           : {cascade_id: {"today": {...}, "yesterday": {...}}} from compute_admission()
                          (CAS-825) — both snapshots are read here, since "newly" means "admitted
                          today, was not admitted in this same film's yesterday record".
    covered            : iterable of (cascade_id, movie_id) already alerted THIS run by ``match()``
                         — a real window transition landing the same day as this film's own
                         newly-qualifies wins; the newly-qualifies hit for that pair is dropped
                         (CAS-796), the same shape ``match_new_to_agent``'s `covered` param uses.

    CAS-784: same one-film-one-agent collapse as ``match()`` — see its docstring.
    """
    prev_by_id = {str(m.get("tmdb_id")): m for m in prev_movies}
    today_by_id = {str(m.get("tmdb_id")): m for m in today_movies}
    seen = set(already or ())
    off = {(str(u), str(m)) for u, m in (suppressed or ())}
    muted = excluded_moments(excluded)
    admission = admission or {}
    rank_of = {c["id"]: _rank_key(c) for c in cascades}
    covered = set(covered or ())
    by_user: dict = {}

    for c in cascades:
        if not c.get("active", True):
            continue
        moments = set(c.get("alert_moments") or [])
        moments -= muted.get(str(c["user_id"]), set())
        if not moments:
            continue
        criteria = c.get("criteria") or {}
        for mid, today_record in today_by_id.items():
            prev_record = prev_by_id.get(mid)
            if prev_record is None:
                continue                       # a first sighting is `announced`'s job, not this one
            if (str(c["user_id"]), mid) in off:
                continue                       # your answer outranks your Cascade
            if (c["id"], mid) in covered:
                continue                       # a real window transition this run wins (CAS-796)
            if matches_criteria(mid, c["id"], "yesterday", admission):
                continue                       # already matched yesterday -> not a NEW qualification
            if not matches_criteria(mid, c["id"], "today", admission):
                continue                       # still doesn't match today
            moment = _current_moment(today_record)
            if moment is None or moment not in moments:
                continue
            services, price = _detail_for(moment, today_record)
            probe = Transition(mid, today_record.get("title", ""), moment,
                               services=services, price=price, movie=today_record)
            if not service_ok(probe, criteria):
                continue
            key = (c["id"], mid, "newly_qualifies")
            if key in seen:
                continue
            seen.add(key)
            t = Transition(mid, today_record.get("title", ""), "newly_qualifies",
                          services=services, price=price, movie=today_record)
            by_user.setdefault(c["user_id"], []).append(
                Hit(user_id=c["user_id"], cascade_id=c["id"],
                    cascade_name=c.get("name", "My Cascade"), transition=t,
                    channels=agent_channels(criteria), rank=rank_of[c["id"]]))
    return {uid: _collapse_by_rank(hits, rank_of) for uid, hits in by_user.items()}


# --------------------------------------------------------------------------- #
# CAS-785: a film first appearing on an agent — unless the appearance was the user's own doing
# --------------------------------------------------------------------------- #
def _parse_dt(value):
    """Parse a timestamp that may arrive as an ISO string (Supabase's `updated_at`) or an
    already-a-datetime (fixtures/tests). None for anything missing or unparsable — never raises;
    the caller treats "can't prove this agent is stable" the same as "it isn't"."""
    if isinstance(value, _dt.datetime):
        return value if value.tzinfo else value.replace(tzinfo=_dt.timezone.utc)
    if not value:
        return None
    s = str(value)
    if s.endswith("Z"):
        s = s[:-1] + "+00:00"
    try:
        parsed = _dt.datetime.fromisoformat(s)
    except ValueError:
        return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=_dt.timezone.utc)


def match_new_to_agent(cascades: list, prev_movies: list, today_movies: list, previous_run_start,
                       already=None, admission=None, suppressed=None, excluded=None,
                       covered=None) -> dict:
    """Return {user_id: [Hit, ...]} for CAS-785's first-appearance moment: a film present in both
    catalogues that matches an active Cascade's criteria today and did NOT match it yesterday —
    the same test ``match_newly_qualified`` makes — fired ONLY when the Cascade itself has been
    stable across that comparison: its ``updated_at`` predates ``previous_run_start``. A Cascade
    edited since then produces nothing here for this run (Lee's 2026-08-24 rule: an edit must
    never fire the user's whole list); the alert is not deferred to a later run.

    Unlike ``newly_qualifies``, this does not ride a window's own moment (``hits_rent`` etc.) — it
    is its own moment, gated only by the global excluded-moments mute, so it can tell a user their
    agent gained a film even when they have no window alerts switched on for it.

    previous_run_start : datetime — the start of the run before this one. Missing/unparsable
                         `updated_at` counts as "not proven stable" (fails closed, same caution as
                         the edit-window check itself).
    covered            : iterable of (cascade_id, movie_id) already alerted THIS run by match() /
                         match_newly_qualified() — a real window transition landing the same day as
                         a first appearance still produces ONE alert, not two (CAS-785 AC1c).
    already, suppressed, excluded : same meaning as match_newly_qualified.
    admission          : same {cascade_id: {"today": {...}, "yesterday": {...}}} shape as
                         match_newly_qualified takes (CAS-825) — both snapshots are read here too.
    """
    prev_by_id = {str(m.get("tmdb_id")): m for m in prev_movies}
    today_by_id = {str(m.get("tmdb_id")): m for m in today_movies}
    seen = set(already or ())
    off = {(str(u), str(m)) for u, m in (suppressed or ())}
    muted = excluded_moments(excluded)
    admission = admission or {}
    rank_of = {c["id"]: _rank_key(c) for c in cascades}
    covered = set(covered or ())
    by_user: dict = {}

    for c in cascades:
        if not c.get("active", True):
            continue
        if "new_to_agent" in muted.get(str(c["user_id"]), set()):
            continue
        updated_at = _parse_dt(c.get("updated_at"))
        if updated_at is None or updated_at >= previous_run_start:
            continue                       # edited inside the window, or unprovable -> silent
        criteria = c.get("criteria") or {}
        for mid, today_record in today_by_id.items():
            if (c["id"], mid) in covered:
                continue                   # already alerted this run some other way
            prev_record = prev_by_id.get(mid)
            if prev_record is None:
                continue                   # a first sighting is announced's job, not this one
            if (str(c["user_id"]), mid) in off:
                continue                   # your answer outranks your Cascade
            if matches_criteria(mid, c["id"], "yesterday", admission):
                continue                   # already matched yesterday -> not a first appearance
            if not matches_criteria(mid, c["id"], "today", admission):
                continue                   # still doesn't match today
            key = (c["id"], mid, "new_to_agent")
            if key in seen:
                continue
            seen.add(key)
            t = Transition(mid, today_record.get("title", ""), "new_to_agent", movie=today_record)
            by_user.setdefault(c["user_id"], []).append(
                Hit(user_id=c["user_id"], cascade_id=c["id"],
                    cascade_name=c.get("name", "My Cascade"), transition=t,
                    channels=agent_channels(criteria), rank=rank_of[c["id"]]))
    return {uid: _collapse_by_rank(hits, rank_of) for uid, hits in by_user.items()}


# --------------------------------------------------------------------------- #
# delivery preferences (CAS-185)
# --------------------------------------------------------------------------- #
# A user who has never opened the notify screen has no row, and that is not the same as
# "wants nothing": the app's own default is in-app on, email off, which is what these say.
PREFS_DEFAULT = {"in_app": True, "email_on": False, "email_address": None, "excluded_moments": []}


def agent_channels(criteria: dict) -> Optional[dict]:
    """CAS-244: {in_app, email} for one agent, or None if it has never been asked.

    The front end writes `channelsLive` — the RESOLVED answer, account permission already applied — precisely
    so this function never has to know anything about the account. Its own `channels` field holds the raw
    per-agent answer and is deliberately not read here: a channel the account has switched off must not be
    deliverable just because the agent still remembers wanting it.
    """
    live = (criteria or {}).get("channelsLive")
    if not isinstance(live, dict):
        return None
    return {"in_app": bool(live.get("inApp", True)), "email": bool(live.get("email", True))}


def prefs_for(prefs: dict, user_id: str) -> dict:
    """The delivery preferences that apply to one user, defaults filled in."""
    row = (prefs or {}).get(str(user_id)) or {}
    out = dict(PREFS_DEFAULT)
    for k in out:
        if row.get(k) is not None:
            out[k] = row[k]
    return out


def delivery_plan(pref: dict, email) -> str:
    """What actually happens for one user on one run: "email", "inapp", "none" or "wait".

    There are two deliveries and they fail differently, so the decision is stated once, here,
    rather than inline in the run loop where the ledger write also lives:

      email — the user asked for it and we have an address. The ledger is written only after the
              send succeeds, so a failure is retried next run rather than silently marked done.
      inapp — the ledger row IS the delivery. Nothing can fail, so it is written outright.
      wait  — they asked for email and we have no address. Writing the ledger would mark the
              alert delivered when nobody was told, so we write nothing and try again tomorrow.
      none  — both channels off. Nothing sent AND nothing written: switching notifications on
              later must not be met with silence about the thing that just happened.
    """
    pref = pref or {}
    if pref.get("email_on"):
        return "email" if email else "wait"
    return "inapp" if pref.get("in_app") else "none"


def excludes_from_prefs(prefs: dict) -> dict:
    """{user_id: {moment, ...}} from a notify_prefs map — the same shape excluded_moments()
    produces, so match() takes either without caring where the mute came from."""
    return excluded_moments({u: (r or {}).get("excluded_moments") or [] for u, r in (prefs or {}).items()})


def notification_rows(by_user: dict) -> list:
    """Flatten the match result into rows for the notifications ledger."""
    rows = []
    for hits in by_user.values():
        for h in hits:
            rows.append(h.notification_row())
    return rows


# --------------------------------------------------------------------------- #
# per-film "Watch it" ticks (CAS-484) — a second, agent-independent source
# --------------------------------------------------------------------------- #
# WINDOW_TO_MOMENT (window key, as ticked on the film's Watch-it control, app_template.html's
# WATCH_LEVEL_KEYS -> the moment it arms) now lives above, near compute_admission — CAS-841 made
# match() a second reader of it.
def match_film_watches(watches, transitions, already=None, cascade_hits=None, excluded=None,
                       suppressed=None) -> dict:
    """Return {user_id: [Hit, ...]} for per-film Watch-it ticks (CAS-484) — hits that owe nothing
    to any Cascade's own criteria or bell. A tick arms an alert for THAT film reaching THAT window
    full stop, so unlike ``match()`` there is no taste/criteria/service test here at all.

    watches    : rows {user_id, movie_id, windows: [window_key, ...]} (the `film_watch` table).
    already    : {(user_id, movie_id, moment)} already delivered via THIS path — read separately
                 from match()'s cascade-keyed `already` because these ledger rows carry a null
                 cascade_id, which the (cascade_id, movie_id, moment) unique constraint alone does
                 not de-dupe across users (see store.fetch_watch_notification_keys).
    cascade_hits : {(user_id, movie_id, moment)} already produced by match() THIS run. A film
                 covered by both an agent's bell and a per-film tick must fire once, not twice
                 (CAS-484 AC3) — call match() first and pass its keys here.
    excluded   : the same {user_id: {moment, ...}} global mute match() takes — a muted alert TYPE
                 outranks a per-film tick exactly as it outranks a Cascade.
    suppressed : the same {(user_id, movie_id)} personal-override set match() takes (see
                 ``suppressed_pairs``) — CAS-788: a watched or blocked film clears its own tick on
                 the way through the app, but a stale row from before that clear must not still
                 fire here.
    """
    seen = set(already or ())
    covered = set(cascade_hits or ())
    muted = excluded_moments(excluded)
    off = {(str(u), str(m)) for u, m in (suppressed or ())}
    by_movie: dict = {}
    for t in transitions:
        by_movie.setdefault(str(t.movie_id), []).append(t)

    by_user: dict = {}
    for w in watches or ():
        user_id = str(w.get("user_id"))
        movie_id = str(w.get("movie_id"))
        if (user_id, movie_id) in off:
            continue
        moments = {WINDOW_TO_MOMENT[k] for k in (w.get("windows") or ()) if k in WINDOW_TO_MOMENT}
        moments -= muted.get(user_id, set())
        if not moments:
            continue
        for t in by_movie.get(movie_id, ()):
            if t.moment not in moments:
                continue
            key = (user_id, movie_id, t.moment)
            if key in seen or key in covered:
                continue
            seen.add(key)
            by_user.setdefault(user_id, []).append(
                Hit(user_id=user_id, cascade_id=None, cascade_name="Your picks", transition=t))
    return by_user
