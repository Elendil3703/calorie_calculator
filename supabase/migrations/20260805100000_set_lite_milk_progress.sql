-- 一次性数据修正（2026-08-05，用户要求）：把 CJ 冰箱里的 lite 牛奶
-- 进度设为 1200ml。总容量还没设过（前端此时未上线），一并设为 2000ml。
-- DO 块自校验：不是恰好命中 1 行就抛异常回滚，防止误伤同名条目。
do $$
declare n int;
begin
  update public.fridge_items
     set volume_total_ml = coalesce(volume_total_ml, 2000),
         volume_used_ml  = 1200,
         updated_at      = now()
   where (name ilike '%lite%' or name ilike '%牛奶%')
     and user_id = (select id from auth.users where email = 'juntaochen718@foxmail.com');
  get diagnostics n = row_count;
  if n <> 1 then
    raise exception 'expected exactly 1 lite-milk row for CJ, got %', n;
  end if;
end $$;
