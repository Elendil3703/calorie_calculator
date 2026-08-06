-- 体重目标：主页横幅从「连续缺口天数」改为「距目标体重还需多少大卡缺口」。
-- 当前体重 / 目标体重都由用户在设置页维护，可空 = 还没设置。
alter table public.settings
  add column if not exists weight_current numeric,
  add column if not exists weight_target numeric;
