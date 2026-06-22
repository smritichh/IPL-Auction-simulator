-- ============================================================================
-- IPL Auction Simulator — saved season history schema.
-- Run this ONCE in the Supabase SQL Editor (Dashboard → SQL Editor → New query).
-- ============================================================================

create table if not exists public.seasons (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null references auth.users (id) on delete cascade,
  created_at       timestamptz not null default now(),
  team             text not null,          -- franchise id (e.g. "MI")
  team_name        text,                   -- full name for display
  final_pos        int  not null,          -- actual finish (1..10)
  projected_pos    int,                    -- pre-season projected finish
  title_odds       numeric,                -- 0..1
  is_champion      boolean default false,
  champion         text,                   -- franchise id of the champion
  best_buy         text,
  worst_buy        text,
  squad            jsonb                   -- optional: full squad for replay/detail
);

-- Each user sees and writes only their own rows.
alter table public.seasons enable row level security;

create policy "seasons: select own"
  on public.seasons for select using (auth.uid() = user_id);

create policy "seasons: insert own"
  on public.seasons for insert with check (auth.uid() = user_id);

create policy "seasons: delete own"
  on public.seasons for delete using (auth.uid() = user_id);

-- Fast "my history, newest first" lookups.
create index if not exists seasons_user_created_idx
  on public.seasons (user_id, created_at desc);
