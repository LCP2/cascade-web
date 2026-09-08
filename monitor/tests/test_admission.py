"""CAS-825 AC2 — the real admission path, end to end.

Exercises compute_admission() -> admit_shim.mjs -> the SHIPPED engine (tests/js/engine.mjs's own
loadEngine(), which reads the BUILT index.html — never app_template.html, satisfying AC5) -> for
(a) below, the committed movies.json. No mock, no re-derivation of matchesCriteria's rules here or
in matching.py — this is the whole point of the ticket (the old hand-port is what drifted).

Run:  python -m unittest monitor.tests.test_admission   (from the repo root; needs Node on PATH)
"""
import json
import os
import subprocess
import unittest

from monitor.matching import compute_admission

_REPO_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
_MOVIES_PATH = os.path.join(_REPO_ROOT, "movies.json")

_OPEN = {"in_cinema": 0, "rent": 0, "stream": 0}


def _load_movies():
    with open(_MOVIES_PATH, encoding="utf-8") as fh:
        data = json.load(fh)
    return data["movies"] if isinstance(data, dict) else data


def _cascade_scores(tmdb_ids):
    """cascadeScore(), off the same shipped engine admit_shim.mjs uses — the independent check
    (a) below needs, since admission alone doesn't say what score a film cleared."""
    ids = json.dumps([str(i) for i in tmdb_ids])
    script = (
        "import { loadEngine } from './tests/js/engine.mjs';\n"
        "const E = loadEngine();\n"
        f"const ids = new Set({ids});\n"
        "const out = {};\n"
        "for (const m of E.MOVIES) { if (ids.has(String(m.tmdb_id))) out[String(m.tmdb_id)] = E.cascadeScore(m); }\n"
        "process.stdout.write(JSON.stringify(out));\n"
    )
    proc = subprocess.run(["node", "--input-type=module", "-e", script], cwd=_REPO_ROOT,
                          capture_output=True, text=True, timeout=60)
    if proc.returncode != 0:
        raise RuntimeError(f"score probe failed: {proc.stderr}")
    return json.loads(proc.stdout)


class ScoreFloorGate(unittest.TestCase):
    """(a) CAS-724/CAS-727: an agent whose watchMarkers produce a floor of 60 must admit nothing
    scoring below it, and nothing unscored (cascadeScore === -1) — the dominant gate the old
    Python matcher was missing entirely (CAS-825 observation)."""

    def test_no_admitted_film_is_below_the_floor_or_unscored(self):
        movies = _load_movies()
        cascade = {"id": "c-floor", "user_id": "u-floor",
                  "criteria": {"watchMarkers": {"in_cinema": 60, "rent": 60, "stream": 60}}}
        admission = compute_admission([cascade], {"today": movies})
        admitted = admission["c-floor"]["today"]
        self.assertTrue(admitted, "setup: the floor must admit at least one real film to be a test")
        scores = _cascade_scores(admitted)
        for mid in admitted:
            self.assertIn(mid, scores, f"movie {mid} was admitted but not found in MOVIES for scoring")
            self.assertNotEqual(scores[mid], -1, f"movie {mid} has no Cascade score but was admitted")
            self.assertGreaterEqual(scores[mid], 60,
                                    f"movie {mid} scored {scores[mid]}, below the 60 floor")


class RetiredLanguageFilter(unittest.TestCase):
    """(b) CAS-560: the agent-level `criteria.lang` filter is retired — only the account taste
    baseline (tasteBase.langs) gates language now. An agent still carrying a stale `lang` value
    must not have it do anything."""

    def test_agent_lang_field_is_ignored_when_account_taste_base_allows_it(self):
        movie = {"tmdb_id": "999900002", "title": "Foreign Film", "genres": ["Drama"],
                 "age_rating": "M", "language": "fr", "status": ["rental"],
                 "imdb_rating": 7.0, "imdb_votes": 5000, "rt_critic": 70,
                 "offers": [{"service": "AppleTV", "type": "rent", "price": 6.99}]}
        cascade = {"id": "c-lang", "user_id": "u-lang",
                  "criteria": {"lang": ["en"], "watchMarkers": dict(_OPEN)}}
        # [] = every language, filter off (CAS-146) — the account has never narrowed it.
        admission = compute_admission([cascade], {"today": [movie]},
                                      account_prefs={"u-lang": {"langs": []}})
        self.assertIn("999900002", admission["c-lang"]["today"],
                      "criteria.lang narrowed admission, but CAS-560 retired that field")


