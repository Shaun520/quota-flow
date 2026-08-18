-- ============================================================
-- 数据一致性修复 — 合并部署脚本 (0005 + 0006)
-- 在 Supabase SQL Editor 中一次性执行
-- URL: https://supabase.com/dashboard/project/pnhvyjyexiwmecblfwly/sql/new
-- ============================================================

-- ===== 0005: quota_consistency =====

-- 1. 清理已有的个人账号重复 ledger 行
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

-- 2. 个人账号 partial unique index（补 NULL != NULL 缺陷）
DROP INDEX IF EXISTS idx_quota_ledger_unique_personal;
CREATE UNIQUE INDEX idx_quota_ledger_unique_personal
  ON quota_ledger (date, owner_user_id, account_key_id, provider_id)
  WHERE team_id IS NULL AND account_key_id IS NOT NULL;

-- 3. 预留额度字段
ALTER TABLE quota_ledger ADD COLUMN IF NOT EXISTS reserved NUMERIC DEFAULT 0;

-- 4. quota_operations 表
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

-- ===== 0006: quota_rpc =====

SET LOCAL search_path = '';

-- atomic_consume_ledger
CREATE OR REPLACE FUNCTION atomic_consume_ledger(
  p_user_id UUID, p_provider_id TEXT, p_amount NUMERIC,
  p_key_id UUID, p_date DATE
)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path = ''
AS $$
DECLARE
  v_row quota_ledger%ROWTYPE;
  v_existing quota_ledger%ROWTYPE;
  v_count INTEGER;
BEGIN
  IF p_amount <= 0 THEN
    RETURN jsonb_build_object('ok', false, 'code', 'INVALID_AMOUNT', 'message', '额度必须大于 0');
  END IF;

  UPDATE quota_ledger
  SET used = used + p_amount,
      remaining = GREATEST(daily_total - used - p_amount - reserved, 0),
      refreshed_at = now()
  WHERE date = p_date
    AND owner_user_id = p_user_id
    AND provider_id = p_provider_id
    AND account_key_id IS NOT DISTINCT FROM p_key_id
    AND team_id IS NULL
    AND daily_total - used - reserved >= p_amount
  RETURNING * INTO v_row;

  GET DIAGNOSTICS v_count = ROW_COUNT;

  IF v_count > 0 THEN
    RETURN jsonb_build_object(
      'ok', true, 'code', 'CONSUMED', 'message', '额度扣减成功',
      'row', row_to_json(v_row)::jsonb
    );
  END IF;

  SELECT * INTO v_existing
  FROM quota_ledger
  WHERE date = p_date AND owner_user_id = p_user_id
    AND provider_id = p_provider_id
    AND account_key_id IS NOT DISTINCT FROM p_key_id
    AND team_id IS NULL;

  IF FOUND THEN
    RETURN jsonb_build_object(
      'ok', false, 'code', 'QUOTA_EXHAUSTED',
      'message', format('额度不足：需要 %s，可用 %s', p_amount,
        v_existing.daily_total - COALESCE(v_existing.used,0) - COALESCE(v_existing.reserved,0)),
      'row', row_to_json(v_existing)::jsonb
    );
  END IF;

  RETURN jsonb_build_object('ok', false, 'code', 'LEDGER_NOT_FOUND', 'message', '未找到今日账本行');
EXCEPTION WHEN OTHERS THEN
  RETURN jsonb_build_object('ok', false, 'code', 'DB_ERROR', 'message', SQLERRM);
END;
$$;

