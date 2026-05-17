-- Run this entire file in Supabase SQL Editor.
-- It creates 2 tables, indexes, and Row-Level-Security policies
-- so each logged-in user can only read/write their own rows.

create table public.settings (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  threshold  numeric not null default 2000,
  updated_at timestamptz not null default now()
);

create table public.entries (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users(id) on delete cascade,
  date       date not null,
  name       text not null,
  calories   numeric not null,
  mode       text not null,
  detail     text,
  created_at timestamptz not null default now()
);

create index entries_user_date_idx on public.entries(user_id, date);

alter table public.settings enable row level security;
alter table public.entries  enable row level security;

create policy "settings_own" on public.settings
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

create policy "entries_own" on public.entries
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
