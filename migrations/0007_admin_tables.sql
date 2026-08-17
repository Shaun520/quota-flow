-- 0007_admin_tables.sql
-- Admin console schema for apps/admin.
-- Aligns with docs/管理后台/后台系统规划.md and docs/设计原型/admin.html.
-- Idempotent: run in Supabase SQL Editor or via migration runner.

-- ============ 1. profiles（用户扩展信息） ============
CREATE TABLE IF NOT EXISTS profiles (
  id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  email TEXT,
  display_name TEXT,
  avatar_url TEXT,
  is_admin BOOLEAN NOT NULL DEFAULT FALSE,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'banned', 'exhausted')),
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_profiles_admin ON profiles (is_admin) WHERE is_admin;
CREATE INDEX IF NOT EXISTS idx_profiles_status ON profiles (status);

-- ============ 2. is_admin() helper ============
CREATE OR REPLACE FUNCTION public.is_admin()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, auth
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.profiles p
    WHERE p.id = auth.uid()
      AND p.is_admin = TRUE
  );
$$;

GRANT EXECUTE ON FUNCTION public.is_admin() TO authenticated;

-- 为新建 auth 用户自动补 profiles 行，避免登录后无扩展信息。
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
BEGIN
  INSERT INTO public.profiles (id, email, display_name)
  VALUES (
    NEW.id,
    NEW.email,
    COALESCE(NEW.raw_user_meta_data ->> 'display_name', split_part(COALESCE(NEW.email, ''), '@', 1))
  )
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
AFTER INSERT ON auth.users
FOR EACH ROW
EXECUTE FUNCTION public.handle_new_user();

-- profiles RLS：本人可读/更新，admin 可全量管理
ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "profiles_select_own" ON profiles;
CREATE POLICY "profiles_select_own" ON profiles
  FOR SELECT USING (id = auth.uid() OR public.is_admin());

DROP POLICY IF EXISTS "profiles_update_own" ON profiles;
CREATE POLICY "profiles_update_own" ON profiles
  FOR UPDATE USING (id = auth.uid()) WITH CHECK (id = auth.uid());

DROP POLICY IF EXISTS "profiles_admin_all" ON profiles;
CREATE POLICY "profiles_admin_all" ON profiles
  FOR ALL USING (public.is_admin()) WITH CHECK (public.is_admin());

