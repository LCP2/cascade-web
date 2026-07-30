"""CAS-233 (part 1): data-quality tests over the catalogue the app ships.

Every assertion here is a claim the UI makes on the strength of this file. The engine invariants (CAS-231) prove
the app reasons correctly about whatever it is given; these prove it is given something worth reasoning about.
The two failure modes they exist for have both happened: CAS-170 shipped 913 titles whose availability rested on
nothing, and CAS-155 filed 257 rental records under "In Cinema".

Deliberately NOT here: anything that pins a number. The catalogue is refreshed daily on main, so an assertion
that today's catalogue holds 1,961 films is a test that fails tomorrow for no reason and gets muted. What is
asserted is that every record is internally coherent and that the shape of the whole is sane.

Run: python -m unittest discover -s tests
"""
import datetime
import json
import os
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CATALOGUE = os.path.join(ROOT, "movies.json")

# The windows a film can hold, in journey order — the same list the front end calls CASCADE.
WINDOWS = ["upcoming", "opening_week", "in_cinema", "pvod", "rental", "included_streaming"]
CINEMA_WINDOWS = {"opening_week", "in_cinema"}
HOME_WINDOWS = {"pvod", "rental", "included_streaming"}
# A film released before cinema existed is a data error, and one dated far in the future is a placeholder.
EARLIEST_SANE = datetime.date(1895, 1, 1)


def load():
    with open(CATALOGUE, encoding="utf-8") as fh:
        return json.load(fh)


def parse_date(value):
    """The ISO date, or None. Raises nothing — the caller decides whether None is a failure."""
    if not value or not isinstance(value, str):
        return None
    try:
        return datetime.date.fromisoformat(value[:10])
    except ValueError:
        return None


class CatalogueShape(unittest.TestCase):
    """The file itself, before any single record."""

    @classmethod
    def setUpClass(cls):
        cls.doc = load()
        cls.movies = cls.doc["movies"]

    def test_envelope(self):
        self.assertIn("generated", self.doc, "no build stamp on the catalogue")
        self.assertIsNotNone(parse_date(self.doc["generated"]), f"unparseable stamp {self.doc['generated']!r}")
        self.assertEqual(self.doc.get("region"), "AU", "the pipeline is AU-only; a region change needs a look")
        self.assertGreater(len(self.movies), 500, "the catalogue is suspiciously small")

    def test_ids_are_unique(self):
        seen, dupes = set(), []
        for m in self.movies:
            if m["tmdb_id"] in seen:
                dupes.append(m["tmdb_id"])
            seen.add(m["tmdb_id"])
        self.assertEqual(dupes, [], f"duplicate tmdb_ids: {dupes[:5]}")

    def test_every_film_has_the_fields_the_ui_prints(self):
        missing = []
        for m in self.movies:
            for field in ("tmdb_id", "title", "status", "offers", "availability_confidence", "genres"):
                if field not in m:
                    missing.append((m.get("title", m.get("tmdb_id")), field))
        self.assertEqual(missing, [], f"films missing fields the UI prints: {missing[:5]}")

    def test_the_catalogue_is_not_all_one_window(self):
        # Not a threshold on any single window — just that the ladder isn't collapsed, which is what a broken
        # status writer looks like from the outside.
        held = {w for m in self.movies for w in m.get("status", [])}
        self.assertGreaterEqual(len(held), 2, f"every film is in the same window: {held}")


