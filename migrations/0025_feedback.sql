-- 0025_feedback.sql
-- 桌面端「问题反馈」链路：feedback 表 + 提交 RPC + 后台列表 RPC。
-- Idempotent: CREATE TABLE IF NOT EXISTS / CREATE OR REPLACE FUNCTION；在 Supabase SQL Editor 或迁移 runner 执行。

-- ============ 1. feedback 表 ============
CREATE TABLE IF NOT EXISTS feedback (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  type TEXT NOT NULL DEFAULT '使用问题',
  title TEXT NOT NULL,
  description TEXT,
  contact TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'resolved')),
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_feedback_created
  ON feedback (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_feedback_status_created
  ON feedback (status, created_at DESC);

ALTER TABLE feedback ENABLE ROW LEVEL SECURITY;

-- 本人可读自己的反馈，admin 全量可读。
DROP POLICY IF EXISTS "feedback_select_own_or_admin" ON feedback;
CREATE POLICY "feedback_select_own_or_admin" ON feedback
  FOR SELECT USING (user_id = auth.uid() OR public.is_admin());

-- admin 全量管理（含改状态）；普通用户不直插，user_id 由提交 RPC 强制取自 auth.uid()。
DROP POLICY IF EXISTS "feedback_admin_all" ON feedback;
CREATE POLICY "feedback_admin_all" ON feedback
  FOR ALL USING (public.is_admin()) WITH CHECK (public.is_admin());

GRANT ALL ON TABLE feedback TO authenticated;

COMMENT ON TABLE feedback IS '桌面端用户问题反馈，admin 在「反馈管理」页跟进处理';

-- ============ 2. submit_feedback ============
-- SECURITY DEFINER 强制 user_id = auth.uid()，避免客户端伪造提出者。
CREATE OR REPLACE FUNCTION public.submit_feedback(
  p_type TEXT,
  p_title TEXT,
  p_description TEXT DEFAULT NULL,
  p_contact TEXT DEFAULT NULL
)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
  v_user_id UUID := auth.uid();
  v_id UUID;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'unauthorized: missing auth uid' USING ERRCODE = '42501';
  END IF;

  IF p_title IS NULL OR btrim(p_title) = '' THEN
    RAISE EXCEPTION 'invalid input: title is required' USING ERRCODE = '22004';
  END IF;

  INSERT INTO public.feedback (user_id, type, title, description, contact)
  VALUES (
    v_user_id,
    COALESCE(NULLIF(btrim(COALESCE(p_type, '')), ''), '使用问题'),
    btrim(p_title),
    NULLIF(btrim(COALESCE(p_description, '')), ''),
    NULLIF(btrim(COALESCE(p_contact, '')), '')
  )
  RETURNING id INTO v_id;

  RETURN json_build_object('ok', true, 'id', v_id);
END;
$$;

GRANT EXECUTE ON FUNCTION public.submit_feedback(text, text, text, text) TO authenticated;

COMMENT ON FUNCTION public.submit_feedback(text, text, text, text)
  IS '提交问题反馈，提出者强制取自 auth.uid()，仅登录用户可调用。';

-- ============ 3. admin_list_feedback ============
-- 返回 json { total, items: [...] }，JOIN profiles 出提出者姓名/邮箱，支持类型/状态/搜索 + 分页。
CREATE OR REPLACE FUNCTION public.admin_list_feedback(
  p_type TEXT DEFAULT NULL,
  p_status TEXT DEFAULT NULL,
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
  FROM public.feedback f
  WHERE
    (p_type IS NULL OR p_type = '' OR f.type = p_type)
    AND (p_status IS NULL OR p_status = '' OR f.status = p_status)
    AND (
      p_search IS NULL OR p_search = '' OR
      f.title ILIKE '%' || p_search || '%' OR
      f.description ILIKE '%' || p_search || '%' OR
      f.contact ILIKE '%' || p_search || '%'
    );

  SELECT COALESCE(json_agg(item), '[]'::json)
  INTO v_items
  FROM (
    SELECT
      f.id,
      f.user_id,
      f.type,
      f.title,
      f.description,
      f.contact,
      f.status,
      f.created_at,
      p.display_name AS user_name,
      p.email AS user_email
    FROM public.feedback f
    LEFT JOIN public.profiles p ON p.id = f.user_id
    WHERE
      (p_type IS NULL OR p_type = '' OR f.type = p_type)
      AND (p_status IS NULL OR p_status = '' OR f.status = p_status)
      AND (
        p_search IS NULL OR p_search = '' OR
        f.title ILIKE '%' || p_search || '%' OR
        f.description ILIKE '%' || p_search || '%' OR
        f.contact ILIKE '%' || p_search || '%'
      )
    ORDER BY f.created_at DESC, f.id DESC
    LIMIT p_limit OFFSET p_offset
  ) item;

  RETURN json_build_object(
    'total', v_total,
    'items', v_items
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.admin_list_feedback(text, text, text, integer, integer) TO authenticated;

COMMENT ON FUNCTION public.admin_list_feedback(text, text, text, integer, integer)
  IS '后台反馈列表：聚合提出者姓名/邮箱，支持类型/状态/搜索筛选与分页（仅 admin 可调用）。';
