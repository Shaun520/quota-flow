-- 0006_quota_rpc.sql
-- 原子额度操作 RPC：消除 RMW race condition + 事务化默认切换
-- 所有函数 SECURITY INVOKER（受 RLS 约束，不绕过权限）
-- 幂等：CREATE OR REPLACE；在 Supabase SQL Editor 按序执行
-- 注意：SQL Editor 中执行前确保 search_path 包含 public（默认包含）

-- ============ 1. atomic_consume_ledger：原子额度扣减 ============
-- 一次调用完成「检查 → 扣减 → 返回结果」，消除 SELECT→JS calc→UPDATE 竞态
-- 返回：
--   ok:true  → 扣减成功，返回更新后的行
--   ok:false → 错误码：QUOTA_EXHAUSTED / LEDGER_NOT_FOUND / DB_ERROR
CREATE OR REPLACE FUNCTION atomic_consume_ledger(
  p_user_id UUID,
  p_provider_id TEXT,
  p_amount NUMERIC,
  p_key_id UUID,
  p_date DATE
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_row public.quota_ledger%ROWTYPE;
  v_existing public.quota_ledger%ROWTYPE;
  v_count INTEGER;
BEGIN
  -- 验证输入
  IF p_amount <= 0 THEN
    RETURN jsonb_build_object('ok', false, 'code', 'INVALID_AMOUNT', 'message', '额度必须大于 0');
  END IF;

  -- 原子 UPDATE：用 daily_total - used - reserved 而非 remaining 判断额度，
  -- 避免 remaining 字段因手动修改 / 旧 RMW 路径写入导致的数据不一致
  UPDATE public.quota_ledger
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
      'ok', true,
      'code', 'CONSUMED',
      'message', '额度扣减成功',
      'row', row_to_json(v_row)::jsonb
    );
  END IF;

  -- 未命中：区分「行不存在」vs「额度不足」
  SELECT * INTO v_existing
  FROM public.quota_ledger
  WHERE date = p_date
    AND owner_user_id = p_user_id
    AND provider_id = p_provider_id
    AND account_key_id IS NOT DISTINCT FROM p_key_id
    AND team_id IS NULL;

  IF FOUND THEN
    RETURN jsonb_build_object(
      'ok', false,
      'code', 'QUOTA_EXHAUSTED',
      'message', format('额度不足：需要 %s，可用 %s（总 %s - 已用 %s - 预留 %s）',
        p_amount,
        v_existing.daily_total - COALESCE(v_existing.used, 0) - COALESCE(v_existing.reserved, 0),
        v_existing.daily_total, COALESCE(v_existing.used, 0), COALESCE(v_existing.reserved, 0)),
      'row', row_to_json(v_existing)::jsonb
    );
  END IF;

  RETURN jsonb_build_object(
    'ok', false,
    'code', 'LEDGER_NOT_FOUND',
    'message', '未找到今日账本行，请先初始化'
  );
EXCEPTION
  WHEN OTHERS THEN
    RETURN jsonb_build_object(
      'ok', false,
      'code', 'DB_ERROR',
      'message', SQLERRM
    );
END;
$$;

COMMENT ON FUNCTION atomic_consume_ledger(UUID, TEXT, NUMERIC, UUID, DATE) IS
  '原子额度扣减：single UPDATE with WHERE remaining >= amount，消除 RMW race condition。返回 {ok, code, message, row}';