-- ============ 3. subscriptions（订阅记录） ============
CREATE TABLE IF NOT EXISTS subscriptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id UUID NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  plan TEXT NOT NULL,
  seats INTEGER NOT NULL DEFAULT 3 CHECK (seats > 0),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'expired', 'cancelled')),
  current_period_start TIMESTAMPTZ,
  current_period_end TIMESTAMPTZ,
  payment_method TEXT,
  payment_note TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_subscriptions_team_created
  ON subscriptions (team_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_subscriptions_status_end
  ON subscriptions (status, current_period_end);

ALTER TABLE subscriptions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "subscriptions_select_team" ON subscriptions;
CREATE POLICY "subscriptions_select_team" ON subscriptions
  FOR SELECT USING (
    public.is_admin()
    OR EXISTS (
      SELECT 1 FROM team_members tm
      WHERE tm.team_id = subscriptions.team_id
        AND tm.user_id = auth.uid()
    )
  );

DROP POLICY IF EXISTS "subscriptions_admin_all" ON subscriptions;
CREATE POLICY "subscriptions_admin_all" ON subscriptions
  FOR ALL USING (public.is_admin()) WITH CHECK (public.is_admin());

-- ============ 4. provider_cost_tables（消耗表） ============
CREATE TABLE IF NOT EXISTS provider_cost_tables (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_id TEXT NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
  mode TEXT NOT NULL,
  duration_min INTEGER,
  duration_max INTEGER,
  resolution TEXT,
  model TEXT,
  unit_cost NUMERIC NOT NULL DEFAULT 1,
  equivalent_count_divisor NUMERIC NOT NULL DEFAULT 1,
  display_text TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

DROP INDEX IF EXISTS idx_provider_cost_tables_unique_rule;
CREATE UNIQUE INDEX idx_provider_cost_tables_unique_rule
  ON provider_cost_tables (provider_id, mode, duration_min, duration_max, resolution, model);

CREATE INDEX IF NOT EXISTS idx_provider_cost_tables_provider
  ON provider_cost_tables (provider_id);

ALTER TABLE provider_cost_tables ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "provider_cost_tables_select_all" ON provider_cost_tables;
CREATE POLICY "provider_cost_tables_select_all" ON provider_cost_tables
  FOR SELECT USING (auth.role() = 'authenticated');

DROP POLICY IF EXISTS "provider_cost_tables_admin_all" ON provider_cost_tables;
CREATE POLICY "provider_cost_tables_admin_all" ON provider_cost_tables
  FOR ALL USING (public.is_admin()) WITH CHECK (public.is_admin());

-- ============ 5. member_usage（成员当日消费） ============
CREATE TABLE IF NOT EXISTS member_usage (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  date DATE NOT NULL DEFAULT CURRENT_DATE,
  team_id UUID NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  user_id UUID NOT NULL,
  used_equivalent NUMERIC NOT NULL DEFAULT 0,
  frozen_until TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE (date, team_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_member_usage_team_date
  ON member_usage (team_id, date DESC);
CREATE INDEX IF NOT EXISTS idx_member_usage_user_date
  ON member_usage (user_id, date DESC);

ALTER TABLE member_usage ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "member_usage_select_team" ON member_usage;
CREATE POLICY "member_usage_select_team" ON member_usage
  FOR SELECT USING (
    public.is_admin()
    OR EXISTS (
      SELECT 1 FROM team_members tm
      WHERE tm.team_id = member_usage.team_id
        AND tm.user_id = auth.uid()
    )
  );

DROP POLICY IF EXISTS "member_usage_admin_all" ON member_usage;
CREATE POLICY "member_usage_admin_all" ON member_usage
  FOR ALL USING (public.is_admin()) WITH CHECK (public.is_admin());

-- ============ 6. announcements（公告通知） ============
CREATE TABLE IF NOT EXISTS announcements (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  target TEXT NOT NULL DEFAULT 'all' CHECK (target IN ('all', 'team')),
  team_id UUID NULL REFERENCES teams(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_announcements_created
  ON announcements (created_at DESC);

ALTER TABLE announcements ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "announcements_select_all" ON announcements;
CREATE POLICY "announcements_select_all" ON announcements
  FOR SELECT USING (auth.role() = 'authenticated');

DROP POLICY IF EXISTS "announcements_admin_all" ON announcements;
CREATE POLICY "announcements_admin_all" ON announcements
  FOR ALL USING (public.is_admin()) WITH CHECK (public.is_admin());

-- ============ 7. audit_logs（审计日志） ============
CREATE TABLE IF NOT EXISTS audit_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_user_id UUID NOT NULL,
  team_id UUID NULL,
  user_id UUID NULL,
  action TEXT NOT NULL,
  target TEXT,
  metadata JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_audit_logs_created
  ON audit_logs (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_logs_admin_action
  ON audit_logs (admin_user_id, action, created_at DESC);

ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "audit_logs_admin_all" ON audit_logs;
CREATE POLICY "audit_logs_admin_all" ON audit_logs
  FOR ALL USING (public.is_admin()) WITH CHECK (public.is_admin());

-- ============ 8. 字段补充 ============
ALTER TABLE providers
  ADD COLUMN IF NOT EXISTS equivalent_count_divisor NUMERIC NOT NULL DEFAULT 1;

ALTER TABLE provider_keys
  ADD COLUMN IF NOT EXISTS daily_quota NUMERIC;

ALTER TABLE provider_keys
  ADD COLUMN IF NOT EXISTS equivalent_count_divisor NUMERIC NOT NULL DEFAULT 1;

ALTER TABLE teams
  ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'banned', 'exhausted', 'expired'));

UPDATE providers SET equivalent_count_divisor = 1 WHERE equivalent_count_divisor IS NULL;
UPDATE provider_keys SET equivalent_count_divisor = 1 WHERE equivalent_count_divisor IS NULL;
UPDATE profiles SET updated_at = now() WHERE updated_at IS NULL;
UPDATE subscriptions SET updated_at = now() WHERE updated_at IS NULL;

-- ============ 9. 现有表 admin 访问策略 ============
ALTER TABLE teams ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "teams_admin_all" ON teams;
CREATE POLICY "teams_admin_all" ON teams
  FOR ALL USING (public.is_admin()) WITH CHECK (public.is_admin());

ALTER TABLE team_members ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "team_members_admin_all" ON team_members;
CREATE POLICY "team_members_admin_all" ON team_members
  FOR ALL USING (public.is_admin()) WITH CHECK (public.is_admin());

ALTER TABLE team_invitations ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "team_invitations_admin_all" ON team_invitations;
CREATE POLICY "team_invitations_admin_all" ON team_invitations
  FOR ALL USING (public.is_admin()) WITH CHECK (public.is_admin());

ALTER TABLE providers ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "providers_admin_all" ON providers;
CREATE POLICY "providers_admin_all" ON providers
  FOR ALL USING (public.is_admin()) WITH CHECK (public.is_admin());

ALTER TABLE provider_keys ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "provider_keys_admin_all" ON provider_keys;
CREATE POLICY "provider_keys_admin_all" ON provider_keys
  FOR ALL USING (public.is_admin()) WITH CHECK (public.is_admin());

ALTER TABLE quota_ledger ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "quota_ledger_admin_all" ON quota_ledger;
CREATE POLICY "quota_ledger_admin_all" ON quota_ledger
  FOR ALL USING (public.is_admin()) WITH CHECK (public.is_admin());

ALTER TABLE quota_operations ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "quota_ops_admin_all" ON quota_operations;
CREATE POLICY "quota_ops_admin_all" ON quota_operations
  FOR ALL USING (public.is_admin()) WITH CHECK (public.is_admin());

ALTER TABLE jobs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "jobs_admin_all" ON jobs;
CREATE POLICY "jobs_admin_all" ON jobs
  FOR ALL USING (public.is_admin()) WITH CHECK (public.is_admin());

-- ============ 10. 权限授予 ============
GRANT ALL ON TABLE profiles TO authenticated;
GRANT ALL ON TABLE subscriptions TO authenticated;
GRANT ALL ON TABLE provider_cost_tables TO authenticated;
GRANT ALL ON TABLE member_usage TO authenticated;
GRANT ALL ON TABLE announcements TO authenticated;
GRANT ALL ON TABLE audit_logs TO authenticated;
GRANT ALL ON TABLE providers TO authenticated;
GRANT ALL ON TABLE provider_keys TO authenticated;
GRANT ALL ON TABLE quota_ledger TO authenticated;
GRANT ALL ON TABLE quota_operations TO authenticated;
GRANT ALL ON TABLE teams TO authenticated;
GRANT ALL ON TABLE team_members TO authenticated;
GRANT ALL ON TABLE team_invitations TO authenticated;
GRANT ALL ON TABLE jobs TO authenticated;

-- ============ 11. Seed：qwenwan 兼容 + provider_cost_tables 初始规则 ============
INSERT INTO providers (id, name, logo, capabilities, auth_type, unit_name, default_daily_quota, equivalent_count_divisor)
VALUES
  (
    'qwenwan',
    '通义万相',
    '问',
    '{"models":["万相 2.7","万相 2.6","HappyHorse 1.0 Beta"],"modes":["t2v","img","multi_ref","first_last"]}'::jsonb,
    'cookie',
    '额度',
    10,
    1
  )
ON CONFLICT (id) DO UPDATE SET
  name = EXCLUDED.name,
  logo = EXCLUDED.logo,
  capabilities = EXCLUDED.capabilities,
  auth_type = EXCLUDED.auth_type,
  unit_name = EXCLUDED.unit_name,
  default_daily_quota = EXCLUDED.default_daily_quota,
  equivalent_count_divisor = EXCLUDED.equivalent_count_divisor;

INSERT INTO provider_cost_tables
  (provider_id, mode, duration_min, duration_max, resolution, model, unit_cost, equivalent_count_divisor, display_text)
VALUES
  ('doubao', 'text2video', 1, 5, '480p', 'default', 1, 1, '豆包 5s 480p = 1次'),
  ('doubao', 'text2video', 6, 10, '480p', 'default', 2, 1, '豆包 10s 480p = 2次'),
  ('doubao', 'img2video', 1, 5, '480p', 'default', 1, 1, '豆包图生 5s 480p = 1次'),
  ('jimeng', 'text2video', 1, 5, '720p', 'default', 80, 80, '即梦 5s 720p = 80灵感值'),
  ('jimeng', 'text2video', 6, 10, '720p', 'default', 160, 80, '即梦 10s 720p = 160灵感值'),
  ('jimeng', 'img2video', 1, 5, '720p', 'default', 80, 80, '即梦图生 5s 720p = 80灵感值'),
  ('qwenwan', 'text2video', 1, 10, '720p', 'default', 1, 1, '通义万相 10s 默认 = 1次'),
  ('yuanbao', 'text2video', 1, 10, '720p', 'default', 1, 1, '元宝 10s 默认 = 1次'),
  ('kling', 'text2video', 1, 5, '720p', 'default', 5, 5, '可灵 5s 720p = 5积分'),
  ('kling', 'text2video', 1, 5, '1080p', 'default', 10, 5, '可灵 5s 1080p = 10积分'),
  ('hailuo', 'text2video', 1, 10, '720p', 'default', 1, 1, '海螺 10s 默认 = 1次'),
  ('mathmind', 'img2video', 1, 10, '720p', 'default', 1, 1, 'mathmind = 1次')
ON CONFLICT (provider_id, mode, duration_min, duration_max, resolution, model) DO UPDATE SET
  unit_cost = EXCLUDED.unit_cost,
  equivalent_count_divisor = EXCLUDED.equivalent_count_divisor,
  display_text = EXCLUDED.display_text,
  updated_at = now();

COMMENT ON TABLE profiles IS '用户扩展信息，is_admin 控制后台登录授权';
COMMENT ON TABLE subscriptions IS '订阅记录，MVP 阶段由 admin 手动开通';
COMMENT ON TABLE provider_cost_tables IS '各厂商生成参数对应的扣减规则，admin 额度扣减规则数据源';
COMMENT ON TABLE member_usage IS '成员当日等效消费统计';
COMMENT ON TABLE announcements IS '后台公告通知';
COMMENT ON TABLE audit_logs IS '管理员关键操作审计日志';
COMMENT ON FUNCTION public.is_admin() IS '当前 auth.uid() 是否为后台管理员';
