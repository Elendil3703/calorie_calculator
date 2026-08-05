-- 冰箱条目容量追踪（场景：一瓶 2L lite 牛奶常驻冰箱）。
--   volume_total_ml 非空 = 该条目开启追踪（一瓶的总量，ml/g）；
--   volume_used_ml  = 当前这瓶已喝掉的量，由前端在每次「从冰箱选择」
--   添加摄入时累加，达到总量后取模归零（进入下一瓶）。
alter table public.fridge_items
  add column if not exists volume_total_ml numeric,
  add column if not exists volume_used_ml numeric not null default 0;

-- 摄入记录反向链接冰箱条目 + 本次摄入的 ml/g 量。
-- 只在「来自开启了容量追踪的冰箱条目」时写入，用途：删除今日记录时
-- 把对应进度退回去。冰箱条目被删则置空，历史记录保留。
alter table public.entries
  add column if not exists fridge_item_id uuid references public.fridge_items(id) on delete set null,
  add column if not exists amount_ml numeric;
