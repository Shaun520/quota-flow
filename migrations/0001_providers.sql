-- 0001_providers.sql
-- 厂商元信息 / 绑定账号 / 额度账本（P1：绑定与展示）
-- 对齐 REQUIREMENTS.md §5.7 / §5.8；多个段落在 Supabase SQL Editor 按序执行（IF NOT EXISTS 幂等）

-- ============ 0. 团队（providers 策略引用 team_members，须先建） ============
CREATE TABLE IF NOT EXISTS teams (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  owner_id UUID NOT NULL,            -- auth.users.id
  plan TEXT NOT NULL DEFAULT 'free',
  seats_limit INTEGER NOT NULL DEFAULT 3,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS team_members (
  team_id UUID NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  user_id UUID NOT NULL,             -- auth.users.id
  role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('admin', 'member')),
  daily_quota_limit_equivalent NUMERIC,
  joined_at TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (team_id, user_id)
);

CREATE TABLE IF NOT EXISTS team_invitations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id UUID NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  email TEXT,
  role TEXT NOT NULL DEFAULT 'member',
  token TEXT NOT NULL,               -- 8 位大写邀请码
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- teams：owner 全权；成员可读
ALTER TABLE teams ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "teams_select" ON teams;
CREATE POLICY "teams_select" ON teams
  FOR SELECT USING (
    owner_id = auth.uid()
    OR EXISTS (
      SELECT 1 FROM team_members tm
      WHERE tm.team_id = teams.id AND tm.user_id = auth.uid()
    )
  );
DROP POLICY IF EXISTS "teams_insert" ON teams;
CREATE POLICY "teams_insert" ON teams FOR INSERT WITH CHECK (owner_id = auth.uid());
DROP POLICY IF EXISTS "teams_update_owner" ON teams;
CREATE POLICY "teams_update_owner" ON teams FOR UPDATE USING (owner_id = auth.uid());
DROP POLICY IF EXISTS "teams_delete_owner" ON teams;
CREATE POLICY "teams_delete_owner" ON teams FOR DELETE USING (owner_id = auth.uid());

-- team_members：个人只见自己那行（桌面端 getTeamContext 用）
ALTER TABLE team_members ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "team_members_select_own" ON team_members;
CREATE POLICY "team_members_select_own" ON team_members
  FOR SELECT USING (user_id = auth.uid());
DROP POLICY IF EXISTS "team_members_insert" ON team_members;
CREATE POLICY "team_members_insert" ON team_members
  FOR INSERT WITH CHECK (
    EXISTS (
      SELECT 1 FROM teams t WHERE t.id = team_members.team_id AND t.owner_id = auth.uid()
    )
  );
DROP POLICY IF EXISTS "team_members_update_admin" ON team_members;
CREATE POLICY "team_members_update_admin" ON team_members
  FOR UPDATE USING (
    EXISTS (
      SELECT 1 FROM teams t WHERE t.id = team_members.team_id AND t.owner_id = auth.uid()
    )
  );
DROP POLICY IF EXISTS "team_members_delete_admin" ON team_members;
CREATE POLICY "team_members_delete_admin" ON team_members
  FOR DELETE USING (
    EXISTS (
      SELECT 1 FROM teams t WHERE t.id = team_members.team_id AND t.owner_id = auth.uid()
    )
  );

-- team_invitations：仅团队 owner 管理
ALTER TABLE team_invitations ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "team_invitations_admin" ON team_invitations;
CREATE POLICY "team_invitations_admin" ON team_invitations
  FOR ALL USING (
    EXISTS (
      SELECT 1 FROM teams t WHERE t.id = team_invitations.team_id AND t.owner_id = auth.uid()
    )
  );

-- ============ 1. 厂商元信息 ============
CREATE TABLE IF NOT EXISTS providers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  logo TEXT,
  capabilities JSONB DEFAULT '{}'::jsonb,
  auth_type TEXT NOT NULL DEFAULT 'cookie',
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  unit_name TEXT,
  default_daily_quota NUMERIC DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE providers ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "providers_select_all" ON providers;
CREATE POLICY "providers_select_all" ON providers FOR SELECT USING (auth.role() = 'authenticated');

