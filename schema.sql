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

-- 每日 deficit 快照。settings.threshold 只保留"当前值"，无法回溯历史，
-- 所以单开一张表，每次进入 app / 改 deficit 时给当天 upsert 一行。
-- 没行的日子，统计页按"无记录"处理（不能用当前 settings.threshold 回填，
-- 因为那等于把今天的设定追溯到过去，正是这次修复要避免的事）。
create table public.daily_deficit (
  user_id    uuid not null references auth.users(id) on delete cascade,
  date       date not null,
  kcal       numeric not null,
  updated_at timestamptz not null default now(),
  primary key (user_id, date)
);

alter table public.daily_deficit enable row level security;

create policy "daily_deficit_own" on public.daily_deficit
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- 我的冰箱：用户自己维护的食物清单，作为「按重量/体积」录入时的能量参考。
-- kcal 字段一律存大卡（kJ 在前端入库前换算），basis 决定它是 "每 100g/ml" 还是 "每份"。
create table public.fridge_items (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  name        text not null,
  kcal        numeric not null,
  basis       text not null check (basis in ('per_100g', 'per_serving')),
  expiry_date date,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index fridge_items_user_idx on public.fridge_items(user_id);

alter table public.fridge_items enable row level security;

create policy "fridge_items_own" on public.fridge_items
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- 放纵日标记。和 daily_exercise 一样靠「有没有行」表达状态：
--   有行 = 那天是放纵日，统计页用特殊颜色标出，且当天摄入不计入统计；
--   没行 = 普通日。
create table public.cheat_days (
  user_id    uuid not null references auth.users(id) on delete cascade,
  date       date not null,
  updated_at timestamptz not null default now(),
  primary key (user_id, date)
);

alter table public.cheat_days enable row level security;

create policy "cheat_days_own" on public.cheat_days
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- 冰箱条目容量追踪（场景：一瓶 2L lite 牛奶常驻冰箱）。
--   volume_total_ml 非空 = 开启追踪（一瓶总量，ml/g）；
--   volume_used_ml  = 当前这瓶已喝掉的量，前端每次「从冰箱选择」添加时累加，
--   达到总量后取模归零（进入下一瓶）。
-- entries 上的两列是反向链接：删除今日记录时按 amount_ml 把进度退回去；
-- 冰箱条目被删则 fridge_item_id 置空，历史记录保留。
-- （已作为 supabase/migrations/20260805000000_milk_volume_tracking.sql 应用）
alter table public.fridge_items
  add column if not exists volume_total_ml numeric,
  add column if not exists volume_used_ml numeric not null default 0;

alter table public.entries
  add column if not exists fridge_item_id uuid references public.fridge_items(id) on delete set null,
  add column if not exists amount_ml numeric;

-- 体重目标：设置页维护当前体重 / 目标体重，主页按 7700 大卡 ≈ 1kg 脂肪
-- 估算距目标体重还需的热量缺口。可空 = 用户还没设置。
-- weight_set_date 是体重锚点日期：缺口从这天起按每日已实现的缺口自动扣减，
-- 更新当前体重时前端把它重置为当天（只改目标体重不动锚点、保留进度）。
-- （已作为 supabase/migrations/20260806000000_weight_goal.sql
--   和 20260806100000_weight_anchor.sql 应用，后者还给 CJ 种了
--   2026-08-06 起算 78.4 kg 的初始锚点）
alter table public.settings
  add column if not exists weight_current numeric,
  add column if not exists weight_target numeric,
  add column if not exists weight_set_date date;
