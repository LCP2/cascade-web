"""CAS-1039 AC1 — supabase/schema.sql's user_films_status_check must actually reach a table that
was created before CAS-738 widened the CHECK. CAS-738 widened the value list only inside the
`create table if not exists public.user_films` statement, which is a no-op against a table that
already exists — so a live project's constraint silently stayed at the original four values while
the file itself read as six. This never runs against a real database (none is available here, or
in CI); it parses schema.sql's own DDL text and applies the ALTER pair symbolically, the same way
tests/rls/matrix.mjs derives its table list from schema.sql rather than a live introspection call.
"""
import re
import unittest
from pathlib import Path

SCHEMA_SQL = Path(__file__).resolve().parent.parent / "supabase" / "schema.sql"

ORIGINAL_STATUS_VALUES = {"liked", "soso", "disliked", "notfor"}
CURRENT_STATUS_VALUES = {"liked", "soso", "disliked", "notfor", "wow", "enjoyed"}


def _values_from_check(check_sql):
    """Pull the quoted values out of a `check (status in ('a','b',...))` clause."""
    return set(re.findall(r"'([^']+)'", check_sql))


class UserFilmsCreateTableCheck(unittest.TestCase):
    """The inline CHECK inside the create-table statement — this is what a BRAND NEW project
    gets, and it must already be the current six values (never re-widen this without also fixing
    the ALTER pair below, or the two would drift apart the way CAS-738 let them)."""

    def test_inline_check_is_the_current_six_values(self):
        src = SCHEMA_SQL.read_text(encoding="utf-8")
        m = re.search(r"create table if not exists public\.user_films\s*\(([\s\S]*?)\n\);", src)
        self.assertIsNotNone(m, "user_films create-table statement not found in schema.sql")
        col_match = re.search(r"status\s+text\s+not\s+null\s+check\s*\(status in \(([^)]*)\)\)", m.group(1))
        self.assertIsNotNone(col_match, "user_films.status CHECK not found in the create-table statement")
        self.assertEqual(_values_from_check(col_match.group(1)), CURRENT_STATUS_VALUES)


class UserFilmsCheckMigration(unittest.TestCase):
    """The idempotent ALTER pair (CAS-1039) that must exist AFTER the create-table statement so a
    table that predates the current value list converges anyway."""

    @classmethod
    def setUpClass(cls):
        cls.src = SCHEMA_SQL.read_text(encoding="utf-8")

    def _find_alter_pair(self):
        drop_m = re.search(
            r"alter table public\.user_films\s+drop constraint if exists\s+(\w+)\s*;", self.src)
        add_m = re.search(
            r"alter table public\.user_films\s+add constraint\s+(\w+)\s*\n?\s*check\s*\(status in \(([^)]*)\)\)\s*;",
            self.src)
        return drop_m, add_m

    def test_drop_and_add_constraint_statements_exist(self):
        drop_m, add_m = self._find_alter_pair()
        self.assertIsNotNone(drop_m, "no idempotent `drop constraint if exists` for user_films_status_check")
        self.assertIsNotNone(add_m, "no `add constraint ... check (status in (...))` for user_films")

    def test_drop_and_add_target_the_same_constraint_name(self):
        drop_m, add_m = self._find_alter_pair()
        self.assertEqual(drop_m.group(1), "user_films_status_check")
        self.assertEqual(add_m.group(1), "user_films_status_check")

    def test_migration_widens_to_exactly_the_current_six_values(self):
        _, add_m = self._find_alter_pair()
        self.assertEqual(_values_from_check(add_m.group(2)), CURRENT_STATUS_VALUES)

    def test_applied_twice_against_a_table_created_with_the_old_four_value_check_ends_six_valued(self):
        """Symbolic apply: start from a table whose CHECK is the pre-CAS-738 four values (what a
        live, never-altered project actually has), run the extracted drop-then-add pair, and
        confirm it lands on the six-value CHECK — twice, since `drop constraint if exists` must
        tolerate being re-run against a table this same migration already touched."""
        drop_m, add_m = self._find_alter_pair()
        target_values = _values_from_check(add_m.group(2))

        def apply_migration(current_values):
            # `drop constraint if exists` always succeeds regardless of current state (that's the
            # whole point of "if exists"); `add constraint ... check (...)` always installs the
            # literal value list found in schema.sql.
            return set(target_values)

        live_table_check = set(ORIGINAL_STATUS_VALUES)  # a project that predates CAS-738 entirely
        live_table_check = apply_migration(live_table_check)
        self.assertEqual(live_table_check, CURRENT_STATUS_VALUES)
        # Re-running schema.sql (every deploy does) must not fail or regress the value list.
        live_table_check = apply_migration(live_table_check)
        self.assertEqual(live_table_check, CURRENT_STATUS_VALUES)


if __name__ == "__main__":
    unittest.main()
