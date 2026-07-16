# Supabase backend — Cascade Web

This folder holds the database schema for the live, account-based Cascade service.
It is the backend surface the browser talks to (Auth + two tables), plus the ledger
the daily monitoring job writes.

- **`schema.sql`** — the `cascades` and `notifications` tables, with **row-level
  security (RLS)** so each user can only read/write their own rows.

> The full one-time account setup (create the Supabase project, enable magic-link
> auth, create Resend, add the GitHub Actions secrets, fill `config.js`) lives in
> **`SETUP-cascade-web.md`**. This file covers just the database step.

## What the schema creates

| Object | Purpose |
| --- | --- |
| `public.cascades` | One row per saved agent, per user. `criteria` (jsonb) holds the filter (genres, minRating, services, maxPrice, ageMax…); `alert_moments` (text[]) is the subset of `hits_cinema \| past_opening_weekend \| hits_rent \| hits_stream` the agent should fire on. |
| `public.notifications` | The sent-email ledger. The daily job writes it and de-dupes against it so the same `(cascade, movie, moment)` is never emailed twice. |

**Row-level security**

- `cascades` — RLS on; policy `cascades_owner` gives a user full access to *only*
  their own rows (`auth.uid() = user_id`). No user can see another account's agents.
- `notifications` — RLS on; policy `notifications_read_own` lets a user read *only*
  their own history. There is **no** end-user insert policy on purpose: the daily
  monitoring job is the only writer, using the **`service_role`** key (which bypasses
  RLS). The browser never writes this table.

## How to apply it (Lee — one time, ~1 minute)

1. Open your Supabase project → **SQL Editor** → **New query**.
2. Paste the entire contents of [`schema.sql`](./schema.sql) and click **Run**.
3. Confirm under **Table Editor** that `cascades` and `notifications` exist, and under
   **Authentication → Policies** that each table shows RLS **enabled** with its policy.

The script is **idempotent** — safe to run again after a later schema change; it uses
`create … if not exists` and re-creates policies/trigger cleanly, so re-running won't
error or duplicate anything.

> ⚠️ Run this in **your own Supabase project's** SQL editor only. CC (the build agent)
> never runs SQL against a live project — it validates the file offline against the
> PostgreSQL grammar (`pglast`).

## Notes

- `gen_random_uuid()` comes from the `pgcrypto` extension (pre-installed on Supabase;
  the script enables it defensively so the file also works on a plain Postgres).
- `updated_at` on `cascades` is kept current automatically by the `cascades_set_updated_at`
  trigger, so the app never has to set it by hand.
- Deleting a user (`auth.users`) cascades to their `cascades` and `notifications`
  (`on delete cascade`); deleting a cascade cascades to its notifications.
