-- 0004_quota_ledger_index.sql
-- listLedger 按 owner_user_id 过滤 + date 倒序，补索引避免数据量增长后全表扫描。
-- 幂等：IF NOT EXISTS；在 Supabase SQL Editor 按序执行。

CREATE INDEX IF NOT EXISTS idx_quota_ledger_owner_date
  ON quota_ledger (owner_user_id, date DESC);