-- atomic_release_ledger
CREATE OR REPLACE FUNCTION atomic_release_ledger(
  p_user_id UUID, p_provider_id TEXT, p_amount NUMERIC,
  p_key_id UUID, p_date DATE
)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path = ''
AS $$
DECLARE v_count INTEGER;
BEGIN
  IF p_amount <= 0 THEN
    RETURN jsonb_build_object('ok', false, 'code', 'INVALID_AMOUNT', 'message', '额度必须大于 0');
  END IF;

  UPDATE quota_ledger
  SET reserved = GREATEST(reserved - p_amount, 0),
      remaining = remaining + p_amount,
      refreshed_at = now()
  WHERE date = p_date AND owner_user_id = p_user_id
    AND provider_id = p_provider_id
    AND account_key_id IS NOT DISTINCT FROM p_key_id
    AND team_id IS NULL AND reserved >= p_amount;

  GET DIAGNOSTICS v_count = ROW_COUNT;

  IF v_count > 0 THEN
    RETURN jsonb_build_object('ok', true, 'code', 'RELEASED', 'message', '预占已释放');
  END IF;
  RETURN jsonb_build_object('ok', false, 'code', 'LEDGER_NOT_FOUND', 'message', '释放失败');
END;
$$;

-- set_default_key
CREATE OR REPLACE FUNCTION set_default_key(
  p_user_id UUID, p_provider_id TEXT, p_key_id UUID
)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path = ''
AS $$
DECLARE v_count INTEGER;
BEGIN
  PERFORM 1 FROM provider_keys
  WHERE owner_user_id = p_user_id AND provider_id = p_provider_id
  FOR UPDATE;

  UPDATE provider_keys SET is_default = FALSE
  WHERE owner_user_id = p_user_id AND provider_id = p_provider_id;

  UPDATE provider_keys SET is_default = TRUE
  WHERE id = p_key_id AND owner_user_id = p_user_id;

  GET DIAGNOSTICS v_count = ROW_COUNT;

  IF v_count = 0 THEN
    UPDATE provider_keys SET is_default = TRUE
    WHERE id = (
      SELECT id FROM provider_keys
      WHERE owner_user_id = p_user_id AND provider_id = p_provider_id
      ORDER BY created_at DESC LIMIT 1
    );
    RETURN jsonb_build_object('ok', false, 'code', 'KEY_NOT_FOUND', 'message', '目标不存在，已保留原有默认');
  END IF;

  RETURN jsonb_build_object('ok', true, 'code', 'DEFAULT_SET', 'message', '默认账号已切换');
END;
$$;

-- reconcile_consume_and_finalize
CREATE OR REPLACE FUNCTION reconcile_consume_and_finalize(
  p_user_id UUID, p_provider_id TEXT, p_amount NUMERIC,
  p_key_id UUID, p_date DATE, p_job_id UUID
)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path = ''
AS $$
DECLARE
  v_op_exists BOOLEAN;
  v_ledger_id UUID;
  v_result jsonb;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('reconcile_job:' || p_job_id::text, 0));

  SELECT EXISTS(
    SELECT 1 FROM quota_operations
    WHERE job_id = p_job_id AND operation_type = 'finalize'
  ) INTO v_op_exists;

  IF v_op_exists THEN
    RETURN jsonb_build_object('ok', true, 'code', 'ALREADY_FINALIZED', 'message', '该 job 已入账');
  END IF;

  v_result := atomic_consume_ledger(p_user_id, p_provider_id, p_amount, p_key_id, p_date);

  IF (v_result->>'ok')::boolean THEN
    v_ledger_id := (v_result->'row'->>'id')::UUID;
    INSERT INTO quota_operations (job_id, ledger_id, operation_type, amount)
    VALUES (p_job_id, v_ledger_id, 'finalize', p_amount)
    ON CONFLICT (job_id, operation_type) DO NOTHING;
  END IF;

  RETURN v_result;
END;
$$;

-- 权限
GRANT EXECUTE ON FUNCTION atomic_consume_ledger(UUID, TEXT, NUMERIC, UUID, DATE) TO authenticated;
GRANT EXECUTE ON FUNCTION atomic_release_ledger(UUID, TEXT, NUMERIC, UUID, DATE) TO authenticated;
GRANT EXECUTE ON FUNCTION set_default_key(UUID, TEXT, UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION reconcile_consume_and_finalize(UUID, TEXT, NUMERIC, UUID, DATE, UUID) TO authenticated;
