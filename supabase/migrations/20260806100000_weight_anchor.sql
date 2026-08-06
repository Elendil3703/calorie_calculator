-- 体重锚点日期：主页缺口从这天起按每日记录自动扣减。
-- 更新当前体重时前端把它重置为当天；只改目标体重不动锚点。
alter table public.settings
  add column if not exists weight_set_date date;

-- 种子数据：CJ 从 2026-08-06 起算，初始体重 78.4 kg（目标体重由用户在设置页自行填写）。
insert into public.settings (user_id, threshold, weight_current, weight_set_date)
select id, 500, 78.4, date '2026-08-06'
from auth.users
where email = 'juntaochen718@foxmail.com'
on conflict (user_id) do update
  set weight_current = excluded.weight_current,
      weight_set_date = excluded.weight_set_date,
      updated_at = now();
