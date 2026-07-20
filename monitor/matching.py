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

    def notification_row(self) -> dict:
        return {
            "user_id": self.user_id,
            "cascade_id": self.cascade_id,
            "movie_id": self.transition.movie_id,
            "moment": self.transition.moment,
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
                    cascade_name=c.get("name", "My Cascade"), transition=t))
    return by_user


def notification_rows(by_user: dict) -> list:
    """Flatten the match result into rows for the notifications ledger."""
    rows = []
    for hits in by_user.values():
        for h in hits:
            rows.append(h.notification_row())
    return rows
