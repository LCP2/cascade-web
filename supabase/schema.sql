-- Cascade Web — database schema + row-level security
-- Source of truth: Confluence "Cascade Web — Architecture & CC Build Spec" §3.
-- Apply this in the Supabase SQL editor (see supabase/README.md). Safe to re-run.
--
-- Eleven tables:
--   cascades      — one row per saved agent, per user (the user owns their rows via RLS).
--   user_prefs    — the account-level defaults a NEW agent starts from, plus the services the
--                   user actually pays for. CAS-211.
--   user_films    — one row per (user, film) the user has said something about: liked,
--                   so-so, didn't like, or don't-want-to-watch. CAS-183.
--   notify_prefs  — one row per user: how they want to be told, and which alert TYPES they
--                   have muted everywhere. CAS-185.
--   film_picks    — one row per (user, film) the user has hand-added or hand-removed from
--                   their Found list. An "off" here outranks their own Cascade. CAS-185.
--   film_watch    — one row per (user, film) carrying the set of windows the user's per-film
--                   "Watch it" control has ticked. A real, independent notification source —
--                   the daily job fires on it whether or not any agent's own bell is on. CAS-484.
--                   Also carries `sources` — auto/manual per ticked window, mirroring the client's
--                   winsSource, so provenance survives a reload on another device. CAS-726.
--   agent_films   — one row per (user, cascade, film) an agent has admitted: the score/status it
--                   was admitted under and the agent's own signature at that moment. Membership
--                   itself stays derived until CAS-728 makes it sticky against this table; this
--                   table is the storage CAS-727/728 write through. CAS-726.
--   lists         — one row per user-curated collection (name only). Manual, not criteria-driven
--                   — the opposite of a cascade. CAS-428.
--   list_films    — one row per (user, film, list): a film can sit in several lists at once, so
--                   this is a true join table, unlike user_films/film_picks. CAS-428.
--   watchlists    — the Watch screen's own persisted filter record: which services/agents/watched-
--                   verdicts/tiers/sort it's currently scoped to. Shaped like `cascades` (id +
--                   opaque criteria jsonb) on purpose, not `user_prefs`'s one-row-per-user shape, so
--                   CAS-590 can grow this into several named lists with no schema change. CAS-589.
--   notifications — the alert ledger; the daily monitoring job writes it with the
--                   service_role key (which bypasses RLS) and de-dupes against it so the
--                   same (cascade, movie, moment) is never delivered twice. The app reads
--                   its own rows back to fill the 🔔 bell.
--   push_tokens   — one row per (user, device) APNs token, registered on sign-in/re-registration.
--                   The monitor (service_role) reads it to know where to push; the user manages
--                   only their own rows. CAS-464.

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
  -- The WHOLE agent config, as one object the front-end owns end to end: kind (cinema |
  -- stream), the availability windows and their finer watch moments, the bar's four dials,
  -- genres, language, the age list, the year window and the per-window service scope.
  -- Deliberately not a column each (CAS-211): every one of those has changed shape at least
  -- once this release — age went from a lo..hi band to a list, scale from a band index to a
  -- dollar floor — and each change would have been a migration against live rows. The
  -- monitor reads only alert_moments and criteria, and matching.py mirrors the front-end's
  -- own matcher field for field.
  criteria      jsonb not null default '{}'::jsonb,
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
-- user_prefs — account-level defaults and services (CAS-211)
-- ---------------------------------------------------------------------------
-- Two different things live here, and they are different from everything on a
-- cascade row:
--   the SERVICES the user pays for — an account fact, not an agent's opinion. The
--   agent's own per-window scope ("only show me things I can already watch") stays
--   in its criteria; this is the list that scope is measured against.
--   the TASTE DEFAULTS a new agent starts from — genres, how-far-back, languages and
--   the age range. Since CAS-182 every agent carries its OWN copy of those four, so
--   this is a starting point and never a live filter over anyone's agents. Changing
--   it must not silently re-narrow an agent the user already made.
-- `taste` is jsonb for the same reason cascades.criteria is: it is one small object
-- the front-end owns end to end, and a column per dimension would need a migration
-- every time a dimension is added.
create table if not exists public.user_prefs (
  user_id        uuid primary key references auth.users(id) on delete cascade,
  sub_services   text[] not null default '{}',
  store_services text[] not null default '{}',
  services_only  boolean not null default false,
  taste          jsonb not null default '{}'::jsonb,
  updated_at     timestamptz not null default now()
);

