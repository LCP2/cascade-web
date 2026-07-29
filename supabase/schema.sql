-- Cascade Web — database schema + row-level security
-- Source of truth: Confluence "Cascade Web — Architecture & CC Build Spec" §3.
-- Apply this in the Supabase SQL editor (see supabase/README.md). Safe to re-run.
--
-- Three tables:
--   cascades      — one row per saved agent, per user (the user owns their rows via RLS).
--   user_films    — one row per (user, film) the user has said something about: liked,
--                   so-so, didn't like, or don't-want-to-watch. CAS-183.
--   notifications — the sent-email ledger; the daily monitoring job writes it with the
--                   service_role key (which bypasses RLS) and de-dupes against it so the
--                   same (cascade, movie, moment) is never emailed twice.

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
-- notifications — sent-notification ledger (de-dupe: never email the same
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

alter table public.notifications enable row level security;

-- A user may read their own notification history. There is deliberately no
-- insert/update/delete policy for end users: inserts are done only by the daily
-- job using the service_role key, which bypasses RLS.
drop policy if exists notifications_read_own on public.notifications;
create policy notifications_read_own on public.notifications
  for select using (auth.uid() = user_id);

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