-- ============ 2. atomic_release_ledger：释放预占额度 ============
-- 将 reserved 归还到 remaining，不修改 used
CREATE OR REPLACE FUNCTION atomic_release_ledger(
  p_user_id UUID,
  p_provider_id TEXT,
  p_amount NUMERIC,
  p_key_id UUID,
  p_date DATE
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_count INTEGER;
BEGIN
  IF p_amount <= 0 THEN
    RETURN jsonb_build_object('ok', false, 'code', 'INVALID_AMOUNT', 'message', '额度必须大于 0');
  END IF;

  UPDATE public.quota_ledger
  SET reserved = GREATEST(reserved - p_amount, 0),
      remaining = remaining + p_amount,
      refreshed_at = now()
  WHERE date = p_date
    AND owner_user_id = p_user_id
    AND provider_id = p_provider_id
    AND account_key_id IS NOT DISTINCT FROM p_key_id
    AND team_id IS NULL
    AND reserved >= p_amount;

  GET DIAGNOSTICS v_count = ROW_COUNT;

  IF v_count > 0 THEN
    RETURN jsonb_build_object('ok', true, 'code', 'RELEASED', 'message', '预占已释放');
  END IF;

  RETURN jsonb_build_object('ok', false, 'code', 'LEDGER_NOT_FOUND', 'message', '释放失败：行不存在或预留不足');
END;
$$;

COMMENT ON FUNCTION atomic_release_ledger(UUID, TEXT, NUMERIC, UUID, DATE) IS
  '释放预占额度：reserved -= amount, remaining += amount';

-- ============ 3. set_default_key：事务化默认账号切换 ============
-- 显式行锁（FOR UPDATE）序列化同一用户同一厂商的并发切换，
-- 配合 idx_provider_keys_default_per_provider partial unique index 双重保护
CREATE OR REPLACE FUNCTION set_default_key(
  p_user_id UUID,
  p_provider_id TEXT,
  p_key_id UUID
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_count INTEGER;
BEGIN
  -- 显式锁定该用户该厂商所有 key 行，强制并发调用串行化
  PERFORM 1 FROM public.provider_keys
  WHERE owner_user_id = p_user_id
    AND provider_id = p_provider_id
  FOR UPDATE;

  -- Step 1: 清除该用户该厂商所有默认
  UPDATE public.provider_keys
  SET is_default = FALSE
  WHERE owner_user_id = p_user_id
    AND provider_id = p_provider_id;

  -- Step 2: 设置目标为默认
  UPDATE public.provider_keys
  SET is_default = TRUE
  WHERE id = p_key_id
    AND owner_user_id = p_user_id;

  GET DIAGNOSTICS v_count = ROW_COUNT;

  IF v_count = 0 THEN
    -- 恢复任意一个默认（避免零默认）
    UPDATE public.provider_keys
    SET is_default = TRUE
    WHERE id = (
      SELECT id FROM public.provider_keys
      WHERE owner_user_id = p_user_id
        AND provider_id = p_provider_id
      ORDER BY created_at DESC
      LIMIT 1
    );
    RETURN jsonb_build_object(
      'ok', false,
      'code', 'KEY_NOT_FOUND',
      'message', '目标账号不存在或不属于您，已保留原有默认'
    );
  END IF;

  RETURN jsonb_build_object('ok', true, 'code', 'DEFAULT_SET', 'message', '默认账号已切换');
END;
$$;

COMMENT ON FUNCTION set_default_key(UUID, TEXT, UUID) IS
  '事务化默认账号切换：清旧 + 设新在单次调用内完成，不会出现零默认中间态';

-- ============ 4. reconcile_consume_and_finalize：reconciliation 专用原子扣减+记录 ============
-- 问题：应用层先调 consumeLedger 再调 insertQuotaOperation 是两次 HTTP 调用，
--       若第一次成功第二次失败 → 额度已扣但无 finalize 记录 → 下次 reconcile 重复扣费。
-- 解决：单次 RPC 调用内完成「检查已入账 → 扣减 → 写 finalize 记录」，同一 PG 事务。
-- 并发保护：pg_advisory_xact_lock 对同一 job_id 串行化，防止两个 reconcile 同时执行。
CREATE OR REPLACE FUNCTION reconcile_consume_and_finalize(
  p_user_id UUID,
  p_provider_id TEXT,
  p_amount NUMERIC,
  p_key_id UUID,
  p_date DATE,
  p_job_id UUID
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_op_exists BOOLEAN;
  v_ledger_id UUID;
  v_result jsonb;
BEGIN
  -- 串行化同一 job 的并发 reconcile（事务级锁，COMMIT/ROLLBACK 时自动释放）
  PERFORM pg_advisory_xact_lock(hashtextextended('reconcile_job:' || p_job_id::text, 0));

  -- 防御：如果该 job 已有 finalize 记录 → 跳过（上次 reconcile 部分成功的残留）
  SELECT EXISTS(
    SELECT 1 FROM public.quota_operations
    WHERE job_id = p_job_id AND operation_type = 'finalize'
  ) INTO v_op_exists;

  IF v_op_exists THEN
    RETURN jsonb_build_object(
      'ok', true,
      'code', 'ALREADY_FINALIZED',
      'message', '该 job 已入账，跳过'
    );
  END IF;

  -- 原子扣减（同一事务内）
  v_result := public.atomic_consume_ledger(p_user_id, p_provider_id, p_amount, p_key_id, p_date);

  IF (v_result->>'ok')::boolean THEN
    v_ledger_id := (v_result->'row'->>'id')::UUID;

    -- 记录 finalize（ON CONFLICT DO NOTHING 幂等）
    INSERT INTO public.quota_operations (job_id, ledger_id, operation_type, amount)
    VALUES (p_job_id, v_ledger_id, 'finalize', p_amount)
    ON CONFLICT (job_id, operation_type) DO NOTHING;
  END IF;

  RETURN v_result;
END;
$$;

COMMENT ON FUNCTION reconcile_consume_and_finalize(UUID, TEXT, NUMERIC, UUID, DATE, UUID) IS
  'reconciliation 专用：advisory lock 串行化 + 单事务内原子扣减 + finalize 记录。防御并发重复扣费';

-- ============ 5. 权限授予（PostgREST 通过 anon/authenticated 角色调用） ============
GRANT EXECUTE ON FUNCTION atomic_consume_ledger(UUID, TEXT, NUMERIC, UUID, DATE) TO authenticated;
GRANT EXECUTE ON FUNCTION atomic_release_ledger(UUID, TEXT, NUMERIC, UUID, DATE) TO authenticated;
GRANT EXECUTE ON FUNCTION set_default_key(UUID, TEXT, UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION reconcile_consume_and_finalize(UUID, TEXT, NUMERIC, UUID, DATE, UUID) TO authenticated;