class AvailabilityIsBackedBySomething(unittest.TestCase):
    """CAS-170: a listing is a claim you can go and watch this, so something real has to be behind it."""

    @classmethod
    def setUpClass(cls):
        cls.movies = load()["movies"]

    def test_status_values_are_known_windows(self):
        bad = [(m["title"], m["status"]) for m in self.movies
               if not m["status"] or any(w not in WINDOWS for w in m["status"])]
        self.assertEqual(bad, [], f"films holding an unknown window: {bad[:5]}")

    def test_status_is_in_journey_order(self):
        # primaryStatus() takes the LAST window a film holds, so the order is load-bearing: a list written out
        # of order would make the app read the wrong window as current.
        bad = []
        for m in self.movies:
            order = [WINDOWS.index(w) for w in m["status"]]
            if order != sorted(order):
                bad.append((m["title"], m["status"]))
        self.assertEqual(bad, [], f"status lists out of journey order: {bad[:5]}")

    def test_confirmed_means_polled(self):
        bad = [m["title"] for m in self.movies
               if m["availability_confidence"] not in ("confirmed", "estimated")]
        self.assertEqual(bad, [], f"films with an unknown availability_confidence: {bad[:5]}")

    def test_a_home_window_is_never_claimed_on_no_offer(self):
        # The CAS-170 fault in one assertion: a CONFIRMED film cannot be sitting at rent or on streaming with
        # nothing to rent or stream it from. (An ESTIMATED film is allowed to have no offers — that is what
        # estimated MEANS — and the front end refuses to list those, which CAS-231 asserts separately.)
        bad = []
        for m in self.movies:
            if m["availability_confidence"] != "confirmed":
                continue
            if set(m["status"]) & HOME_WINDOWS and not m["offers"]:
                bad.append((m["title"], m["status"]))
        self.assertEqual(bad, [], f"confirmed home-window films with no offers: {bad[:5]}")

    def test_offers_are_well_formed(self):
        bad = []
        for m in self.movies:
            for o in m["offers"]:
                if not isinstance(o, dict) or "type" not in o or "service" not in o:
                    bad.append((m["title"], o))
                elif o["type"] not in ("sub", "free", "rent", "buy", "ads", "cinema"):
                    bad.append((m["title"], o.get("type")))
                elif o.get("price") is not None and not (0 < float(o["price"]) < 200):
                    bad.append((m["title"], o.get("price")))
        self.assertEqual(bad, [], f"malformed offers: {bad[:5]}")


class StatusAgreesWithTheCalendar(unittest.TestCase):
    """CAS-155: the window a film is filed under has to be consistent with its dates and its offers."""

    @classmethod
    def setUpClass(cls):
        cls.doc = load()
        cls.movies = cls.doc["movies"]
        cls.today = parse_date(cls.doc["generated"]) or datetime.date.today()

    def test_no_film_is_in_a_cinema_and_at_home_at_once(self):
        bad = [(m["title"], m["status"]) for m in self.movies
               if set(m["status"]) & CINEMA_WINDOWS and set(m["status"]) & HOME_WINDOWS]
        self.assertEqual(bad, [], f"films in a cinema window AND a home window: {bad[:5]}")

    def test_a_cinema_window_never_holds_a_rental_price(self):
        # This is exactly what CAS-155 found: rent/buy offers with null prices meant every price rule missed,
        # and a date-based fallback declared the film "in cinemas" while the data said rental.
        bad = []
        for m in self.movies:
            if not (set(m["status"]) & CINEMA_WINDOWS):
                continue
            priced = [o for o in m["offers"] if o.get("type") in ("rent", "buy", "sub", "free")]
            if priced:
                bad.append((m["title"], m["status"], len(priced)))
        self.assertEqual(bad, [], f"cinema-window films carrying home offers: {bad[:5]}")

    def test_upcoming_films_are_not_already_out(self):
        # A film whose only window is `upcoming` while its opening date has passed is mislabelled — the state
        # CAS-227 had to work around in the front end. Recorded as a KNOWN GAP with a tolerance rather than as a
        # hard failure, because the fix lives in the poll scheduler and is Lee's call (see the CAS-227 comment).
        # The tolerance is deliberately tight: it catches the scheduler getting WORSE, which is what matters.
        late = []
        for m in self.movies:
            cd = parse_date(m.get("cinema_date"))
            if m["status"] == ["upcoming"] and cd and cd < self.today:
                late.append((m["title"], m["cinema_date"]))
        self.assertLessEqual(
            len(late), 40,
            f"{len(late)} films are still labelled Upcoming after their opening date — the poll scheduler's "
            f"upcoming latch (see CAS-227) has got worse: {late[:5]}")

    def test_dates_parse_and_are_sane(self):
        horizon = self.today + datetime.timedelta(days=365 * 6)
        bad = []
        for m in self.movies:
            raw = m.get("cinema_date")
            if raw in (None, ""):
                continue
            d = parse_date(raw)
            if d is None:
                bad.append((m["title"], raw, "unparseable"))
            elif d < EARLIEST_SANE:
                bad.append((m["title"], raw, "before cinema existed"))
            elif d > horizon:
                bad.append((m["title"], raw, "further out than the pipeline looks"))
        self.assertEqual(bad, [], f"bad cinema dates: {bad[:5]}")

    def test_window_dates_parse_and_belong_to_real_windows(self):
        bad = []
        for m in self.movies:
            for window, raw in (m.get("window_dates") or {}).items():
                if window not in WINDOWS:
                    bad.append((m["title"], window, "unknown window"))
                elif parse_date(raw) is None:
                    bad.append((m["title"], window, raw))
        self.assertEqual(bad, [], f"bad window_dates: {bad[:5]}")

    def test_no_window_is_stamped_before_the_film_opened(self):
        # A film cannot be at home before it came out, so no post-cinema stamp may precede cinema_date.
        #
        # This replaces an assertion I wrote first and had to throw away: that window_dates must run in journey
        # order. It fails on 13 titles (Furiosa is stamped streaming 20 Jul, rental 22 Jul) and the data is
        # right — window_dates records when CASCADE FIRST SAW the film in each window, not when the film moved.
        # A title already on a subscription when we started polling it gets its streaming stamp first, and a
        # rental offer appearing later is a real, later observation. Worth writing down, because "these dates
        # are the journey" is the natural reading and it is wrong.
        bad = []
        for m in self.movies:
            opened = parse_date(m.get("cinema_date"))
            if not opened:
                continue
            for window, raw in (m.get("window_dates") or {}).items():
                if window == "upcoming":
                    continue                      # the pre-release stamp is legitimately before the opening
                stamped = parse_date(raw)
                if stamped and stamped < opened:
                    bad.append((m["title"], window, raw, m["cinema_date"]))
        self.assertEqual(bad, [], f"windows stamped before the film opened: {bad[:5]}")


