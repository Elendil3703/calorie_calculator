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

-- 每日运动量覆盖。没有行 = 当天用 USER_PROFILES 里的默认值，
-- 所以隔天自动"回到默认"是数据模型本身的语义，不用任何 cron。
create table public.daily_exercise (
  user_id    uuid not null references auth.users(id) on delete cascade,
  date       date not null,
  kcal       numeric not null,
  updated_at timestamptz not null default now(),
  primary key (user_id, date)
);

alter table public.daily_exercise enable row level security;

create policy "daily_exercise_own" on public.daily_exercise
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
