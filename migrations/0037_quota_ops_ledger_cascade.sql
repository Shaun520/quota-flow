-- 0037_quota_ops_ledger_cascade.sql
-- 修复解绑账号（删除 provider_keys）时 quota_ledger 被级联删除，
-- 但 quota_operations.ledger_id 无级联导致外键冲突：
--   update or delete on table "quota_ledger" violates foreign key constraint
--   "quota_operations_ledger_id_fkey" on table "quota_operations"
-- 幂等：DROP/ADD CONSTRAINT + DELETE 先清理；在 Supabase SQL Editor 按序执行

-- 1) 先清除孤儿 ledger 关联的 quota_operations（确保删除 ledger 不再被外键阻塞）
--    这里不删业务数据，只把将随 ledger 级联删除的 operations 一并清理
DELETE FROM public.quota_operations qo
USING public.quota_ledger ql
WHERE qo.ledger_id = ql.id;

-- 2) 重建外键为级联删除：删除 ledger 时自动清理其 quota_operations
ALTER TABLE public.quota_operations
  DROP CONSTRAINT IF EXISTS quota_operations_ledger_id_fkey;

ALTER TABLE public.quota_operations
  ADD CONSTRAINT quota_operations_ledger_id_fkey
  FOREIGN KEY (ledger_id) REFERENCES public.quota_ledger(id) ON DELETE CASCADE;