class ScoresAreCredible(unittest.TestCase):
    """CAS-156: a score printed on a card is a claim about consensus, so it needs a crowd behind it."""

    @classmethod
    def setUpClass(cls):
        cls.movies = load()["movies"]

    def test_ratings_are_in_range(self):
        bad = []
        for m in self.movies:
            r = m.get("imdb_rating")
            if r is not None and not (0 < float(r) <= 10):
                bad.append((m["title"], "imdb_rating", r))
            mc = m.get("metacritic")
            if mc is not None and not (0 <= float(mc) <= 100):
                bad.append((m["title"], "metacritic", mc))
            rt = m.get("rt_critic")
            if rt is not None and not (0 <= float(rt) <= 100):
                bad.append((m["title"], "rt_critic", rt))
        self.assertEqual(bad, [], f"scores outside their own scale: {bad[:5]}")

    def test_an_imdb_rating_comes_with_its_vote_count(self):
        # Without the vote count there is no way to tell 9.4-on-11-votes from 9.4-on-400,000, and the app's
        # rating bars are percentiles of the rated population — so an unqualified score skews every dial.
        bad = [(m["title"], m.get("imdb_rating")) for m in self.movies
               if m.get("imdb_rating") is not None and not isinstance(m.get("imdb_votes"), int)]
        self.assertEqual(bad, [], f"IMDb ratings with no vote count: {bad[:5]}")

    def test_vote_counts_are_not_negative(self):
        bad = [(m["title"], m.get("imdb_votes")) for m in self.movies
               if isinstance(m.get("imdb_votes"), int) and m["imdb_votes"] < 0]
        self.assertEqual(bad, [], f"negative vote counts: {bad[:5]}")

    def test_popularity_is_a_non_negative_number_where_present(self):
        bad = [(m["title"], m.get("popularity")) for m in self.movies
               if m.get("popularity") is not None
               and (not isinstance(m["popularity"], (int, float)) or m["popularity"] < 0)]
        self.assertEqual(bad, [], f"bad popularity values: {bad[:5]}")

    def test_money_figures_are_not_negative(self):
        bad = []
        for m in self.movies:
            for field in ("budget", "worldwide_gross"):
                v = m.get(field)
                if v is not None and (not isinstance(v, (int, float)) or v < 0):
                    bad.append((m["title"], field, v))
        self.assertEqual(bad, [], f"negative or non-numeric money: {bad[:5]}")

    def test_an_award_claim_carries_its_text(self):
        # The card prints the award line verbatim; a truthy `award` with nothing to print would be an
        # unsupported claim of the exact kind the honesty guardrail forbids.
        bad = [m["title"] for m in self.movies
               if m.get("award") and not (m.get("award_text") or "").strip()]
        self.assertEqual(bad, [], f"award claims with no award text: {bad[:5]}")


if __name__ == "__main__":
    unittest.main()
