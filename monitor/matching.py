"""Match transitions to users' Cascades, then de-dupe (CAS-85 / spec 26771457 §5).

A transition (from ``transitions.py``) fires an alert for a Cascade when ALL hold:

  1. the transition's ``moment`` is one the Cascade asked for (``alert_moments``);
  2. the transition's movie matches the Cascade's **taste** criteria
     (genre / exclude / age / language / culture / awards / imdb / rt / budget / tentpole);
  3. for a streaming moment, the service is one the Cascade cares about (when it names any);
  4. it hasn't been sent before — ``(cascade_id, movie_id, moment)`` not already in the
     ``notifications`` ledger.

The taste matcher mirrors ``matchesCriteria`` in the front-end (app_template.html) with the
window/status test removed — the transition already establishes the window, so matching is
purely about whether the user cares about *this film*. Keeping the two in lock-step means an
email only ever fires for a film the user's Cascade would also surface in the app.

Pure and side-effect free; the caller owns Supabase I/O (see store.py).
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Optional

# tier_rank is the same monotonic-progress test transitions.py already imports; reused here (CAS-602)
# to find a film's own current window (its highest-ranked status member) rather than to guard a moment.
from poc_pipeline import tier_rank

from .transitions import Transition, _STATUS_MOMENTS, _detail_for

# --- catalogue-scale constants, ported verbatim from app_template.html (CAS-64) ---
_ANTICIPATED_TOP = 20      # top N% of UPCOMING titles by popularity
_BLOCKBUSTER_TOP = 15      # top N% of the whole catalogue by popularity
_BIG_BUDGET = 120e6        # the "Huge" band
_LANDMARK_RT = 85
_LANDMARK_META = 75

# BUDGET_BANDS index -> (min, max); mirrors app_template.html. Index 0 = "Any".
_BUDGET_BANDS = [
    (None, None),          # Any
    (0, 15e6),             # Small
    (15e6, 50e6),          # Average
    (50e6, 120e6),         # Big
    (120e6, None),         # Huge
]


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
# taste matching — mirrors matchesCriteria() minus the window/status + local sets
# --------------------------------------------------------------------------- #
def _year_of(movie: dict) -> str:
    return str(movie.get("cinema_date") or movie.get("year") or "")[:4]


def _rating_ok(movie: dict, minimum, include_unrated) -> bool:
    if not minimum:
        return True
    if not movie.get("imdb_rating"):
        return bool(include_unrated)
    return movie["imdb_rating"] >= minimum


def _budget_ok(movie: dict, band, include_unbudgeted) -> bool:
    if not band:
        return True
    try:
        lo, hi = _BUDGET_BANDS[band]
    except (IndexError, TypeError):
        return True
    b = movie.get("budget")
    if not b:
        return bool(include_unbudgeted)
    return b >= lo and (hi is None or b < hi)


def _pop(m: dict):
    return m.get("popularity") or 0


def _is_upcoming(m: dict) -> bool:
    return "upcoming" in (m.get("status") or [])


def _pop_bar(values, top_pct) -> float:
    """The popularity at the top-N% cut of a distribution — mirrors popBar() incl. JS rounding."""
    if not values:
        return float("inf")
    arr = sorted(values)
    idx = int((100 - top_pct) / 100 * (len(arr) - 1) + 0.5)   # JS Math.round for non-negative
    idx = min(len(arr) - 1, idx)
    return arr[idx]


def scale_tiers(catalogue: list) -> dict:
    """movie_id -> tentpole tier (landmark|blockbuster|anticipated|bigbudget|None), read off the
    catalogue's real popularity distribution. Mirrors scaleTier() in the front-end."""
    ant_bar = _pop_bar([_pop(m) for m in catalogue if _is_upcoming(m)], _ANTICIPATED_TOP)
    blk_bar = _pop_bar([_pop(m) for m in catalogue], _BLOCKBUSTER_TOP)
    tiers = {}
    for m in catalogue:
        big = (m.get("budget") or 0) >= _BIG_BUDGET
        hicrit = (m.get("rt_critic") or 0) >= _LANDMARK_RT or (m.get("metacritic") or 0) >= _LANDMARK_META
        hipop = _pop(m) >= blk_bar
        up = _is_upcoming(m)
        if m.get("award") and hicrit and (big or hipop):
            tier = "landmark"
        elif (not up) and hipop:
            tier = "blockbuster"
        elif up and _pop(m) >= ant_bar:
            tier = "anticipated"
        elif big:
            tier = "bigbudget"
        else:
            tier = None
        tiers[str(m.get("tmdb_id"))] = tier
    return tiers


