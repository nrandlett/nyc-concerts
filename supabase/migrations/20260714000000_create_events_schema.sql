-- Migration: create the artists, events, and event_artists tables.
-- Run this in the Supabase SQL Editor (or via the Supabase CLI).
--
-- This builds on the venues table from the previous migration. Events reference
-- venues via a foreign key, and events/artists are linked many-to-many through
-- the event_artists join table.
--
-- Conventions match the venues migration: uuid primary keys, created_at/
-- updated_at timestamps, a reused set_updated_at() trigger, and RLS with a
-- single public-read (SELECT) policy so the anon key can read but never write.

-- gen_random_uuid() lives in pgcrypto. Already enabled by the venues migration,
-- but harmless to assert again.
create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------------
-- artists
-- ---------------------------------------------------------------------------
-- One row per performer ("attraction" in Ticketmaster's vocabulary). We upsert
-- on ticketmaster_id, so it is unique. It is nullable to leave room for artists
-- we later add from non-Ticketmaster sources.
create table if not exists public.artists (
  id              uuid primary key default gen_random_uuid(),
  name            text not null,
  ticketmaster_id text unique,
  url             text,
  genre           text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- events
-- ---------------------------------------------------------------------------
-- One row per concert. venue_id is a foreign key into venues; deleting a venue
-- removes its events (on delete cascade). We upsert on ticketmaster_id.
--
-- Date handling: Ticketmaster always gives a calendar date (local_date) but not
-- always a precise start time. When it provides a full timestamp we store it in
-- starts_at; local_time keeps the raw "HH:MM:SS" string when only that is known.
create table if not exists public.events (
  id              uuid primary key default gen_random_uuid(),
  ticketmaster_id text not null unique,
  name            text not null,
  venue_id        uuid not null references public.venues (id) on delete cascade,
  starts_at       timestamptz,
  local_date      date not null,
  local_time      text,
  status          text,
  url             text,
  price_min       numeric,
  price_max       numeric,
  price_currency  text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

-- Listing queries filter by venue and by date, so index both.
create index if not exists events_venue_id_idx   on public.events (venue_id);
create index if not exists events_local_date_idx on public.events (local_date);

-- ---------------------------------------------------------------------------
-- event_artists (join table)
-- ---------------------------------------------------------------------------
-- Resolves the many-to-many relationship between events and artists. Each row
-- is one "artist performs at event" pairing. The composite primary key prevents
-- duplicate links and is the conflict target our ingestion upserts on.
-- billing_order preserves lineup order: 0 = headliner, 1+ = support acts.
create table if not exists public.event_artists (
  event_id      uuid not null references public.events (id) on delete cascade,
  artist_id     uuid not null references public.artists (id) on delete cascade,
  billing_order int not null default 0,
  created_at    timestamptz not null default now(),
  primary key (event_id, artist_id)
);

-- The composite PK already indexes lookups by event_id (its leading column).
-- Add the reverse index so "all events for an artist" stays fast too.
create index if not exists event_artists_artist_id_idx on public.event_artists (artist_id);

-- ---------------------------------------------------------------------------
-- updated_at triggers
-- ---------------------------------------------------------------------------
-- Reuse the set_updated_at() function defined in the venues migration. artists
-- and events both get it; event_artists is an immutable link with no updated_at.
drop trigger if exists artists_set_updated_at on public.artists;
create trigger artists_set_updated_at
  before update on public.artists
  for each row
  execute function public.set_updated_at();

drop trigger if exists events_set_updated_at on public.events;
create trigger events_set_updated_at
  before update on public.events
  for each row
  execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- Row Level Security: public read, no public write (matches venues)
-- ---------------------------------------------------------------------------
alter table public.artists       enable row level security;
alter table public.events        enable row level security;
alter table public.event_artists enable row level security;

drop policy if exists "Public can read artists" on public.artists;
create policy "Public can read artists"
  on public.artists
  for select
  to anon, authenticated
  using (true);

drop policy if exists "Public can read events" on public.events;
create policy "Public can read events"
  on public.events
  for select
  to anon, authenticated
  using (true);

drop policy if exists "Public can read event_artists" on public.event_artists;
create policy "Public can read event_artists"
  on public.event_artists
  for select
  to anon, authenticated
  using (true);
