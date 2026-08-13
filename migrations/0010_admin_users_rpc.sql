-- 0010_admin_users_rpc.sql
-- 后台「用户管理」页数据源：聚合 profiles / team_members / teams / jobs 的用户列表。
-- 幂等：CREATE OR REPLACE FUNCTION；在 Supabase SQL Editor 或迁移 runner 执行。

-- 返回 json { total, items: [...] }，支持搜索 / 角色 / 状态过滤 + 分页。
-- 消费口径：对 jobs 按 user_id 求和 equivalent_count（等效「次」）；
--   month_usage = 本月（自然月，按 Asia/Shanghai 时区对齐项目的每日额度重置约定），
--   total_usage = 累计。
-- 角色过滤：'admin'/'member' 对应 team_members.role；'none' 表示无团队（个人）。
CREATE OR REPLACE FUNCTION public.admin_list_users(
  p_search TEXT DEFAULT NULL,
  p_role TEXT DEFAULT NULL,
  p_status TEXT DEFAULT NULL,
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
  FROM profiles p
  LEFT JOIN team_members tm ON tm.user_id = p.id
  WHERE
    (p_search IS NULL OR p_search = '' OR p.email ILIKE '%' || p_search || '%' OR p.display_name ILIKE '%' || p_search || '%')
    AND (p_status IS NULL OR p_status = '' OR p.status = p_status)
    AND (
      p_role IS NULL OR p_role = '' OR
      (p_role = 'none' AND tm.user_id IS NULL) OR
      (p_role <> 'none' AND tm.role = p_role)
    );

  SELECT COALESCE(json_agg(item), '[]'::json)
  INTO v_items
  FROM (
    SELECT
      p.id,
      p.email,
      p.display_name,
      p.avatar_url,
      p.is_admin,
      p.status,
      p.created_at,
      t.name AS team_name,
      tm.role AS team_role,
      COALESCE((
        SELECT SUM(COALESCE(j.equivalent_count, 0))
        FROM jobs j
        WHERE j.user_id = p.id
          AND j.created_at >= date_trunc('month', now() AT TIME ZONE 'Asia/Shanghai') AT TIME ZONE 'Asia/Shanghai'
      ), 0) AS month_usage,
      COALESCE((
        SELECT SUM(COALESCE(j.equivalent_count, 0))
        FROM jobs j
        WHERE j.user_id = p.id
      ), 0) AS total_usage
    FROM profiles p
    LEFT JOIN team_members tm ON tm.user_id = p.id
    LEFT JOIN teams t ON t.id = tm.team_id
    WHERE
      (p_search IS NULL OR p_search = '' OR p.email ILIKE '%' || p_search || '%' OR p.display_name ILIKE '%' || p_search || '%')
      AND (p_status IS NULL OR p_status = '' OR p.status = p_status)
      AND (
        p_role IS NULL OR p_role = '' OR
        (p_role = 'none' AND tm.user_id IS NULL) OR
        (p_role <> 'none' AND tm.role = p_role)
      )
    ORDER BY p.created_at DESC, p.id
    LIMIT p_limit OFFSET p_offset
  ) item;

  RETURN json_build_object(
    'total', v_total,
    'items', v_items
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.admin_list_users(text, text, text, integer, integer) TO authenticated;

COMMENT ON FUNCTION public.admin_list_users(text, text, text, integer, integer)
  IS '后台用户管理列表：聚合 profiles/团队/消费统计，支持搜索、角色、状态过滤与分页（仅 admin 可调用）';