class PrimaryGenreOnly(unittest.TestCase):
    """(c) genre matching is against the film's PRIMARY genre (genres[0]) only — the app tests
    `(m.genres||[])[0]`, but the old Python matcher tested ANY genre in the list (one of the named
    CAS-825 divergences). A film carrying the wanted genre only as a SECONDARY one must not admit."""

    def test_secondary_genre_does_not_admit(self):
        movie = {"tmdb_id": "999900001", "title": "Secondary Horror", "genres": ["Drama", "Horror"],
                 "age_rating": "M", "language": "en", "status": ["rental"],
                 "imdb_rating": 7.0, "imdb_votes": 5000, "rt_critic": 70,
                 "offers": [{"service": "AppleTV", "type": "rent", "price": 6.99}]}
        cascade = {"id": "c-genre", "user_id": "u-genre",
                  "criteria": {"genre": ["Horror"], "watchMarkers": dict(_OPEN)}}
        admission = compute_admission([cascade], {"today": [movie]})
        self.assertNotIn("999900001", admission["c-genre"]["today"])

    def test_primary_genre_does_admit(self):
        # Control: the same film, Horror moved to primary — proves the exclusion above is really
        # about genre ORDER and not some other field on the fixture.
        movie = {"tmdb_id": "999900003", "title": "Primary Horror", "genres": ["Horror", "Drama"],
                 "age_rating": "M", "language": "en", "status": ["rental"],
                 "imdb_rating": 7.0, "imdb_votes": 5000, "rt_critic": 70,
                 "offers": [{"service": "AppleTV", "type": "rent", "price": 6.99}]}
        cascade = {"id": "c-genre2", "user_id": "u-genre",
                  "criteria": {"genre": ["Horror"], "watchMarkers": dict(_OPEN)}}
        admission = compute_admission([cascade], {"today": [movie]})
        self.assertIn("999900003", admission["c-genre2"]["today"])


class ServiceScopeAuthority(unittest.TestCase):
    """(d) CAS-853 AC4: the account-level "only show films on my services" switch governs admission
    for every agent, not just one that copied it into its own criteria.myServices — an agent with no
    scope of its own must still lose a film that is on none of the user's picked services once the
    account switch is on, and get it back the moment the switch is off."""

    def _stan_only_film(self):
        return {"tmdb_id": "999900853", "title": "Stan-Only Test Film", "genres": ["Drama"],
                "age_rating": "M", "language": "en", "status": ["included_streaming"],
                "imdb_rating": 7.0, "imdb_votes": 5000, "rt_critic": 70,
                "offers": [{"service": "Stan", "type": "sub", "price": None}]}

    def test_excluded_when_services_only_is_on_and_the_service_is_not_picked(self):
        movie = self._stan_only_film()
        cascade = {"id": "c-svc-on", "user_id": "u-svc",
                  "criteria": {"watchMarkers": dict(_OPEN)}}
        admission = compute_admission([cascade], {"today": [movie]},
                                      account_prefs={"u-svc": {"subServices": [], "servicesOnly": True}})
        self.assertNotIn("999900853", admission["c-svc-on"]["today"],
                         "a Stan-only film was admitted to an unscoped agent with the account "
                         "services-only switch on and Stan not among the user's picked services")

    def test_admitted_when_services_only_is_off(self):
        movie = self._stan_only_film()
        cascade = {"id": "c-svc-off", "user_id": "u-svc",
                  "criteria": {"watchMarkers": dict(_OPEN)}}
        admission = compute_admission([cascade], {"today": [movie]},
                                      account_prefs={"u-svc": {"subServices": [], "servicesOnly": False}})
        self.assertIn("999900853", admission["c-svc-off"]["today"],
                      "a Stan-only film was excluded even though the account services-only switch is off")


if __name__ == "__main__":
    unittest.main()
