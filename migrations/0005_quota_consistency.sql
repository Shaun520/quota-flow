-- 0005_quota_consistency.sql
-- 数据一致性专项：修复 UNIQUE 约束对个人账号无效（NULL != NULL）+ Job-Quota 关联 + 预留字段
-- 幂等：IF NOT EXISTS / IF EXISTS；在 Supabase SQL Editor 按序执行

-- ============ 1. 清理已有的个人账号重复 ledger 行 ============
-- 背景：team_id IS NULL 时，PostgreSQL UNIQUE 约束不生效（NULL 互不相等）
-- 策略：保留每个 (date, owner_user_id, account_key_id, provider_id) 中 id 最大的行，
--       将其 used 更新为该组 SUM(used)，删除其余行
DO $$
DECLARE
  dup RECORD;
BEGIN
  FOR dup IN
    SELECT date, owner_user_id, account_key_id, provider_id,
           array_agg(id ORDER BY id DESC) AS ids,
           SUM(used) AS total_used,
           MAX(daily_total) AS max_daily_total,
           MAX(unit_name) AS max_unit_name
    FROM quota_ledger
    WHERE team_id IS NULL
      AND account_key_id IS NOT NULL
    GROUP BY date, owner_user_id, account_key_id, provider_id
    HAVING COUNT(*) > 1
  LOOP
    -- 合并：保留首行，累加 used，删除其余
    UPDATE quota_ledger
    SET used = dup.total_used,
        remaining = GREATEST(dup.max_daily_total - dup.total_used, 0),
        daily_total = dup.max_daily_total,
        unit_name = COALESCE(dup.max_unit_name, unit_name),
        refreshed_at = now()
    WHERE id = dup.ids[1];

    DELETE FROM quota_ledger
    WHERE id = ANY(dup.ids[2:array_length(dup.ids, 1)]);
  END LOOP;
END $$;

-- ============ 2. 补个人账号的 partial unique index ============
-- 仅约束 team_id IS NULL 的行（team_id NOT NULL 由原有 UNIQUE constraint 保护）
DROP INDEX IF EXISTS idx_quota_ledger_unique_personal;
CREATE UNIQUE INDEX idx_quota_ledger_unique_personal
  ON quota_ledger (date, owner_user_id, account_key_id, provider_id)
  WHERE team_id IS NULL AND account_key_id IS NOT NULL;

COMMENT ON INDEX idx_quota_ledger_unique_personal IS
  '个人账号每日每厂商每账号唯一 ledger 行（补 team_id=NULL 时原 UNIQUE 不生效的缺陷）';

-- ============ 3. 预留额度字段（可选，支持后续 reservation 模式） ============
ALTER TABLE quota_ledger ADD COLUMN IF NOT EXISTS reserved NUMERIC DEFAULT 0;

COMMENT ON COLUMN quota_ledger.reserved IS
  '已预占额度（生成中）；仅当引入 reservation 模式后使用，当前为 0';

-- ============ 4. quota_operations：Job-Quota 关联表 ============
CREATE TABLE IF NOT EXISTS quota_operations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id UUID NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  ledger_id UUID NOT NULL REFERENCES quota_ledger(id),
  operation_type TEXT NOT NULL CHECK (operation_type IN ('reserve', 'finalize', 'release')),
  amount NUMERIC NOT NULL CHECK (amount > 0),
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE (job_id, operation_type)
);

CREATE INDEX IF NOT EXISTS idx_quota_ops_job ON quota_operations (job_id);
CREATE INDEX IF NOT EXISTS idx_quota_ops_ledger ON quota_operations (ledger_id);

ALTER TABLE quota_operations ENABLE ROW LEVEL SECURITY;

-- 个人行：owner 全权（通过 job.user_id 校验）
DROP POLICY IF EXISTS "quota_ops_select_own" ON quota_operations;
CREATE POLICY "quota_ops_select_own" ON quota_operations
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM jobs j
      WHERE j.id = quota_operations.job_id AND j.user_id = auth.uid()
    )
  );

DROP POLICY IF EXISTS "quota_ops_insert_own" ON quota_operations;
CREATE POLICY "quota_ops_insert_own" ON quota_operations
  FOR INSERT WITH CHECK (
    EXISTS (
      SELECT 1 FROM jobs j
      WHERE j.id = quota_operations.job_id AND j.user_id = auth.uid()
    )
  );

GRANT ALL ON TABLE quota_operations TO authenticated;

COMMENT ON TABLE quota_operations IS
  'Job-Quota 关联记录：每个 job 最多一条 reserve / finalize / release，保证幂等';
