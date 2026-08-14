-- 0019_audit_clear_rpc.sql
-- 后台「审计日志」清除 RPC：按当前筛选条件删除命中的日志（仅 admin 可调用）。
-- Idempotent: CREATE OR REPLACE FUNCTION；在 Supabase SQL Editor 或迁移 runner 执行。

-- 与 admin_list_audit_logs 使用同一套筛选条件，保证「清除」与「列表 / 导出」范围一致。
CREATE OR REPLACE FUNCTION public.admin_clear_audit_logs(
  p_action TEXT DEFAULT NULL,
  p_team_id UUID DEFAULT NULL,
  p_user_id UUID DEFAULT NULL,
  p_from TIMESTAMPTZ DEFAULT NULL,
  p_to TIMESTAMPTZ DEFAULT NULL,
  p_search TEXT DEFAULT NULL
)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
  v_deleted BIGINT;
  v_admin_id UUID := auth.uid();
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'forbidden: admin only' USING ERRCODE = '42501';
  END IF;

  DELETE FROM public.audit_logs al
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

  GET DIAGNOSTICS v_deleted = ROW_COUNT;

  -- 记录本次清除操作本身（审计「清除」也需可追溯），保留操作人 / 范围 / 数量。
  INSERT INTO public.audit_logs (admin_user_id, action, target, metadata)
  VALUES (
    v_admin_id,
    'audit.clear',
    NULL,
    jsonb_strip_nulls(jsonb_build_object(
      'deleted', v_deleted,
      'action', p_action,
      'team_id', p_team_id,
      'user_id', p_user_id,
      'from', p_from,
      'to', p_to,
      'search', p_search
    ))
  );

  RETURN json_build_object('deleted', v_deleted);
END;
$$;

GRANT EXECUTE ON FUNCTION public.admin_clear_audit_logs(text, uuid, uuid, timestamptz, timestamptz, text) TO authenticated;

COMMENT ON FUNCTION public.admin_clear_audit_logs(text, uuid, uuid, timestamptz, timestamptz, text)
  IS '清除当前筛选条件下的审计日志，返回被删除条数；操作本身写入一条 audit.clear 记录（仅 admin 可调用）。';