-- CAS-561: Where & when you'll watch (Track/Alert per window) was a second CAS-532 "one answer for
-- every agent" setting that, like `taste`, had stayed localStorage-only — added here rather than a new
-- table since it is the same shape (one small object the front-end owns whole), the same owner, and the
-- same debounced upsert path already carries `taste`.
alter table public.user_prefs add column if not exists watch_windows jsonb not null default '{}'::jsonb;

alter table public.user_prefs enable row level security;

drop policy if exists user_prefs_owner on public.user_prefs;
create policy user_prefs_owner on public.user_prefs
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

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
-- film_watch — real per-film "Watch it" alerts (CAS-484)
-- ---------------------------------------------------------------------------
-- One row per (user, film): the set of windows (in_cinema | premium | rent | stream) the user has
-- explicitly ticked on that film's Watch-it control. Its own table, not a column on film_picks —
-- that table's `state` is a CHECK'd 'mine'/'off' with a different meaning ("hide this film from
-- Found"), where this is "tell me when this film reaches X", an independent choice (CAS-434's
-- honesty guardrail: only an explicit tick ever lands a row here, never the agent's own config).
-- The monitor's match_film_watches() (matching.py) reads this as a SECOND, agent-independent
-- source of hits alongside a Cascade's own alert_moments — it fires whether or not any agent's
-- bell for that window is on. A row with an empty `windows` array is deleted rather than kept
-- (mirrors film_picks/user_films: "no ticks" is the absence of a row, not a row saying so).
create table if not exists public.film_watch (
  user_id    uuid not null references auth.users(id) on delete cascade,
  movie_id   text not null,
  windows    text[] not null default '{}',
  updated_at timestamptz not null default now(),
  primary key (user_id, movie_id)
);

alter table public.film_watch enable row level security;

drop policy if exists film_watch_owner on public.film_watch;
create policy film_watch_owner on public.film_watch
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- CAS-726: window key -> "auto" | "manual", mirroring the client's winsSource — which of `windows`
-- an agent armed vs the account holder ticked by hand. A window absent here reads as source-unknown
-- (no colour, no overwrite protection), exactly today's behaviour, until the user next sets it —
-- so an old row migrates for free with the column's own default.
alter table public.film_watch add column if not exists sources jsonb not null default '{}'::jsonb;

-- ---------------------------------------------------------------------------
-- agent_films — the admitted set, per agent (CAS-726)
-- ---------------------------------------------------------------------------
-- One row per (user, cascade, film) a cascade has admitted. Membership stays derived (recomputeFound)
-- until CAS-728 makes it sticky by reading/writing this table; this ticket only adds the storage and
-- the app's read/write paths. `agent_sig` is the cascSigOf(c) value in force when the row was written
-- — the re-evaluation ticket compares it to the agent's CURRENT signature to know whether the row
-- still reflects the agent's settings. A row with nothing to say (the film left the agent) is deleted
-- rather than kept, same convention as film_picks/user_films/film_watch.
create table if not exists public.agent_films (
  user_id          uuid not null references auth.users(id) on delete cascade,
  cascade_id       uuid not null references public.cascades(id) on delete cascade,
  movie_id         text not null,
  admitted_at      timestamptz not null default now(),
  admission_score  int not null,
  admission_status text not null,
  agent_sig        text not null,
  primary key (user_id, cascade_id, movie_id)
);

alter table public.agent_films enable row level security;

drop policy if exists agent_films_owner on public.agent_films;
create policy agent_films_owner on public.agent_films
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

create index if not exists agent_films_cascade_id_idx on public.agent_films (cascade_id);

-- ---------------------------------------------------------------------------
-- lists — a user's own hand-picked collections (CAS-428)
-- ---------------------------------------------------------------------------
-- Same small-row-per-item shape as cascades, but deliberately not jsonb: a list is just a name,
-- with none of the shape-changes-every-release history that criteria has, so a plain column stays
-- honest instead of anticipating a flexibility this table has never needed.
create table if not exists public.lists (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users(id) on delete cascade,
  name       text not null default 'My list',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.lists enable row level security;

drop policy if exists lists_owner on public.lists;
create policy lists_owner on public.lists
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

create index if not exists lists_user_id_idx on public.lists (user_id);

-- ---------------------------------------------------------------------------
-- list_films — film <-> list membership (CAS-428)
-- ---------------------------------------------------------------------------
-- One row per (user, film, list) — a genuine join table, unlike user_films/film_picks, whose one
-- row per (user, film) encodes a single mutually-exclusive answer. A film can be in several lists
-- at once, so the primary key has to include list_id. list_id cascades on delete so removing a
-- list from `lists` cleans up its memberships for free, matching what the client's removeList()
-- already does to its own local `listMembership` object.
create table if not exists public.list_films (
  user_id    uuid not null references auth.users(id) on delete cascade,
  movie_id   text not null,
  list_id    uuid not null references public.lists(id) on delete cascade,
  updated_at timestamptz not null default now(),
  primary key (user_id, movie_id, list_id)
);

alter table public.list_films enable row level security;

drop policy if exists list_films_owner on public.list_films;
create policy list_films_owner on public.list_films
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

create index if not exists list_films_list_id_idx on public.list_films (list_id);

-- ---------------------------------------------------------------------------
-- watchlists — the Watch screen's own persisted filter record (CAS-589)
-- ---------------------------------------------------------------------------
-- Shaped exactly like `cascades` — a thin id/user_id pair plus an opaque `criteria` jsonb blob —
-- rather than `user_prefs`'s single-row-per-user shape, even though the app upserts only one row
-- per user today. That is deliberate: CAS-590 (multiple named watch lists) turns this into a real
-- array of rows with no further schema change, the same way a new cascade field never needs a
-- migration because criteria is opaque to the database.
create table if not exists public.watchlists (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users(id) on delete cascade,
  -- svcOn / cascOff / watchedOn / watchTiers / sort — the five fields the Watch screen's filters
  -- keep between visits (CAS-589). cascOff is the COMPLEMENT — ids explicitly unticked — so a newly
  -- created agent is included by default without this row needing to know about it.
  criteria   jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.watchlists enable row level security;

drop policy if exists watchlists_owner on public.watchlists;
create policy watchlists_owner on public.watchlists
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

create index if not exists watchlists_user_id_idx on public.watchlists (user_id);

-- CAS-692: a deletion is a positive, replicated fact — a device deletes a list by setting deleted_at
-- rather than removing the row, so an offline device that hasn't seen the deletion can't read an absent
-- row as "never existed" and silently resurrect it. Rows are never hard-deleted by a client; a row
-- tombstoned for more than 90 days MAY be hard-deleted by a maintenance step, never by client code.
alter table public.watchlists add column if not exists deleted_at timestamptz;
create index if not exists watchlists_deleted_at_idx on public.watchlists (deleted_at);

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
-- push_tokens — one row per (user, device) APNs token (CAS-464)
-- ---------------------------------------------------------------------------
-- Registered by CAS-463's sign-in/re-registration flow, read by the monitor (CAS-465) to
-- know who/where to push. platform is constrained to 'ios' because that is the only app
-- shell this repo builds today (CAS-453); widen the check when a second platform ships.
-- unique(user_id, device_token) doubles as the user_id lookup index, same reasoning as
-- user_films above, so no separate index is added.
create table if not exists public.push_tokens (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users(id) on delete cascade,
  device_token  text not null,
  platform      text not null default 'ios' check (platform in ('ios')),
  app_version   text,
  created_at    timestamptz not null default now(),
  last_seen_at  timestamptz not null default now(),
  unique (user_id, device_token)
);

alter table public.push_tokens enable row level security;

-- A user can read and write only their own tokens (insert/update/delete on sign-in,
-- sign-out, re-registration). The monitor's service_role key bypasses RLS for delivery
-- reads, same convention as notifications — no separate policy needed for it.
drop policy if exists push_tokens_owner on public.push_tokens;
create policy push_tokens_owner on public.push_tokens
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

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

drop trigger if exists film_watch_set_updated_at on public.film_watch;
create trigger film_watch_set_updated_at
  before update on public.film_watch
  for each row execute function public.set_updated_at();

drop trigger if exists user_prefs_set_updated_at on public.user_prefs;
create trigger user_prefs_set_updated_at
  before update on public.user_prefs
  for each row execute function public.set_updated_at();

drop trigger if exists lists_set_updated_at on public.lists;
create trigger lists_set_updated_at
  before update on public.lists
  for each row execute function public.set_updated_at();

drop trigger if exists list_films_set_updated_at on public.list_films;
create trigger list_films_set_updated_at
  before update on public.list_films
  for each row execute function public.set_updated_at();

drop trigger if exists watchlists_set_updated_at on public.watchlists;
create trigger watchlists_set_updated_at
  before update on public.watchlists
  for each row execute function public.set_updated_at();