-- ============ 2. 绑定账号（cookie / apikey） ============
CREATE TABLE IF NOT EXISTS provider_keys (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id UUID NULL,                -- NULL = 个人绑定（owner 私有）
  owner_user_id UUID NOT NULL,      -- 绑定者
  provider_id TEXT NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
  account_name TEXT,
  encrypted_key TEXT NOT NULL,      -- 主进程 safeStorage 加密密文（base64）
  auth_type TEXT NOT NULL DEFAULT 'cookie',
  cookie_expires_at TIMESTAMPTZ NULL,
  last_health_check TIMESTAMPTZ NULL,
  health_status TEXT NOT NULL DEFAULT 'unknown',  -- healthy / expiring / expired / unknown
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_provider_keys_owner ON provider_keys (owner_user_id);
CREATE INDEX IF NOT EXISTS idx_provider_keys_team ON provider_keys (team_id);

ALTER TABLE provider_keys ENABLE ROW LEVEL SECURITY;

-- 个人行：owner 全权
DROP POLICY IF EXISTS "provider_keys_select_own" ON provider_keys;
CREATE POLICY "provider_keys_select_own" ON provider_keys
  FOR SELECT USING (owner_user_id = auth.uid());

-- 团队行：团队成员可见（P1 只读成员可见性，写操作仅 owner / admin 后续补）
DROP POLICY IF EXISTS "provider_keys_select_team" ON provider_keys;
CREATE POLICY "provider_keys_select_team" ON provider_keys
  FOR SELECT USING (
    team_id IS NOT NULL AND EXISTS (
      SELECT 1 FROM team_members tm
      WHERE tm.team_id = provider_keys.team_id AND tm.user_id = auth.uid()
    )
  );

DROP POLICY IF EXISTS "provider_keys_insert" ON provider_keys;
CREATE POLICY "provider_keys_insert" ON provider_keys
  FOR INSERT WITH CHECK (owner_user_id = auth.uid());

DROP POLICY IF EXISTS "provider_keys_update_own" ON provider_keys;
CREATE POLICY "provider_keys_update_own" ON provider_keys
  FOR UPDATE USING (owner_user_id = auth.uid());

DROP POLICY IF EXISTS "provider_keys_delete_own" ON provider_keys;
CREATE POLICY "provider_keys_delete_own" ON provider_keys
  FOR DELETE USING (owner_user_id = auth.uid());

-- ============ 3. 每日额度账本 ============
CREATE TABLE IF NOT EXISTS quota_ledger (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  date DATE NOT NULL DEFAULT CURRENT_DATE,
  team_id UUID NULL,
  owner_user_id UUID NULL,
  account_key_id UUID NULL REFERENCES provider_keys(id) ON DELETE CASCADE,
  provider_id TEXT NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
  unit_name TEXT,
  daily_total NUMERIC DEFAULT 0,
  used NUMERIC DEFAULT 0,
  remaining NUMERIC DEFAULT 0,
  refreshed_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE (date, team_id, owner_user_id, account_key_id, provider_id)
);

ALTER TABLE quota_ledger ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "quota_ledger_select_own" ON quota_ledger;
CREATE POLICY "quota_ledger_select_own" ON quota_ledger
  FOR SELECT USING (
    owner_user_id = auth.uid()
    OR (team_id IS NOT NULL AND EXISTS (
      SELECT 1 FROM team_members tm
      WHERE tm.team_id = quota_ledger.team_id AND tm.user_id = auth.uid()
    ))
  );

DROP POLICY IF EXISTS "quota_ledger_insert_own" ON quota_ledger;
CREATE POLICY "quota_ledger_insert_own" ON quota_ledger
  FOR INSERT WITH CHECK (
    owner_user_id = auth.uid()
    OR (team_id IS NOT NULL AND EXISTS (
      SELECT 1 FROM team_members tm
      WHERE tm.team_id = quota_ledger.team_id AND tm.user_id = auth.uid()
    ))
  );

DROP POLICY IF EXISTS "quota_ledger_update_own" ON quota_ledger;
CREATE POLICY "quota_ledger_update_own" ON quota_ledger
  FOR UPDATE USING (
    owner_user_id = auth.uid()
    OR (team_id IS NOT NULL AND EXISTS (
      SELECT 1 FROM team_members tm
      WHERE tm.team_id = quota_ledger.team_id AND tm.user_id = auth.uid()
    ))
  );

-- ============ 5. 表级权限（PostgREST 以 anon/authenticated 连接，需显式 GRANT） ============
GRANT SELECT ON TABLE providers TO anon;
GRANT ALL ON TABLE providers TO authenticated;
GRANT ALL ON TABLE provider_keys TO authenticated;
GRANT ALL ON TABLE quota_ledger TO authenticated;
GRANT ALL ON TABLE teams TO authenticated;
GRANT ALL ON TABLE team_members TO authenticated;
GRANT ALL ON TABLE team_invitations TO authenticated;

-- ============ 6. Seed：7 家厂商 ============
INSERT INTO providers (id, name, logo, capabilities, auth_type, unit_name, default_daily_quota) VALUES
  ('doubao',   '豆包',     '豆', '{"models":["Seedance 2.0 Mini"],"modes":["t2v","img"]}'::jsonb,            'cookie', '点',     10),
  ('jimeng',   '即梦',     '梦', '{"models":["视频 S2.0","视频 S2.0 Pro"],"modes":["t2v","img"]}'::jsonb,   'cookie', '灵感值', 800),
  ('qwen',     '通义万相', '问', '{"models":["万相 2.7","万相 2.6","HappyHorse 1.0 Beta"],"modes":["t2v","img","multi_ref","first_last"]}'::jsonb, 'cookie', '额度', 10),
  ('yuanbao',  '元宝混元', '元', '{"models":["混元（固定）"],"modes":["t2v","img"]}'::jsonb,                  'cookie', '个',     5),
  ('kling',    '可灵',     '灵', '{"models":["可灵-标准","可灵-大师"],"modes":["t2v","img"]}'::jsonb,       'cookie', '积分',   216),
  ('hailuo',   '海螺',     '螺', '{"models":["海螺-标准"],"modes":["t2v","img"]}'::jsonb,                   'cookie', '次',     3),
  ('mathmind', 'MathMind', 'M',  '{"models":["mathmind-v1","mathmind-v2"],"modes":["t2v","img"]}'::jsonb, 'apikey', '次',     10)
ON CONFLICT (id) DO UPDATE SET
  name = EXCLUDED.name, capabilities = EXCLUDED.capabilities,
  auth_type = EXCLUDED.auth_type, unit_name = EXCLUDED.unit_name,
  default_daily_quota = EXCLUDED.default_daily_quota;