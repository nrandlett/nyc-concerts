-- Migration: create the venues table
-- Run this in the Supabase SQL Editor (or via the Supabase CLI).

-- gen_random_uuid() lives in the pgcrypto extension. Supabase usually enables it
-- already, but this is safe to run either way.
create extension if not exists pgcrypto;

create table if not exists public.venues (
  id              uuid primary key default gen_random_uuid(),
  slug            text not null unique,
  name            text not null,
  borough         text not null
                    check (borough in ('Manhattan','Brooklyn','Queens','Bronx','Staten Island')),
  neighborhood    text not null,
  capacity_tier   text not null
                    check (capacity_tier in ('tiny','small','medium')),
  website_url     text,
  ticketmaster_id text,
  vibes           text[] not null default '{}',
  notes           text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

-- Common filters get an index so lookups stay fast as data grows.
create index if not exists venues_borough_idx       on public.venues (borough);
create index if not exists venues_capacity_tier_idx on public.venues (capacity_tier);

-- Keep updated_at current automatically on every UPDATE.
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists venues_set_updated_at on public.venues;
create trigger venues_set_updated_at
  before update on public.venues
  for each row
  execute function public.set_updated_at();

-- Row Level Security (RLS): this is what makes the public anon key safe.
-- We turn RLS on, then add ONE policy that allows read-only (SELECT) access.
-- With no INSERT/UPDATE/DELETE policy, the anon key cannot modify venues.
-- Our seed script uses the service_role key, which bypasses RLS entirely.
alter table public.venues enable row level security;

drop policy if exists "Public can read venues" on public.venues;
create policy "Public can read venues"
  on public.venues
  for select
  to anon, authenticated
  using (true);