def matches_criteria(movie: dict, criteria: dict, tier=None) -> bool:
    """Taste-only match (no window/status, no device-local watched/blocked). `tier` is the movie's
    precomputed scale tier (from scale_tiers) — required only if the Cascade sets a tentpole filter."""
    criteria = criteria or {}
    genres = movie.get("genres") or []

    exclude = criteria.get("exclude") or []
    if exclude and any(g in exclude for g in genres):
        return False                                    # skip beats match
    genre = criteria.get("genre") or []
    if genre and not any(g in genre for g in genres):
        return False
    age = criteria.get("age") or []
    if age and movie.get("age_rating") not in age:
        return False
    year = criteria.get("year") or []
    if year and _year_of(movie) not in year:
        return False
    lang = criteria.get("lang") or []
    if lang and movie.get("language") not in lang:
        return False
    culture = criteria.get("culture") or []
    if culture and movie.get("culture") not in culture:
        return False
    if criteria.get("awards") and not movie.get("award"):
        return False
    if not _rating_ok(movie, criteria.get("imdb") or 0, criteria.get("includeUnrated")):
        return False
    if not _budget_ok(movie, criteria.get("budget") or 0, criteria.get("includeUnbudgeted")):
        return False
    if (movie.get("rt_critic") or 0) < (criteria.get("rt") or 0):
        return False
    tent = criteria.get("tentpole") or "any"
    if tent != "any" and tier != tent:
        return False
    return True


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


def match(cascades: list, transitions: list, already=None, catalogue=None, suppressed=None,
          excluded=None) -> dict:
    """Return {user_id: [Hit, ...]} — one entry per (cascade, transition) that fires and hasn't
    been sent before.

    cascades    : rows {id, user_id, name, criteria, alert_moments, active}
    transitions : list of Transition (from compute_transitions)
    already     : iterable of (cascade_id, movie_id, moment) already in the notifications ledger
    catalogue   : today's movie list, for the tentpole tiers (optional; only needed if a Cascade
                  uses a tentpole filter)
    suppressed  : iterable of (user_id, movie_id) the user has turned OFF by hand (see
                  ``suppressed_pairs``). The personal override outranks the Cascade: it goes on
                  matching the film and we go on saying nothing about it, every run, until the user
                  changes their mind. Empty/None -> nothing is suppressed.
    excluded    : {user_id: {moment, ...}} of alert TYPES the user has muted globally in
                  Preferences (see ``excluded_moments``). Like `suppressed`, it outranks the
                  Cascade — a muted type never fires for that user, whatever their Cascades say.
                  Empty/None -> nothing is globally muted.
    """
    seen = set(already or ())
    off = {(str(u), str(m)) for u, m in (suppressed or ())}
    muted = excluded_moments(excluded)
    tiers = scale_tiers(catalogue) if catalogue else {}
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
            if not matches_criteria(t.movie, criteria, tier=tiers.get(t.movie_id)):
                continue
            if not service_ok(t, criteria):
                continue
            key = (c["id"], t.movie_id, t.moment)
            if key in seen:
                continue
            seen.add(key)   # guard against two identical Cascades double-firing within one run
            by_user.setdefault(c["user_id"], []).append(
                Hit(user_id=c["user_id"], cascade_id=c["id"],
                    cascade_name=c.get("name", "My Cascade"), transition=t,
                    channels=agent_channels(criteria)))
    return by_user


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
                          catalogue=None, suppressed=None, excluded=None) -> dict:
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
    already, catalogue, suppressed, excluded : same meaning as in ``match()``.
    """
    prev_by_id = {str(m.get("tmdb_id")): m for m in prev_movies}
    today_by_id = {str(m.get("tmdb_id")): m for m in today_movies}
    seen = set(already or ())
    off = {(str(u), str(m)) for u, m in (suppressed or ())}
    muted = excluded_moments(excluded)
    tiers = scale_tiers(catalogue) if catalogue else {}
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
            tier = tiers.get(mid)
            if matches_criteria(prev_record, criteria, tier=tier):
                continue                       # already matched yesterday -> not a NEW qualification
            if not matches_criteria(today_record, criteria, tier=tier):
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
                    channels=agent_channels(criteria)))
    return by_user


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
# window key (as ticked on the film's Watch-it control, app_template.html's WATCH_LEVEL_KEYS) ->
# the moment it arms. Mirrors the app's own rung labels one to one.
WINDOW_TO_MOMENT = {
    "in_cinema": "hits_cinema",
    "premium": "hits_pvod",
    "rent": "hits_rent",
    "stream": "hits_stream",
}


def match_film_watches(watches, transitions, already=None, cascade_hits=None, excluded=None) -> dict:
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
    """
    seen = set(already or ())
    covered = set(cascade_hits or ())
    muted = excluded_moments(excluded)
    by_movie: dict = {}
    for t in transitions:
        by_movie.setdefault(str(t.movie_id), []).append(t)

    by_user: dict = {}
    for w in watches or ():
        user_id = str(w.get("user_id"))
        movie_id = str(w.get("movie_id"))
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
