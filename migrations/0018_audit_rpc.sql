-- 0018_audit_rpc.sql
-- 后台「审计日志」读写 RPC：列表查询 + 服务端安全写入。
-- Idempotent: CREATE OR REPLACE FUNCTION；在 Supabase SQL Editor 或迁移 runner 执行。

-- ============ 1. 索引优化 ============
-- action 前缀筛选（如 'user.' / 'provider.'）
CREATE INDEX IF NOT EXISTS idx_audit_logs_action_created
  ON audit_logs (action, created_at DESC);

-- metadata JSONB 全文搜索
CREATE INDEX IF NOT EXISTS idx_audit_logs_metadata_gin
  ON audit_logs USING GIN (metadata jsonb_path_ops);

-- target 模糊搜索
CREATE INDEX IF NOT EXISTS idx_audit_logs_target
  ON audit_logs (target text_pattern_ops);

-- ============ 2. admin_write_audit_log ============
-- SECURITY DEFINER 强制使用 auth.uid() 作为 admin_user_id，避免客户端伪造操作人。
CREATE OR REPLACE FUNCTION public.admin_write_audit_log(
  p_action TEXT,
  p_team_id UUID DEFAULT NULL,
  p_user_id UUID DEFAULT NULL,
  p_target TEXT DEFAULT NULL,
  p_metadata JSONB DEFAULT '{}'::jsonb
)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
  v_admin_id UUID := auth.uid();
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'forbidden: admin only' USING ERRCODE = '42501';
  END IF;

  IF v_admin_id IS NULL THEN
    RAISE EXCEPTION 'unauthorized: missing auth uid' USING ERRCODE = '42501';
  END IF;

  IF p_action IS NULL OR p_action = '' THEN
    RAISE EXCEPTION 'invalid input: action is required' USING ERRCODE = '22004';
  END IF;

  INSERT INTO public.audit_logs (admin_user_id, team_id, user_id, action, target, metadata)
  VALUES (v_admin_id, p_team_id, p_user_id, p_action, p_target, COALESCE(p_metadata, '{}'::jsonb));

  RETURN json_build_object('ok', true);
END;
$$;

GRANT EXECUTE ON FUNCTION public.admin_write_audit_log(text, uuid, uuid, text, jsonb) TO authenticated;

COMMENT ON FUNCTION public.admin_write_audit_log(text, uuid, uuid, text, jsonb)
  IS '服务端安全写入审计日志，操作人强制取自 auth.uid()，仅 admin 可调用。';

-- ============ 3. admin_list_audit_logs ============
-- 返回 json { total, items: [...] }，支持 action 前缀 / 团队 / 用户 / 时间 / 搜索 + 分页。
-- item 中 join 出 admin_name / admin_email / team_name / user_name / user_email，前端无需二次拼装。
CREATE OR REPLACE FUNCTION public.admin_list_audit_logs(
  p_action TEXT DEFAULT NULL,
  p_team_id UUID DEFAULT NULL,
  p_user_id UUID DEFAULT NULL,
  p_from TIMESTAMPTZ DEFAULT NULL,
  p_to TIMESTAMPTZ DEFAULT NULL,
  p_search TEXT DEFAULT NULL,
  p_limit INTEGER DEFAULT 20,
  p_offset INTEGER DEFAULT 0
)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
  v_total BIGINT;
  v_items JSON;
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'forbidden: admin only' USING ERRCODE = '42501';
  END IF;

  SELECT count(*)
  INTO v_total
  FROM public.audit_logs al
  WHERE
    (p_action IS NULL OR p_action = '' OR al.action LIKE p_action || '%')
    AND (p_team_id IS NULL OR al.team_id = p_team_id)
    AND (p_user_id IS NULL OR al.user_id = p_user_id)
    AND (p_from IS NULL OR al.created_at >= p_from)
    AND (p_to IS NULL OR al.created_at < p_to)
    AND (
      p_search IS NULL OR p_search = '' OR
      al.target ILIKE '%' || p_search || '%' OR
      al.metadata::text ILIKE '%' || p_search || '%'
    );

  SELECT COALESCE(json_agg(item), '[]'::json)
  INTO v_items
  FROM (
    SELECT
      al.id,
      al.admin_user_id,
      al.team_id,
      al.user_id,
      al.action,
      al.target,
      al.metadata,
      al.created_at,
      ap.display_name AS admin_name,
      ap.email AS admin_email,
      t.name AS team_name,
      up.display_name AS user_name,
      up.email AS user_email
    FROM public.audit_logs al
    LEFT JOIN public.profiles ap ON ap.id = al.admin_user_id
    LEFT JOIN public.teams t ON t.id = al.team_id
    LEFT JOIN public.profiles up ON up.id = al.user_id
    WHERE
      (p_action IS NULL OR p_action = '' OR al.action LIKE p_action || '%')
      AND (p_team_id IS NULL OR al.team_id = p_team_id)
      AND (p_user_id IS NULL OR al.user_id = p_user_id)
      AND (p_from IS NULL OR al.created_at >= p_from)
      AND (p_to IS NULL OR al.created_at < p_to)
      AND (
        p_search IS NULL OR p_search = '' OR
        al.target ILIKE '%' || p_search || '%' OR
        al.metadata::text ILIKE '%' || p_search || '%'
      )
    ORDER BY al.created_at DESC, al.id DESC
    LIMIT p_limit OFFSET p_offset
  ) item;

  RETURN json_build_object(
    'total', v_total,
    'items', v_items
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.admin_list_audit_logs(text, uuid, uuid, timestamptz, timestamptz, text, integer, integer) TO authenticated;

COMMENT ON FUNCTION public.admin_list_audit_logs(text, uuid, uuid, timestamptz, timestamptz, text, integer, integer)
  IS '后台审计日志列表：聚合操作人/团队/用户信息，支持多维度筛选与分页（仅 admin 可调用）。';
