-- 0038_admin_generation_jobs_rpc.sql
-- 后台「生成记录」列表 RPC：查看用户调用 AI 生成视频的历史（jobs 表）。
-- 只返回安全标量字段，不下发大字段 options / attempts / cost_breakdown（AGENTS 门禁#2）。
-- Idempotent: CREATE OR REPLACE FUNCTION；在 Supabase SQL Editor 或迁移 runner 执行。

-- ============ 1. 索引优化（status 是高频筛选） ============
CREATE INDEX IF NOT EXISTS idx_jobs_status_created
  ON jobs (status, created_at DESC);

-- ============ 2. admin_list_generation_jobs ============
-- 返回 json { total, items }，支持厂商/状态/模式/用户/时间/搜索 + 分页。
-- item 中 join 出 user_name / user_email / team_name / provider_name / provider_logo，前端无需二次拼装。
CREATE OR REPLACE FUNCTION public.admin_list_generation_jobs(
  p_provider_id TEXT DEFAULT NULL,
  p_status TEXT DEFAULT NULL,
  p_mode TEXT DEFAULT NULL,
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
  FROM public.jobs j
  WHERE
    (p_provider_id IS NULL OR p_provider_id = '' OR j.provider_id = p_provider_id)
    AND (p_status IS NULL OR p_status = '' OR j.status = p_status)
    AND (p_mode IS NULL OR p_mode = '' OR j.mode = p_mode)
    AND (p_user_id IS NULL OR j.user_id = p_user_id)
    AND (p_from IS NULL OR j.created_at >= p_from)
    AND (p_to IS NULL OR j.created_at < p_to)
    AND (
      p_search IS NULL OR p_search = '' OR
      j.prompt ILIKE '%' || p_search || '%' OR
      EXISTS (
        SELECT 1 FROM public.profiles pu
        WHERE pu.id = j.user_id
          AND (pu.display_name ILIKE '%' || p_search || '%' OR pu.email ILIKE '%' || p_search || '%')
      ) OR
      EXISTS (
        SELECT 1 FROM public.teams t
        WHERE t.id = j.team_id AND t.name ILIKE '%' || p_search || '%'
      )
    );

  SELECT COALESCE(json_agg(item), '[]'::json)
  INTO v_items
  FROM (
    SELECT
      j.id,
      j.user_id,
      j.team_id,
      j.provider_id,
      j.mode,
      j.prompt,
      j.status,
      j.trace_id,
      j.result_url,
      j.quality_score,
      j.error,
      j.cost_unit,
      j.cost_amount,
      j.equivalent_count,
      j.created_at,
      j.completed_at,
      pu.display_name AS user_name,
      pu.email AS user_email,
      t.name AS team_name,
      pr.name AS provider_name,
      pr.logo AS provider_logo
    FROM public.jobs j
    LEFT JOIN public.profiles pu ON pu.id = j.user_id
    LEFT JOIN public.teams t ON t.id = j.team_id
    LEFT JOIN public.providers pr ON pr.id = j.provider_id
    WHERE
      (p_provider_id IS NULL OR p_provider_id = '' OR j.provider_id = p_provider_id)
      AND (p_status IS NULL OR p_status = '' OR j.status = p_status)
      AND (p_mode IS NULL OR p_mode = '' OR j.mode = p_mode)
      AND (p_user_id IS NULL OR j.user_id = p_user_id)
      AND (p_from IS NULL OR j.created_at >= p_from)
      AND (p_to IS NULL OR j.created_at < p_to)
      AND (
        p_search IS NULL OR p_search = '' OR
        j.prompt ILIKE '%' || p_search || '%' OR
        EXISTS (
          SELECT 1 FROM public.profiles pu2
          WHERE pu2.id = j.user_id
            AND (pu2.display_name ILIKE '%' || p_search || '%' OR pu2.email ILIKE '%' || p_search || '%')
        ) OR
        EXISTS (
          SELECT 1 FROM public.teams t2
          WHERE t2.id = j.team_id AND t2.name ILIKE '%' || p_search || '%'
        )
      )
    ORDER BY j.created_at DESC, j.id DESC
    LIMIT p_limit OFFSET p_offset
  ) item;

  RETURN json_build_object(
    'total', v_total,
    'items', v_items
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.admin_list_generation_jobs(text, text, text, uuid, timestamptz, timestamptz, text, integer, integer) TO authenticated;

COMMENT ON FUNCTION public.admin_list_generation_jobs(text, text, text, uuid, timestamptz, timestamptz, text, integer, integer)
  IS '后台生成记录列表：join 用户/团队/厂商信息，不下发 options/attempts/cost_breakdown 大字段，支持多维度筛选与分页（仅 admin 可调用）。';