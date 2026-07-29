-- Cascade Web — database schema + row-level security
-- Source of truth: Confluence "Cascade Web — Architecture & CC Build Spec" §3.
-- Apply this in the Supabase SQL editor (see supabase/README.md). Safe to re-run.
--
-- Five tables:
--   cascades      — one row per saved agent, per user (the user owns their rows via RLS).
--   user_films    — one row per (user, film) the user has said something about: liked,
--                   so-so, didn't like, or don't-want-to-watch. CAS-183.
--   notify_prefs  — one row per user: how they want to be told, and which alert TYPES they
--                   have muted everywhere. CAS-185.
--   film_picks    — one row per (user, film) the user has hand-added or hand-removed from
--                   their Found list. An "off" here outranks their own Cascade. CAS-185.
--   notifications — the alert ledger; the daily monitoring job writes it with the
--                   service_role key (which bypasses RLS) and de-dupes against it so the
--                   same (cascade, movie, moment) is never delivered twice. The app reads
--                   its own rows back to fill the 🔔 bell.

-- gen_random_uuid() lives in pgcrypto. It is pre-installed on Supabase, but declaring the
-- dependency keeps this file self-contained and portable to a plain Postgres.
create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------------
-- cascades — one row per saved agent, per user
-- ---------------------------------------------------------------------------
create table if not exists public.cascades (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users(id) on delete cascade,
  name          text not null default 'My agent',
  criteria      jsonb not null default '{}'::jsonb,   -- {genres:[], minRating, services:[], maxPrice, ageMax, ...}
  alert_moments text[] not null default '{hits_rent,hits_stream}',
                 -- subset of: hits_cinema | past_opening_weekend | hits_pvod | hits_rent | hits_stream
                 -- hits_pvod added by CAS-103 (the editor's Purchase bell). No migration is needed:
                 -- the column is an unconstrained text[], so existing rows stay valid and simply
                 -- never carry the new value until the user switches Purchase on.
  active        boolean not null default true,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

alter table public.cascades enable row level security;

-- A user can read and write only their own cascades.
drop policy if exists cascades_owner on public.cascades;
create policy cascades_owner on public.cascades
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- The monitoring job pulls active cascades grouped by user; index the hot columns.
create index if not exists cascades_user_id_idx on public.cascades (user_id);
create index if not exists cascades_active_idx  on public.cascades (active) where active;

-- ---------------------------------------------------------------------------
-- user_films — what the user has said about a film (CAS-183)
-- ---------------------------------------------------------------------------
-- One row per (user, film), not one per answer: the four statuses are mutually
-- exclusive by definition — you cannot have both liked and disliked the same film —
-- so the primary key enforces that rather than the application remembering to.
-- Clearing an answer DELETES the row; "no opinion" is the absence of a row, which is
-- also what makes the local sets and this table the same shape.
-- movie_id is text to match notifications.movie_id (TMDB ids arrive as numbers from the
-- catalogue and as strings from the monitor; one type across both tables, always).
create table if not exists public.user_films (
  user_id    uuid not null references auth.users(id) on delete cascade,
  movie_id   text not null,
  status     text not null check (status in ('liked','soso','disliked','notfor')),
  updated_at timestamptz not null default now(),
  primary key (user_id, movie_id)
);

alter table public.user_films enable row level security;

-- A user can read and write only their own rows.
drop policy if exists user_films_owner on public.user_films;
create policy user_films_owner on public.user_films
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- The app loads a user's whole set on sign-in; the primary key already indexes user_id
-- first, so no extra index is needed.

-- ---------------------------------------------------------------------------
-- notify_prefs — how a user wants to be told (CAS-185)
-- ---------------------------------------------------------------------------
-- One row per user, so "how do you want to hear from us" is asked and answered once
-- rather than per agent. `email_address` is deliberately its own column and NOT assumed
-- to be auth.users.email: a person can sign in with one address and want alerts at
-- another, and the monitor must never guess which. Null means "use the account address".
-- `excluded_moments` is the global mute (CAS-103 AC4) — an alert TYPE switched off here
-- outranks every one of that user's Cascades.
create table if not exists public.notify_prefs (
  user_id          uuid primary key references auth.users(id) on delete cascade,
  in_app           boolean not null default true,
  email_on         boolean not null default false,
  email_address    text,
  excluded_moments text[] not null default '{}',
  updated_at       timestamptz not null default now()
);

alter table public.notify_prefs enable row level security;

drop policy if exists notify_prefs_owner on public.notify_prefs;
create policy notify_prefs_owner on public.notify_prefs
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- ---------------------------------------------------------------------------
-- film_picks — the personal override on a Found list (CAS-100, stored CAS-185)
-- ---------------------------------------------------------------------------
-- 'mine' = the user added this film by hand; 'off' = they took it off, and it stays off.
-- The monitor reads the 'off' rows and says nothing about those films, every run, until
-- the user changes their mind: your answer outranks your own Cascade. Held on the device
-- until now, which is why the monitor's --picks flag had no Supabase default.
create table if not exists public.film_picks (
  user_id    uuid not null references auth.users(id) on delete cascade,
  movie_id   text not null,
  state      text not null check (state in ('mine','off')),
  updated_at timestamptz not null default now(),
  primary key (user_id, movie_id)
);

alter table public.film_picks enable row level security;

drop policy if exists film_picks_owner on public.film_picks;
create policy film_picks_owner on public.film_picks
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- ---------------------------------------------------------------------------
-- notifications — the alert ledger (de-dupe: never email the same
-- movie+moment twice per cascade)
-- ---------------------------------------------------------------------------
create table if not exists public.notifications (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  cascade_id  uuid references public.cascades(id) on delete cascade,
  movie_id    text not null,
  moment      text not null,
  emailed_at  timestamptz not null default now(),
  unique (cascade_id, movie_id, moment)
);

-- CAS-185: the ledger is now the IN-APP delivery as well as the email de-dupe, so it
-- carries what the bell needs to draw a row without re-deriving it from the catalogue —
-- and `read_at` so an unread badge means something. Both columns are added rather than
-- assumed, so this file stays safe to re-run against a database that predates them.
alter table public.notifications add column if not exists cascade_name text;
alter table public.notifications add column if not exists title text;
alter table public.notifications add column if not exists read_at timestamptz;

alter table public.notifications enable row level security;

-- A user may read their own notification history, and mark it read. There is deliberately
-- no insert or delete policy for end users: inserts are done only by the daily job using
-- the service_role key, which bypasses RLS.
drop policy if exists notifications_read_own on public.notifications;
create policy notifications_read_own on public.notifications
  for select using (auth.uid() = user_id);

drop policy if exists notifications_mark_read on public.notifications;
create policy notifications_mark_read on public.notifications
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- The de-dupe check filters by user; the unique() above already indexes
-- (cascade_id, movie_id, moment).
create index if not exists notifications_user_id_idx on public.notifications (user_id);

-- ---------------------------------------------------------------------------
-- keep cascades.updated_at honest on every write
-- ---------------------------------------------------------------------------
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists cascades_set_updated_at on public.cascades;
create trigger cascades_set_updated_at
  before update on public.cascades
  for each row execute function public.set_updated_at();

drop trigger if exists user_films_set_updated_at on public.user_films;
create trigger user_films_set_updated_at
  before update on public.user_films
  for each row execute function public.set_updated_at();

drop trigger if exists notify_prefs_set_updated_at on public.notify_prefs;
create trigger notify_prefs_set_updated_at
  before update on public.notify_prefs
  for each row execute function public.set_updated_at();

drop trigger if exists film_picks_set_updated_at on public.film_picks;
create trigger film_picks_set_updated_at
  before update on public.film_picks
  for each row execute function public.set_updated_at();
