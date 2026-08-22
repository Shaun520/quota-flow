-- 合并自 migrations/（38 个文件）。对新库（空 schema）执行本文件即可。
-- 重复执行幂等（IF NOT EXISTS / ON CONFLICT / DROP POLICY IF EXISTS）。

-- ============ 0001_providers.sql ============
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

-- ============ 0002_account_fingerprint.sql ============
-- 0002_account_fingerprint.sql
-- P2：账号指纹去重（方案 A）
-- provider_keys 增加 account_fingerprint：绑定登录后从页面提取账号标识（手机号/邮箱/uid 等）的 sha256。
-- 同一用户对同一厂商同一账号重复绑定 → 指纹相同 → 绑定前拦截提示。
-- 幂等：IF NOT EXISTS / IF NOT EXISTS 索引；在 Supabase SQL Editor 按序执行。

ALTER TABLE provider_keys
  ADD COLUMN IF NOT EXISTS account_fingerprint TEXT;

CREATE INDEX IF NOT EXISTS idx_provider_keys_fp
  ON provider_keys (owner_user_id, provider_id, account_fingerprint);

COMMENT ON COLUMN provider_keys.account_fingerprint IS
  '账号指纹：登录后从页面提取的账号标识（手机号/邮箱/uid等）归一化后 sha256；NULL=未提取（不参与去重）';

-- ============ 0003_jobs.sql ============
-- 0003_jobs.sql
-- 生成任务历史（P2：历史记录上库，数据库为真相源）
-- 对齐 REQUIREMENTS.md §5.7 jobs 表；在需求字段基础上补充 options / attempts JSONB，
-- 保留 dispatch 原始入参与尝试记录；status 增加 not_generated（无可用厂商派发）。
-- 幂等：IF NOT EXISTS / DROP POLICY IF EXISTS；在 Supabase SQL Editor 按序执行。

CREATE TABLE IF NOT EXISTS jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id UUID NULL REFERENCES teams(id) ON DELETE CASCADE,
  user_id UUID NULL,                        -- auth.users.id（归属用户，RLS 用）
  provider_id TEXT NULL REFERENCES providers(id) ON DELETE SET NULL,
  account_id UUID NULL REFERENCES provider_keys(id) ON DELETE SET NULL,
  mode TEXT NOT NULL,
  prompt TEXT,
  options JSONB DEFAULT '{}'::jsonb,        -- 脱敏后的生成入参（imageUrl 等）
  attempts JSONB DEFAULT '[]'::jsonb,       -- dispatch 尝试记录 [{providerId, ok, errorMessage}]
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','running','success','failed','not_generated')),
  trace_id TEXT,
  result_url TEXT,
  quality_score NUMERIC,
  error TEXT,
  cost_unit TEXT,
  cost_amount NUMERIC DEFAULT 0,
  cost_breakdown JSONB,
  equivalent_count NUMERIC,
  created_at TIMESTAMPTZ DEFAULT now(),
  completed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_jobs_team_created ON jobs (team_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_jobs_user_created ON jobs (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_jobs_provider_created ON jobs (provider_id, created_at DESC);

-- RLS（§5.8：团队成员可见本团队任务）
-- 个人行：本人全权；团队行：成员只读（写入需本人 + 必须是自己的团队）
ALTER TABLE jobs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "jobs_select_own" ON jobs;
CREATE POLICY "jobs_select_own" ON jobs
  FOR SELECT USING (
    user_id = auth.uid()
    OR (team_id IS NOT NULL AND EXISTS (
      SELECT 1 FROM team_members tm
      WHERE tm.team_id = jobs.team_id AND tm.user_id = auth.uid()
    ))
  );

DROP POLICY IF EXISTS "jobs_insert" ON jobs;
CREATE POLICY "jobs_insert" ON jobs
  FOR INSERT WITH CHECK (
    user_id = auth.uid()
    AND (team_id IS NULL OR EXISTS (
      SELECT 1 FROM team_members tm
      WHERE tm.team_id = jobs.team_id AND tm.user_id = auth.uid()
    ))
  );

DROP POLICY IF EXISTS "jobs_update_own" ON jobs;
CREATE POLICY "jobs_update_own" ON jobs
  FOR UPDATE USING (user_id = auth.uid());

DROP POLICY IF EXISTS "jobs_delete_own" ON jobs;
CREATE POLICY "jobs_delete_own" ON jobs
  FOR DELETE USING (user_id = auth.uid());

GRANT ALL ON TABLE jobs TO authenticated;

COMMENT ON TABLE jobs IS '生成任务历史（数据库为真相源；本地 jobs.jsonl 仅作 CLI 审计日志）';
COMMENT ON COLUMN jobs.status IS 'pending/running=排队中，success=成功，failed=失败，not_generated=无可用厂商派发';

-- ============ 0004_account_default.sql ============
-- 0004_account_default.sql
-- 多账号：默认账号（优先扣减）+ 每账号额度归属
-- 幂等：IF NOT EXISTS / DROP INDEX IF EXISTS；在 Supabase SQL Editor 按序执行

-- 1. 默认账号标识：每 (owner_user_id, provider_id) 至多一个默认
ALTER TABLE provider_keys ADD COLUMN IF NOT EXISTS is_default BOOLEAN NOT NULL DEFAULT FALSE;

DROP INDEX IF EXISTS idx_provider_keys_default_per_provider;
CREATE UNIQUE INDEX idx_provider_keys_default_per_provider
  ON provider_keys (owner_user_id, provider_id)
  WHERE is_default;

-- 2. 首次绑定账号默认设为默认（已有数据：每个厂商取最新一条置为默认）
UPDATE provider_keys pk
SET is_default = TRUE
WHERE pk.id IN (
  SELECT DISTINCT ON (owner_user_id, provider_id) id
  FROM provider_keys
  WHERE is_default = FALSE
  ORDER BY owner_user_id, provider_id, created_at DESC
)
AND NOT EXISTS (
  SELECT 1 FROM provider_keys p2
  WHERE p2.owner_user_id = pk.owner_user_id
    AND p2.provider_id = pk.provider_id
    AND p2.is_default = TRUE
);

COMMENT ON COLUMN provider_keys.is_default IS '默认账号：调度时优先扣减该账号额度，不足自动切下一账号';

-- ============ 0004_quota_ledger_index.sql ============
-- 0004_quota_ledger_index.sql
-- listLedger 按 owner_user_id 过滤 + date 倒序，补索引避免数据量增长后全表扫描。
-- 幂等：IF NOT EXISTS；在 Supabase SQL Editor 按序执行。

CREATE INDEX IF NOT EXISTS idx_quota_ledger_owner_date
  ON quota_ledger (owner_user_id, date DESC);

-- ============ 0005_quota_consistency.sql ============
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

-- ============ 0006_quota_rpc.sql ============
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

-- ============ 0007_admin_tables.sql ============
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

-- ============ 0007_deploy_combined.sql ============
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

-- ============ 0008_providers_realtime.sql ============
-- 0008_providers_realtime.sql
-- 让桌面端通过 Supabase Realtime 订阅 providers 表，后台停用/启用厂商时即时隐藏/显示。
-- 幂等：允许在 SQL Editor 或迁移脚本中重复执行。

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_publication
    WHERE pubname = 'supabase_realtime'
  ) AND NOT EXISTS (
    SELECT 1
    FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'providers'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.providers;
  END IF;
END $$;

-- ============ 0009_provider_logo_storage.sql ============
-- 0009_provider_logo_storage.sql
-- Public storage bucket for provider logos uploaded from the admin console.
-- Idempotent: run in Supabase SQL Editor or via migration runner.

INSERT INTO storage.buckets (id, name, public)
VALUES ('provider-logos', 'provider-logos', TRUE)
ON CONFLICT (id) DO UPDATE SET public = TRUE;

DROP POLICY IF EXISTS "provider-logos public read" ON storage.objects;
CREATE POLICY "provider-logos public read"
  ON storage.objects
  FOR SELECT
  USING (bucket_id = 'provider-logos');

DROP POLICY IF EXISTS "provider-logos admin insert" ON storage.objects;
CREATE POLICY "provider-logos admin insert"
  ON storage.objects
  FOR INSERT
  TO authenticated
  WITH CHECK (bucket_id = 'provider-logos' AND public.is_admin());

DROP POLICY IF EXISTS "provider-logos admin update" ON storage.objects;
CREATE POLICY "provider-logos admin update"
  ON storage.objects
  FOR UPDATE
  TO authenticated
  USING (bucket_id = 'provider-logos' AND public.is_admin())
  WITH CHECK (bucket_id = 'provider-logos' AND public.is_admin());

DROP POLICY IF EXISTS "provider-logos admin delete" ON storage.objects;
CREATE POLICY "provider-logos admin delete"
  ON storage.objects
  FOR DELETE
  TO authenticated
  USING (bucket_id = 'provider-logos' AND public.is_admin());

GRANT USAGE ON SCHEMA storage TO authenticated;
GRANT ALL ON storage.objects TO authenticated;

-- ============ 0010_admin_users_rpc.sql ============
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

-- ============ 0011_announcements_notifications.sql ============
-- ============ 1. announcements 扩展：通知类型 / 发布状态 / 软删除 ============
ALTER TABLE announcements
  ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'notice'
    CHECK (kind IN ('notice', 'update'));

ALTER TABLE announcements
  ADD COLUMN IF NOT EXISTS published BOOLEAN NOT NULL DEFAULT true;

ALTER TABLE announcements
  ADD COLUMN IF NOT EXISTS created_by UUID NULL REFERENCES profiles(id);

ALTER TABLE announcements
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT now();

ALTER TABLE announcements
  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ NULL;

-- 已有数据全部视为已发布公告
UPDATE announcements
SET published = true
WHERE published IS NULL OR published = false;

-- ============ 2. RLS：普通用户只读已发布且未删除的公告 ============
DROP POLICY IF EXISTS "announcements_select_all" ON announcements;
CREATE POLICY "announcements_select_all" ON announcements
  FOR SELECT
  USING (
    auth.role() = 'authenticated'
    AND published = true
    AND deleted_at IS NULL
  );

-- admin 仍可全量管理，包括草稿、已删除和版本更新公告
DROP POLICY IF EXISTS "announcements_admin_all" ON announcements;
CREATE POLICY "announcements_admin_all" ON announcements
  FOR ALL
  USING (public.is_admin())
  WITH CHECK (public.is_admin());

-- 索引：桌面端铃铛默认按时间倒序拉取已发布通知
CREATE INDEX IF NOT EXISTS idx_announcements_public
  ON announcements (published, deleted_at, created_at DESC);

COMMENT ON TABLE announcements IS '后台公告通知，kind=notice 普通公告，kind=update 版本更新说明';

-- ============ 3. Realtime：桌面端铃铛需要即时看到新发布/下架/删除 ============
ALTER TABLE announcements REPLICA IDENTITY FULL;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_publication
    WHERE pubname = 'supabase_realtime'
  ) AND NOT EXISTS (
    SELECT 1
    FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'announcements'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.announcements;
  END IF;
END $$;

-- ============ 0012_provider_duration_capabilities.sql ============
-- 0012_provider_duration_capabilities.sql
-- 厂商时长能力以 providers.capabilities.supported_durations 为准。
-- 当前实际执行链路只确认豆包支持 5s / 10s；未确认支持 15s 的一律不配置 15。

UPDATE providers
SET capabilities = COALESCE(capabilities, '{}'::jsonb) || '{"supported_durations":[5,10]}'::jsonb
WHERE id IN ('doubao', 'jimeng', 'qwen', 'qwenwan', 'hailuo', 'mathmind');

UPDATE providers
SET capabilities = COALESCE(capabilities, '{}'::jsonb) || '{"supported_durations":[5]}'::jsonb
WHERE id IN ('yuanbao', 'kling');

-- ============ 0013_team_rpc.sql ============
-- 0013_team_rpc.sql
-- Team module RPCs for admin management and desktop create/join flows.
-- Idempotent: uses CREATE OR REPLACE FUNCTION and explicit GRANTs.

-- ============ 1. admin_list_teams ============
CREATE OR REPLACE FUNCTION public.admin_list_teams(
  p_search TEXT DEFAULT NULL,
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
  FROM teams t
  LEFT JOIN profiles owner ON owner.id = t.owner_id
  WHERE
    (p_search IS NULL OR p_search = '' OR t.name ILIKE '%' || p_search || '%' OR owner.email ILIKE '%' || p_search || '%' OR owner.display_name ILIKE '%' || p_search || '%')
    AND (p_status IS NULL OR p_status = '' OR t.status = p_status);

  SELECT COALESCE(json_agg(item), '[]'::json)
  INTO v_items
  FROM (
    SELECT
      t.id,
      t.name,
      t.owner_id,
      owner.email AS owner_email,
      owner.display_name AS owner_name,
      owner.status AS owner_status,
      t.plan,
      t.seats_limit,
      t.status,
      t.created_at,
      (
        SELECT count(*)
        FROM team_members tm
        WHERE tm.team_id = t.id
      ) AS member_count,
      (
        SELECT count(*)
        FROM team_members tm
        JOIN profiles mp ON mp.id = tm.user_id
        WHERE tm.team_id = t.id
          AND mp.status = 'active'
      ) AS active_member_count,
      (
        SELECT json_build_object(
          'plan', s.plan,
          'status', s.status,
          'seats', s.seats,
          'current_period_start', s.current_period_start,
          'current_period_end', s.current_period_end
        )
        FROM subscriptions s
        WHERE s.team_id = t.id
        ORDER BY s.created_at DESC
        LIMIT 1
      ) AS subscription,
      COALESCE((
        SELECT SUM(COALESCE(j.equivalent_count, 0))
        FROM jobs j
        WHERE j.team_id = t.id
          AND j.created_at >= date_trunc('month', now() AT TIME ZONE 'Asia/Shanghai') AT TIME ZONE 'Asia/Shanghai'
      ), 0) AS month_usage,
      COALESCE((
        SELECT SUM(COALESCE(j.equivalent_count, 0))
        FROM jobs j
        WHERE j.team_id = t.id
      ), 0) AS total_usage,
      (
        SELECT count(*)
        FROM provider_keys pk
        WHERE pk.team_id = t.id
      ) AS key_count
    FROM teams t
    LEFT JOIN profiles owner ON owner.id = t.owner_id
    WHERE
      (p_search IS NULL OR p_search = '' OR t.name ILIKE '%' || p_search || '%' OR owner.email ILIKE '%' || p_search || '%' OR owner.display_name ILIKE '%' || p_search || '%')
      AND (p_status IS NULL OR p_status = '' OR t.status = p_status)
    ORDER BY t.created_at DESC, t.id
    LIMIT p_limit OFFSET p_offset
  ) item;

  RETURN json_build_object(
    'total', v_total,
    'items', v_items
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.admin_list_teams(text, text, integer, integer) TO authenticated;

COMMENT ON FUNCTION public.admin_list_teams(text, text, integer, integer)
  IS 'Admin team list with owner, members, subscription, usage, and key count. Admin only.';

-- ============ 2. admin_list_team_members ============
CREATE OR REPLACE FUNCTION public.admin_list_team_members(p_team_id UUID)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
  v_items JSON;
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'forbidden: admin only' USING ERRCODE = '42501';
  END IF;

  SELECT COALESCE(json_agg(item), '[]'::json)
  INTO v_items
  FROM (
    SELECT
      tm.team_id,
      tm.user_id,
      p.email,
      p.display_name,
      p.status,
      tm.role,
      tm.daily_quota_limit_equivalent,
      tm.joined_at,
      (
        SELECT mu.used_equivalent
        FROM member_usage mu
        WHERE mu.team_id = tm.team_id
          AND mu.user_id = tm.user_id
          AND mu.date = (now() AT TIME ZONE 'Asia/Shanghai')::date
        LIMIT 1
      ) AS today_usage,
      COALESCE((
        SELECT SUM(COALESCE(j.equivalent_count, 0))
        FROM jobs j
        WHERE j.team_id = tm.team_id
          AND j.user_id = tm.user_id
          AND j.created_at >= date_trunc('month', now() AT TIME ZONE 'Asia/Shanghai') AT TIME ZONE 'Asia/Shanghai'
      ), 0) AS month_usage,
      COALESCE((
        SELECT SUM(COALESCE(j.equivalent_count, 0))
        FROM jobs j
        WHERE j.team_id = tm.team_id
          AND j.user_id = tm.user_id
      ), 0) AS total_usage
    FROM team_members tm
    JOIN profiles p ON p.id = tm.user_id
    WHERE tm.team_id = p_team_id
    ORDER BY tm.joined_at, tm.user_id
  ) item;

  RETURN json_build_object(
    'items', v_items
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.admin_list_team_members(uuid) TO authenticated;

COMMENT ON FUNCTION public.admin_list_team_members(uuid)
  IS 'Admin team member detail list. Admin only.';

-- ============ 3. create_team ============
CREATE OR REPLACE FUNCTION public.create_team(p_name TEXT)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
  v_user_id UUID := auth.uid();
  v_team_id UUID;
  v_member_exists BOOLEAN;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'forbidden: not signed in' USING ERRCODE = '42501';
  END IF;

  IF p_name IS NULL OR trim(p_name) = '' THEN
    RAISE EXCEPTION 'team name is required';
  END IF;

  SELECT EXISTS(
    SELECT 1 FROM team_members tm WHERE tm.user_id = v_user_id
  ) INTO v_member_exists;

  IF v_member_exists THEN
    RAISE EXCEPTION 'already in a team';
  END IF;

  INSERT INTO teams (name, owner_id, plan, seats_limit, status)
  VALUES (trim(p_name), v_user_id, 'free', 3, 'active')
  RETURNING id INTO v_team_id;

  INSERT INTO team_members (team_id, user_id, role)
  VALUES (v_team_id, v_user_id, 'admin');

  RETURN json_build_object(
    'ok', true,
    'team', json_build_object('id', v_team_id, 'role', 'admin')
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.create_team(text) TO authenticated;

COMMENT ON FUNCTION public.create_team(text)
  IS 'Create a team with the signed-in user as owner/admin member.';

-- ============ 4. join_team_by_invite ============
CREATE OR REPLACE FUNCTION public.join_team_by_invite(p_token TEXT)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
  v_user_id UUID := auth.uid();
  v_invite_id UUID;
  v_team_id UUID;
  v_role TEXT;
  v_member_count INTEGER;
  v_seats_limit INTEGER;
  v_team_status TEXT;
  v_member_exists BOOLEAN;
  v_inserted_user UUID;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'forbidden: not signed in' USING ERRCODE = '42501';
  END IF;

  IF p_token IS NULL OR trim(p_token) = '' THEN
    RAISE EXCEPTION 'invite token is required';
  END IF;

  SELECT
    i.id,
    i.team_id,
    COALESCE(NULLIF(i.role, ''), 'member'),
    t.seats_limit,
    t.status
  INTO
    v_invite_id,
    v_team_id,
    v_role,
    v_seats_limit,
    v_team_status
  FROM team_invitations i
  JOIN teams t ON t.id = i.team_id
  WHERE i.token = upper(trim(p_token))
  LIMIT 1
  FOR UPDATE OF i;

  IF v_invite_id IS NULL THEN
    RAISE EXCEPTION 'invalid invite';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM team_invitations i
    WHERE i.id = v_invite_id
      AND i.expires_at > now()
  ) THEN
    RAISE EXCEPTION 'invite expired';
  END IF;

  IF v_team_status IS DISTINCT FROM 'active' THEN
    RAISE EXCEPTION 'team not active';
  END IF;

  SELECT EXISTS(
    SELECT 1 FROM team_members tm WHERE tm.user_id = v_user_id
  ) INTO v_member_exists;

  IF v_member_exists THEN
    RAISE EXCEPTION 'already in a team';
  END IF;

  SELECT count(*)
  INTO v_member_count
  FROM team_members tm
  WHERE tm.team_id = v_team_id;

  IF v_member_count >= v_seats_limit THEN
    RAISE EXCEPTION 'team seats full';
  END IF;

  INSERT INTO team_members (team_id, user_id, role)
  VALUES (v_team_id, v_user_id, v_role)
  ON CONFLICT (team_id, user_id) DO NOTHING
  RETURNING user_id INTO v_inserted_user;

  IF v_inserted_user IS NULL THEN
    RAISE EXCEPTION 'already in team';
  END IF;

  DELETE FROM team_invitations WHERE id = v_invite_id;

  RETURN json_build_object(
    'ok', true,
    'team', json_build_object('id', v_team_id, 'role', v_role)
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.join_team_by_invite(text) TO authenticated;

COMMENT ON FUNCTION public.join_team_by_invite(text)
  IS 'Join a team by a one-time 8-character invite token. Consumes the invitation.';

-- ============ 5. get_team_detail ============
CREATE OR REPLACE FUNCTION public.get_team_detail(p_team_id UUID)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
  v_user_id UUID := auth.uid();
  v_row JSON;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'forbidden: not signed in' USING ERRCODE = '42501';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM team_members tm
    WHERE tm.team_id = p_team_id AND tm.user_id = v_user_id
  ) THEN
    RAISE EXCEPTION 'forbidden: not a team member' USING ERRCODE = '42501';
  END IF;

  SELECT json_build_object(
    'id', t.id,
    'name', t.name,
    'owner_id', t.owner_id,
    'owner_email', owner.email,
    'owner_name', owner.display_name,
    'owner_status', owner.status,
    'plan', t.plan,
    'seats_limit', t.seats_limit,
    'status', t.status,
    'created_at', t.created_at,
    'member_count', (
      SELECT count(*) FROM team_members tm
      WHERE tm.team_id = t.id
    ),
    'active_member_count', (
      SELECT count(*) FROM team_members tm
      JOIN profiles mp ON mp.id = tm.user_id
      WHERE tm.team_id = t.id AND mp.status = 'active'
    ),
    'subscription', CASE
      WHEN EXISTS (SELECT 1 FROM subscriptions s WHERE s.team_id = t.id)
      THEN (
        SELECT json_build_object(
          'plan', s.plan,
          'status', s.status,
          'seats', s.seats,
          'current_period_start', s.current_period_start,
          'current_period_end', s.current_period_end
        )
        FROM subscriptions s
        WHERE s.team_id = t.id
        ORDER BY s.created_at DESC
        LIMIT 1
      )
      ELSE NULL
    END,
    'month_usage', COALESCE((
      SELECT SUM(COALESCE(j.equivalent_count, 0))
      FROM jobs j
      WHERE j.team_id = t.id
        AND j.created_at >= date_trunc('month', now() AT TIME ZONE 'Asia/Shanghai') AT TIME ZONE 'Asia/Shanghai'
    ), 0),
    'total_usage', COALESCE((
      SELECT SUM(COALESCE(j.equivalent_count, 0))
      FROM jobs j
      WHERE j.team_id = t.id
    ), 0),
    'key_count', (
      SELECT count(*) FROM provider_keys pk
      WHERE pk.team_id = t.id
    ),
    'current_user_role', (
      SELECT tm.role FROM team_members tm
      WHERE tm.team_id = t.id AND tm.user_id = v_user_id
    )
  )
  INTO v_row
  FROM teams t
  LEFT JOIN profiles owner ON owner.id = t.owner_id
  WHERE t.id = p_team_id;

  IF v_row IS NULL THEN
    RAISE EXCEPTION 'team not found';
  END IF;

  RETURN json_build_object('team', v_row);
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_team_detail(uuid) TO authenticated;

COMMENT ON FUNCTION public.get_team_detail(uuid)
  IS 'Team detail for the signed-in member, including owner profile and usage summary.';

-- ============ 6. get_team_members ============
CREATE OR REPLACE FUNCTION public.get_team_members(p_team_id UUID)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
  v_user_id UUID := auth.uid();
  v_items JSON;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'forbidden: not signed in' USING ERRCODE = '42501';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM team_members tm
    WHERE tm.team_id = p_team_id AND tm.user_id = v_user_id
  ) THEN
    RAISE EXCEPTION 'forbidden: not a team member' USING ERRCODE = '42501';
  END IF;

  SELECT COALESCE(json_agg(item), '[]'::json)
  INTO v_items
  FROM (
    SELECT
      tm.team_id,
      tm.user_id,
      p.email,
      p.display_name,
      p.status,
      tm.role,
      tm.daily_quota_limit_equivalent,
      tm.joined_at,
      (
        SELECT mu.used_equivalent
        FROM member_usage mu
        WHERE mu.team_id = tm.team_id
          AND mu.user_id = tm.user_id
          AND mu.date = (now() AT TIME ZONE 'Asia/Shanghai')::date
        LIMIT 1
      ) AS today_usage,
      COALESCE((
        SELECT SUM(COALESCE(j.equivalent_count, 0))
        FROM jobs j
        WHERE j.team_id = tm.team_id
          AND j.user_id = tm.user_id
          AND j.created_at >= date_trunc('month', now() AT TIME ZONE 'Asia/Shanghai') AT TIME ZONE 'Asia/Shanghai'
      ), 0) AS month_usage,
      COALESCE((
        SELECT SUM(COALESCE(j.equivalent_count, 0))
        FROM jobs j
        WHERE j.team_id = tm.team_id
          AND j.user_id = tm.user_id
      ), 0) AS total_usage
    FROM team_members tm
    JOIN profiles p ON p.id = tm.user_id
    WHERE tm.team_id = p_team_id
    ORDER BY tm.joined_at, tm.user_id
  ) item;

  RETURN json_build_object('items', v_items);
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_team_members(uuid) TO authenticated;

COMMENT ON FUNCTION public.get_team_members(uuid)
  IS 'Team member list for the signed-in member, including profile and usage stats.';

-- ============ 7. create_team_invite ============
CREATE OR REPLACE FUNCTION public.create_team_invite(
  p_team_id UUID,
  p_email TEXT DEFAULT NULL,
  p_role TEXT DEFAULT 'member',
  p_expires_at TIMESTAMPTZ DEFAULT NULL
)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
  v_user_id UUID := auth.uid();
  v_token TEXT;
  v_invite_id UUID;
  v_expires_at TIMESTAMPTZ;
  v_member_count INTEGER;
  v_seats_limit INTEGER;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'forbidden: not signed in' USING ERRCODE = '42501';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM teams t WHERE t.id = p_team_id AND t.owner_id = v_user_id
  ) THEN
    RAISE EXCEPTION 'forbidden: only team owner can create invites' USING ERRCODE = '42501';
  END IF;

  IF p_role IS NULL OR p_role NOT IN ('member', 'admin') THEN
    RAISE EXCEPTION 'invalid invite role';
  END IF;

  SELECT t.seats_limit INTO v_seats_limit
  FROM teams t WHERE t.id = p_team_id;

  SELECT count(*) INTO v_member_count
  FROM team_members tm WHERE tm.team_id = p_team_id;

  IF v_member_count >= v_seats_limit THEN
    RAISE EXCEPTION 'team seats full';
  END IF;

  v_token := upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 8));
  v_expires_at := COALESCE(p_expires_at, now() + interval '7 days');

  IF v_expires_at <= now() THEN
    RAISE EXCEPTION 'invite expires_at must be in the future';
  END IF;

  INSERT INTO team_invitations (team_id, email, role, token, expires_at)
  VALUES (p_team_id, NULLIF(trim(p_email), ''), p_role, v_token, v_expires_at)
  RETURNING id INTO v_invite_id;

  RETURN json_build_object(
    'invite', json_build_object(
      'id', v_invite_id,
      'team_id', p_team_id,
      'email', NULLIF(trim(p_email), ''),
      'role', p_role,
      'token', v_token,
      'expires_at', v_expires_at,
      'created_at', now()
    )
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.create_team_invite(uuid, text, text, timestamptz) TO authenticated;

COMMENT ON FUNCTION public.create_team_invite(uuid, text, text, timestamptz)
  IS 'Create a one-time 7-day invite token for a team owner.';

-- ============ 0014_team_quota_rpc.sql ============
-- 0014_team_quota_rpc.sql
-- Team shared quota pool RPCs.
-- Uses existing quota_ledger rows with team_id NOT NULL, owner_user_id NULL,
-- account_key_id NULL as the team-level daily pool.
-- Idempotent: uses CREATE OR REPLACE and explicit GRANTs.

-- ============ 0. Team pool ledger uniqueness ============
-- quota_ledger UNIQUE (date, team_id, owner_user_id, account_key_id, provider_id)
-- does not protect team pool rows because both owner_user_id and account_key_id
-- are NULL. Use a partial unique index for the team-level aggregate row.
DROP INDEX IF EXISTS idx_quota_ledger_unique_team_pool;
CREATE UNIQUE INDEX idx_quota_ledger_unique_team_pool
  ON public.quota_ledger (date, team_id, provider_id)
  WHERE team_id IS NOT NULL AND owner_user_id IS NULL AND account_key_id IS NULL;

-- ============ 1. team_quota_snapshot ============
CREATE OR REPLACE FUNCTION public.team_quota_snapshot(
  p_team_id UUID,
  p_provider_id TEXT DEFAULT 'doubao'
)
RETURNS json
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
  v_daily_total NUMERIC;
  v_used NUMERIC;
  v_reserved NUMERIC;
BEGIN
  IF NOT public.is_admin()
     AND NOT EXISTS (
       SELECT 1 FROM public.team_members tm
       WHERE tm.team_id = p_team_id AND tm.user_id = auth.uid()
     ) THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501';
  END IF;

  SELECT COALESCE(SUM(COALESCE(pk.daily_quota, p.default_daily_quota, 0)), 0)
  INTO v_daily_total
  FROM public.provider_keys pk
  JOIN public.providers p ON p.id = pk.provider_id
  WHERE pk.team_id = p_team_id
    AND pk.provider_id = p_provider_id
    AND pk.enabled = true;

  SELECT COALESCE(SUM(l.used), 0), COALESCE(SUM(l.reserved), 0)
  INTO v_used, v_reserved
  FROM public.quota_ledger l
  WHERE l.date = (now() AT TIME ZONE 'Asia/Shanghai')::date
    AND l.team_id = p_team_id
    AND l.owner_user_id IS NULL
    AND l.account_key_id IS NULL
    AND l.provider_id = p_provider_id;

  RETURN json_build_object(
    'provider_id', p_provider_id,
    'daily_total', v_daily_total,
    'used', COALESCE(v_used, 0),
    'remaining', GREATEST(v_daily_total - COALESCE(v_used, 0) - COALESCE(v_reserved, 0), 0),
    'reserved', COALESCE(v_reserved, 0)
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.team_quota_snapshot(uuid, text) TO authenticated;

COMMENT ON FUNCTION public.team_quota_snapshot(uuid, text)
  IS 'Return team daily shared quota summary for a provider. Admin or team member only.';

-- ============ 2. get_team_quota ============
CREATE OR REPLACE FUNCTION public.get_team_quota(
  p_team_id UUID,
  p_provider_id TEXT DEFAULT 'doubao'
)
RETURNS json
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
  v_user_id UUID := auth.uid();
  v_today DATE := (now() AT TIME ZONE 'Asia/Shanghai')::date;
  v_member_used NUMERIC;
  v_member_limit NUMERIC;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'forbidden: not signed in' USING ERRCODE = '42501';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.team_members tm
    WHERE tm.team_id = p_team_id AND tm.user_id = v_user_id
  ) THEN
    RAISE EXCEPTION 'forbidden: not a team member' USING ERRCODE = '42501';
  END IF;

  SELECT
    COALESCE((
      SELECT mu.used_equivalent
      FROM public.member_usage mu
      WHERE mu.team_id = p_team_id
        AND mu.user_id = v_user_id
        AND mu.date = v_today
      LIMIT 1
    ), 0),
    tm.daily_quota_limit_equivalent
  INTO v_member_used, v_member_limit
  FROM public.team_members tm
  WHERE tm.team_id = p_team_id AND tm.user_id = v_user_id;

  RETURN json_build_object(
    'team_id', p_team_id,
    'quota', public.team_quota_snapshot(p_team_id, p_provider_id),
    'member_used', v_member_used,
    'member_limit', v_member_limit
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_team_quota(uuid, text) TO authenticated;

COMMENT ON FUNCTION public.get_team_quota(uuid, text)
  IS 'Team quota summary for the signed-in team member.';

-- ============ 3. team_consume_quota_and_finalize ============
CREATE OR REPLACE FUNCTION public.team_consume_quota_and_finalize(
  p_team_id UUID,
  p_user_id UUID,
  p_provider_id TEXT,
  p_amount NUMERIC,
  p_account_key_id UUID,
  p_date DATE,
  p_job_id UUID
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
  v_user_id UUID := auth.uid();
  v_today DATE := COALESCE(p_date, (now() AT TIME ZONE 'Asia/Shanghai')::date);
  v_op_exists BOOLEAN;
  v_team_status TEXT;
  v_daily_total NUMERIC;
  v_pool public.quota_ledger%ROWTYPE;
  v_account public.quota_ledger%ROWTYPE;
  v_account_total NUMERIC;
  v_member_used NUMERIC;
  v_member_limit NUMERIC;
  v_pool_id UUID;
BEGIN
  IF v_user_id IS NULL OR p_user_id IS DISTINCT FROM v_user_id THEN
    RETURN jsonb_build_object('ok', false, 'code', 'FORBIDDEN', 'message', 'forbidden');
  END IF;

  IF p_amount <= 0 THEN
    RETURN jsonb_build_object('ok', false, 'code', 'INVALID_AMOUNT', 'message', 'amount must be greater than 0');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.team_members tm
    WHERE tm.team_id = p_team_id AND tm.user_id = v_user_id
  ) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'FORBIDDEN', 'message', 'not a team member');
  END IF;

  SELECT status INTO v_team_status FROM public.teams WHERE id = p_team_id;
  IF v_team_status IS DISTINCT FROM 'active' THEN
    RETURN jsonb_build_object('ok', false, 'code', 'TEAM_NOT_ACTIVE', 'message', 'team not active');
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('team_quota:' || p_team_id::text || ':' || v_today::text, 0));

  IF p_job_id IS NOT NULL THEN
    SELECT EXISTS(
      SELECT 1 FROM public.quota_operations
      WHERE job_id = p_job_id AND operation_type = 'finalize'
    ) INTO v_op_exists;

    IF v_op_exists THEN
      RETURN jsonb_build_object(
        'ok', true,
        'code', 'ALREADY_FINALIZED',
        'message', 'job already finalized'
      );
    END IF;
  END IF;

  SELECT COALESCE(SUM(COALESCE(pk.daily_quota, p.default_daily_quota, 0)), 0)
  INTO v_daily_total
  FROM public.provider_keys pk
  JOIN public.providers p ON p.id = pk.provider_id
  WHERE pk.team_id = p_team_id
    AND pk.provider_id = p_provider_id
    AND pk.enabled = true;

  SELECT * INTO v_pool
  FROM public.quota_ledger
  WHERE date = v_today
    AND team_id = p_team_id
    AND owner_user_id IS NULL
    AND account_key_id IS NULL
    AND provider_id = p_provider_id
  FOR UPDATE;

  IF NOT FOUND THEN
    INSERT INTO public.quota_ledger (
      date, team_id, owner_user_id, account_key_id, provider_id,
      unit_name, daily_total, used, remaining, reserved
    )
    VALUES (
      v_today, p_team_id, NULL, NULL, p_provider_id,
      'points', v_daily_total, 0, v_daily_total, 0
    )
    ON CONFLICT (date, team_id, provider_id)
    WHERE team_id IS NOT NULL AND owner_user_id IS NULL AND account_key_id IS NULL
    DO UPDATE SET
      daily_total = EXCLUDED.daily_total,
      remaining = GREATEST(EXCLUDED.daily_total - quota_ledger.used - quota_ledger.reserved, 0),
      refreshed_at = now()
    RETURNING * INTO v_pool;
  ELSE
    UPDATE public.quota_ledger
    SET daily_total = v_daily_total,
        remaining = GREATEST(v_daily_total - used - reserved, 0),
        refreshed_at = now()
    WHERE id = v_pool.id
    RETURNING * INTO v_pool;
  END IF;

  IF v_pool.daily_total - COALESCE(v_pool.used, 0) - COALESCE(v_pool.reserved, 0) < p_amount THEN
    RETURN jsonb_build_object(
      'ok', false,
      'code', 'QUOTA_EXHAUSTED',
      'message', format('team quota exhausted: need %s, available %s',
        p_amount,
        v_pool.daily_total - COALESCE(v_pool.used, 0) - COALESCE(v_pool.reserved, 0)),
      'row', row_to_json(v_pool)::jsonb
    );
  END IF;

  SELECT COALESCE(mu.used_equivalent, 0), tm.daily_quota_limit_equivalent
  INTO v_member_used, v_member_limit
  FROM public.team_members tm
  LEFT JOIN public.member_usage mu
    ON mu.team_id = tm.team_id
   AND mu.user_id = tm.user_id
   AND mu.date = v_today
  WHERE tm.team_id = p_team_id AND tm.user_id = v_user_id
  FOR UPDATE OF tm;

  IF v_member_limit IS NOT NULL AND COALESCE(v_member_used, 0) + p_amount > v_member_limit THEN
    RETURN jsonb_build_object(
      'ok', false,
      'code', 'MEMBER_QUOTA_EXCEEDED',
      'message', format('member daily limit exceeded: need %s, remaining %s',
        p_amount,
        GREATEST(v_member_limit - COALESCE(v_member_used, 0), 0))
    );
  END IF;

  IF p_account_key_id IS NOT NULL THEN
    SELECT COALESCE(pk.daily_quota, p.default_daily_quota, 0)
    INTO v_account_total
    FROM public.provider_keys pk
    JOIN public.providers p ON p.id = pk.provider_id
    WHERE pk.id = p_account_key_id
      AND pk.team_id = p_team_id
      AND pk.provider_id = p_provider_id
      AND pk.enabled = true;

    IF NOT FOUND THEN
      RETURN jsonb_build_object('ok', false, 'code', 'ACCOUNT_NOT_FOUND', 'message', 'team account not found or disabled');
    END IF;

    SELECT * INTO v_account
    FROM public.quota_ledger
    WHERE date = v_today
      AND team_id = p_team_id
      AND account_key_id = p_account_key_id
      AND provider_id = p_provider_id
    FOR UPDATE;

    IF NOT FOUND THEN
      INSERT INTO public.quota_ledger (
        date, team_id, owner_user_id, account_key_id, provider_id,
        unit_name, daily_total, used, remaining, reserved
      )
      SELECT
        v_today, p_team_id, pk.owner_user_id, pk.id, p_provider_id,
        COALESCE(pr.unit_name, 'points'), v_account_total, 0, v_account_total, 0
      FROM public.provider_keys pk
      JOIN public.providers pr ON pr.id = pk.provider_id
      WHERE pk.id = p_account_key_id
      ON CONFLICT (date, team_id, owner_user_id, account_key_id, provider_id)
      DO UPDATE SET
        daily_total = EXCLUDED.daily_total,
        remaining = GREATEST(EXCLUDED.daily_total - quota_ledger.used - quota_ledger.reserved, 0),
        refreshed_at = now()
      RETURNING * INTO v_account;
    ELSE
      UPDATE public.quota_ledger
      SET daily_total = v_account_total,
          remaining = GREATEST(v_account_total - used - reserved, 0),
          refreshed_at = now()
      WHERE id = v_account.id
      RETURNING * INTO v_account;
    END IF;

    IF v_account.daily_total - COALESCE(v_account.used, 0) - COALESCE(v_account.reserved, 0) < p_amount THEN
      RETURN jsonb_build_object(
        'ok', false,
        'code', 'ACCOUNT_QUOTA_EXHAUSTED',
        'message', 'team account quota exhausted',
        'row', row_to_json(v_account)::jsonb
      );
    END IF;
  END IF;

  UPDATE public.quota_ledger
  SET used = used + p_amount,
      remaining = GREATEST(daily_total - used - p_amount - reserved, 0),
      refreshed_at = now()
  WHERE id = v_pool.id
  RETURNING * INTO v_pool;

  IF p_account_key_id IS NOT NULL THEN
    UPDATE public.quota_ledger
    SET used = used + p_amount,
        remaining = GREATEST(daily_total - used - p_amount - reserved, 0),
        refreshed_at = now()
    WHERE id = v_account.id;
  END IF;

  INSERT INTO public.member_usage (date, team_id, user_id, used_equivalent)
  VALUES (v_today, p_team_id, v_user_id, p_amount)
  ON CONFLICT (date, team_id, user_id)
  DO UPDATE SET used_equivalent = public.member_usage.used_equivalent + EXCLUDED.used_equivalent;

  v_pool_id := v_pool.id;

  IF p_job_id IS NOT NULL THEN
    INSERT INTO public.quota_operations (job_id, ledger_id, operation_type, amount)
    VALUES (p_job_id, v_pool_id, 'finalize', p_amount)
    ON CONFLICT (job_id, operation_type) DO NOTHING;
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'code', 'CONSUMED',
    'message', 'team shared quota consumed',
    'row', row_to_json(v_pool)::jsonb,
    'quota', public.team_quota_snapshot(p_team_id, p_provider_id)
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

GRANT EXECUTE ON FUNCTION public.team_consume_quota_and_finalize(uuid, uuid, text, numeric, uuid, date, uuid) TO authenticated;

COMMENT ON FUNCTION public.team_consume_quota_and_finalize(uuid, uuid, text, numeric, uuid, date, uuid)
  IS 'Atomic team shared quota consume + member usage + quota_operations finalize. Team member only.';

-- ============ 4. admin_reset_team_quota ============
CREATE OR REPLACE FUNCTION public.admin_reset_team_quota(p_team_id UUID)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
  v_admin_id UUID := auth.uid();
  v_today DATE := (now() AT TIME ZONE 'Asia/Shanghai')::date;
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'forbidden: admin only' USING ERRCODE = '42501';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('team_quota:' || p_team_id::text || ':' || v_today::text, 0));

  UPDATE public.quota_ledger
  SET used = 0,
      remaining = daily_total,
      reserved = 0,
      refreshed_at = now()
  WHERE date = v_today
    AND team_id = p_team_id;

  UPDATE public.member_usage
  SET used_equivalent = 0
  WHERE date = v_today
    AND team_id = p_team_id;

  UPDATE public.teams
  SET status = 'active'
  WHERE id = p_team_id AND status = 'exhausted';

  INSERT INTO public.audit_logs (admin_user_id, team_id, action, target, metadata)
  VALUES (
    v_admin_id,
    p_team_id,
    'quota.reset',
    p_team_id::text,
    json_build_object('date', v_today)
  );

  RETURN json_build_object(
    'ok', true,
    'team_id', p_team_id,
    'date', v_today
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.admin_reset_team_quota(uuid) TO authenticated;

COMMENT ON FUNCTION public.admin_reset_team_quota(uuid)
  IS 'Reset today team shared quota, account ledgers, and member usage. Admin only.';

-- ============ 5. Extend admin_list_teams with quota ============
CREATE OR REPLACE FUNCTION public.admin_list_teams(
  p_search TEXT DEFAULT NULL,
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
  FROM teams t
  LEFT JOIN profiles owner ON owner.id = t.owner_id
  WHERE
    (p_search IS NULL OR p_search = '' OR t.name ILIKE '%' || p_search || '%' OR owner.email ILIKE '%' || p_search || '%' OR owner.display_name ILIKE '%' || p_search || '%')
    AND (p_status IS NULL OR p_status = '' OR t.status = p_status);

  SELECT COALESCE(json_agg(item), '[]'::json)
  INTO v_items
  FROM (
    SELECT
      t.id,
      t.name,
      t.owner_id,
      owner.email AS owner_email,
      owner.display_name AS owner_name,
      owner.status AS owner_status,
      t.plan,
      t.seats_limit,
      t.status,
      t.created_at,
      (
        SELECT count(*)
        FROM team_members tm
        WHERE tm.team_id = t.id
      ) AS member_count,
      (
        SELECT count(*)
        FROM team_members tm
        JOIN profiles mp ON mp.id = tm.user_id
        WHERE tm.team_id = t.id
          AND mp.status = 'active'
      ) AS active_member_count,
      (
        SELECT json_build_object(
          'plan', s.plan,
          'status', s.status,
          'seats', s.seats,
          'current_period_start', s.current_period_start,
          'current_period_end', s.current_period_end
        )
        FROM subscriptions s
        WHERE s.team_id = t.id
        ORDER BY s.created_at DESC
        LIMIT 1
      ) AS subscription,
      public.team_quota_snapshot(t.id, 'doubao') AS quota,
      COALESCE((SELECT SUM(COALESCE(j.equivalent_count, 0)) FROM jobs j WHERE j.team_id = t.id AND j.created_at >= date_trunc('month', now() AT TIME ZONE 'Asia/Shanghai') AT TIME ZONE 'Asia/Shanghai'), 0) AS month_usage,
      COALESCE((SELECT SUM(COALESCE(j.equivalent_count, 0)) FROM jobs j WHERE j.team_id = t.id), 0) AS total_usage,
      (SELECT count(*) FROM provider_keys pk WHERE pk.team_id = t.id) AS key_count
    FROM teams t
    LEFT JOIN profiles owner ON owner.id = t.owner_id
    WHERE
      (p_search IS NULL OR p_search = '' OR t.name ILIKE '%' || p_search || '%' OR owner.email ILIKE '%' || p_search || '%' OR owner.display_name ILIKE '%' || p_search || '%')
      AND (p_status IS NULL OR p_status = '' OR t.status = p_status)
    ORDER BY t.created_at DESC, t.id
    LIMIT p_limit OFFSET p_offset
  ) item;

  RETURN json_build_object(
    'total', v_total,
    'items', v_items
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.admin_list_teams(text, text, integer, integer) TO authenticated;

COMMENT ON FUNCTION public.admin_list_teams(text, text, integer, integer)
  IS 'Admin team list with owner, members, subscription, shared quota, usage, and key count. Admin only.';

-- ============ 6. Extend get_team_detail with quota ============
CREATE OR REPLACE FUNCTION public.get_team_detail(p_team_id UUID)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
  v_user_id UUID := auth.uid();
  v_row JSON;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'forbidden: not signed in' USING ERRCODE = '42501';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM team_members tm
    WHERE tm.team_id = p_team_id AND tm.user_id = v_user_id
  ) THEN
    RAISE EXCEPTION 'forbidden: not a team member' USING ERRCODE = '42501';
  END IF;

  SELECT json_build_object(
    'id', t.id,
    'name', t.name,
    'owner_id', t.owner_id,
    'owner_email', owner.email,
    'owner_name', owner.display_name,
    'owner_status', owner.status,
    'plan', t.plan,
    'seats_limit', t.seats_limit,
    'status', t.status,
    'created_at', t.created_at,
    'member_count', (SELECT count(*) FROM team_members tm WHERE tm.team_id = t.id),
    'active_member_count', (SELECT count(*) FROM team_members tm JOIN profiles mp ON mp.id = tm.user_id WHERE tm.team_id = t.id AND mp.status = 'active'),
    'subscription', CASE
      WHEN EXISTS (SELECT 1 FROM subscriptions s WHERE s.team_id = t.id)
      THEN (
        SELECT json_build_object(
          'plan', s.plan,
          'status', s.status,
          'seats', s.seats,
          'current_period_start', s.current_period_start,
          'current_period_end', s.current_period_end
        )
        FROM subscriptions s
        WHERE s.team_id = t.id
        ORDER BY s.created_at DESC
        LIMIT 1
      )
      ELSE NULL
    END,
    'quota', public.team_quota_snapshot(t.id, 'doubao'),
    'month_usage', COALESCE((SELECT SUM(COALESCE(j.equivalent_count, 0)) FROM jobs j WHERE j.team_id = t.id AND j.created_at >= date_trunc('month', now() AT TIME ZONE 'Asia/Shanghai') AT TIME ZONE 'Asia/Shanghai'), 0),
    'total_usage', COALESCE((SELECT SUM(COALESCE(j.equivalent_count, 0)) FROM jobs j WHERE j.team_id = t.id), 0),
    'key_count', (SELECT count(*) FROM provider_keys pk WHERE pk.team_id = t.id),
    'current_user_role', (SELECT tm.role FROM team_members tm WHERE tm.team_id = t.id AND tm.user_id = v_user_id)
  )
  INTO v_row
  FROM teams t
  LEFT JOIN profiles owner ON owner.id = t.owner_id
  WHERE t.id = p_team_id;

  IF v_row IS NULL THEN
    RAISE EXCEPTION 'team not found';
  END IF;

  RETURN json_build_object('team', v_row);
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_team_detail(uuid) TO authenticated;

COMMENT ON FUNCTION public.get_team_detail(uuid)
  IS 'Team detail for the signed-in member, including owner profile, shared quota, and usage summary.';

-- ============ 0015_team_account_scope_rpc.sql ============
-- 0015_team_account_scope_rpc.sql
-- Desktop team/account scope controls:
--   team_leave             non-owner member leaves team and unshares own team keys
--   set_provider_key_scope own provider key can be moved between personal/team scope
-- Idempotent: uses CREATE OR REPLACE FUNCTION and explicit GRANTs.

-- ============ 1. team_leave ============
CREATE OR REPLACE FUNCTION public.team_leave(p_team_id UUID)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
  v_user_id UUID := auth.uid();
  v_role TEXT;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'forbidden: not signed in' USING ERRCODE = '42501';
  END IF;

  SELECT tm.role
  INTO v_role
  FROM public.team_members tm
  WHERE tm.team_id = p_team_id
    AND tm.user_id = v_user_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'forbidden: not a team member' USING ERRCODE = '42501';
  END IF;

  IF v_role = 'admin' THEN
    RAISE EXCEPTION 'owner cannot leave team';
  END IF;

  DELETE FROM public.team_members
  WHERE team_id = p_team_id AND user_id = v_user_id;

  UPDATE public.provider_keys
  SET team_id = NULL
  WHERE owner_user_id = v_user_id
    AND team_id = p_team_id;

  RETURN json_build_object('ok', true);
END;
$$;

GRANT EXECUTE ON FUNCTION public.team_leave(uuid) TO authenticated;

COMMENT ON FUNCTION public.team_leave(uuid)
  IS 'Let a non-owner member leave a team and unshare their own provider keys for that team. Owner cannot leave.';

-- ============ 2. set_provider_key_scope ============
CREATE OR REPLACE FUNCTION public.set_provider_key_scope(
  p_key_id UUID,
  p_team_id UUID DEFAULT NULL
)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
  v_user_id UUID := auth.uid();
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'forbidden: not signed in' USING ERRCODE = '42501';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.provider_keys pk
    WHERE pk.id = p_key_id AND pk.owner_user_id = v_user_id
  ) THEN
    RAISE EXCEPTION 'forbidden: not the account owner' USING ERRCODE = '42501';
  END IF;

  IF p_team_id IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.team_members tm
      WHERE tm.team_id = p_team_id AND tm.user_id = v_user_id
    ) THEN
      RAISE EXCEPTION 'forbidden: not a member of target team' USING ERRCODE = '42501';
    END IF;

    IF NOT EXISTS (
      SELECT 1 FROM public.teams t
      WHERE t.id = p_team_id AND t.status = 'active'
    ) THEN
      RAISE EXCEPTION 'team not active';
    END IF;
  END IF;

  UPDATE public.provider_keys
  SET team_id = p_team_id
  WHERE id = p_key_id AND owner_user_id = v_user_id;

  RETURN json_build_object(
    'ok', true,
    'key_id', p_key_id,
    'team_id', p_team_id
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.set_provider_key_scope(uuid, uuid) TO authenticated;

COMMENT ON FUNCTION public.set_provider_key_scope(uuid, uuid)
  IS 'Set an owned provider key to personal (NULL team_id) or a team where the caller is a member.';

-- ============ 3. Tighten direct provider_key writes ============
DROP POLICY IF EXISTS "provider_keys_insert" ON public.provider_keys;
CREATE POLICY "provider_keys_insert" ON public.provider_keys
  FOR INSERT WITH CHECK (
    owner_user_id = auth.uid()
    AND (
      team_id IS NULL
      OR EXISTS (
        SELECT 1 FROM public.team_members tm
        WHERE tm.team_id = provider_keys.team_id
          AND tm.user_id = auth.uid()
      )
    )
  );

DROP POLICY IF EXISTS "provider_keys_update_own" ON public.provider_keys;
CREATE POLICY "provider_keys_update_own" ON public.provider_keys
  FOR UPDATE USING (owner_user_id = auth.uid())
  WITH CHECK (
    owner_user_id = auth.uid()
    AND (
      team_id IS NULL
      OR EXISTS (
        SELECT 1 FROM public.team_members tm
        WHERE tm.team_id = provider_keys.team_id
          AND tm.user_id = auth.uid()
      )
    )
  );

-- ============ 0016_provider_refresh_speed.sql ============
-- 0016_provider_refresh_speed.sql
-- Provider list refresh speed:
--   - team ledger today query index
--   - ensure_provider_ledger_rows batch-initializes today rows for many keys in one RPC
-- Idempotent: CREATE OR REPLACE + IF NOT EXISTS + explicit GRANTs.

CREATE INDEX IF NOT EXISTS idx_quota_ledger_team_date
  ON public.quota_ledger (team_id, date DESC);

CREATE OR REPLACE FUNCTION public.ensure_provider_ledger_rows(
  p_user_id UUID,
  p_team_id UUID DEFAULT NULL,
  p_key_ids UUID[] DEFAULT '{}'::uuid[]
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
  v_user_id UUID := auth.uid();
  v_today DATE := (now() AT TIME ZONE 'Asia/Shanghai')::date;
  v_rows JSON;
BEGIN
  IF v_user_id IS NULL OR p_user_id IS DISTINCT FROM v_user_id THEN
    RAISE EXCEPTION 'forbidden: not signed in' USING ERRCODE = '42501';
  END IF;

  IF p_team_id IS NULL THEN
    IF EXISTS (
      SELECT 1
      FROM public.provider_keys pk
      WHERE pk.id = ANY(p_key_ids)
        AND (pk.owner_user_id <> v_user_id OR pk.team_id IS NOT NULL)
    ) THEN
      RAISE EXCEPTION 'forbidden: personal scope only' USING ERRCODE = '42501';
    END IF;
  ELSE
    IF NOT EXISTS (
      SELECT 1
      FROM public.team_members tm
      WHERE tm.team_id = p_team_id
        AND tm.user_id = v_user_id
    ) THEN
      RAISE EXCEPTION 'forbidden: not a team member' USING ERRCODE = '42501';
    END IF;

    IF NOT EXISTS (
      SELECT 1
      FROM public.teams t
      WHERE t.id = p_team_id
        AND t.status = 'active'
    ) THEN
      RAISE EXCEPTION 'team not active';
    END IF;

    IF EXISTS (
      SELECT 1
      FROM public.provider_keys pk
      WHERE pk.id = ANY(p_key_ids)
        AND pk.team_id IS DISTINCT FROM p_team_id
    ) THEN
      RAISE EXCEPTION 'forbidden: team scope mismatch' USING ERRCODE = '42501';
    END IF;
  END IF;

  INSERT INTO public.quota_ledger (
    date,
    team_id,
    owner_user_id,
    account_key_id,
    provider_id,
    unit_name,
    daily_total,
    used,
    remaining,
    reserved
  )
  SELECT
    v_today,
    pk.team_id,
    pk.owner_user_id,
    pk.id,
    pk.provider_id,
    COALESCE(p.unit_name, '点'),
    COALESCE(pk.daily_quota, p.default_daily_quota, 0),
    0,
    COALESCE(pk.daily_quota, p.default_daily_quota, 0),
    0
  FROM public.provider_keys pk
  JOIN public.providers p ON p.id = pk.provider_id
  WHERE pk.id = ANY(p_key_ids)
    AND NOT EXISTS (
      SELECT 1
      FROM public.quota_ledger l
      WHERE l.date = v_today
        AND l.team_id IS NOT DISTINCT FROM pk.team_id
        AND l.owner_user_id IS NOT DISTINCT FROM pk.owner_user_id
        AND l.account_key_id = pk.id
        AND l.provider_id = pk.provider_id
    )
  ON CONFLICT DO NOTHING;

  SELECT COALESCE(json_agg(l ORDER BY l.account_key_id), '[]'::json)
  INTO v_rows
  FROM public.quota_ledger l
  WHERE l.date = v_today
    AND l.account_key_id = ANY(p_key_ids)
    AND l.team_id IS NOT DISTINCT FROM p_team_id;

  RETURN v_rows::jsonb;
END;
$$;

GRANT EXECUTE ON FUNCTION public.ensure_provider_ledger_rows(uuid, uuid, uuid[]) TO authenticated;

COMMENT ON FUNCTION public.ensure_provider_ledger_rows(uuid, uuid, uuid[])
  IS 'Batch-ensure today quota_ledger rows for owned personal keys or keys shared to a team the caller belongs to. Owner/team-member only.';

-- ============ 0017_team_disband_rpc.sql ============
-- 0017_team_disband_rpc.sql
-- Desktop team owner can disband a team.
-- Shared provider keys are unshared before team deletion; team-scoped ledger and
-- member usage rows are cleaned up so the team does not leave hidden stale rows.
-- Idempotent: uses CREATE OR REPLACE FUNCTION and explicit GRANTs.

CREATE OR REPLACE FUNCTION public.team_disband(p_team_id UUID)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
  v_user_id UUID := auth.uid();
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'forbidden: not signed in' USING ERRCODE = '42501';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.teams t
    WHERE t.id = p_team_id
      AND t.owner_id = v_user_id
  ) THEN
    RAISE EXCEPTION 'forbidden: only team owner can disband team' USING ERRCODE = '42501';
  END IF;

  UPDATE public.provider_keys
  SET team_id = NULL
  WHERE team_id = p_team_id;

  DELETE FROM public.quota_ledger
  WHERE team_id = p_team_id;

  DELETE FROM public.member_usage
  WHERE team_id = p_team_id;

  DELETE FROM public.teams
  WHERE id = p_team_id
    AND owner_id = v_user_id;

  RETURN json_build_object('ok', true);
END;
$$;

GRANT EXECUTE ON FUNCTION public.team_disband(uuid) TO authenticated;

COMMENT ON FUNCTION public.team_disband(uuid)
  IS 'Disband a team. Only the team owner can disband; all provider keys shared to the team are returned to personal scope.';

-- ============ 0018_audit_rpc.sql ============
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

-- ============ 0019_audit_clear_rpc.sql ============
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

-- ============ 0020_remove_mathmind.sql ============
-- 0020_remove_mathmind.sql
-- MathMind 无免费额度，移除该厂商配置；删除会级联清理 provider_keys / quota_ledger。

DELETE FROM provider_cost_tables
WHERE provider_id = 'mathmind';

DELETE FROM providers
WHERE id = 'mathmind';

-- ============ 0021_add_dola_provider.sql ============
-- 0021_add_dola_provider.sql
-- Dola 官网：https://www.dola.com/
-- 本轮接入账号绑定与文生视频；不新增 cost table。

INSERT INTO providers (id, name, logo, capabilities, auth_type, unit_name, default_daily_quota, equivalent_count_divisor)
VALUES
  (
    'dola',
    'Dola',
    'D',
    '{"supported_durations":[5,10]}'::jsonb,
    'cookie',
    '点',
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

-- ============ 0022_desktop_permissions.sql ============
-- 0022_desktop_permissions.sql
-- 桌面端权限控制：控制桌面端主 Tab 与主 Tab 下的功能开关。
-- 缺失行按“允许/开启”处理；行只记录被配置过的 feature_key。

CREATE TABLE IF NOT EXISTS public.desktop_permissions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  target_type text NOT NULL CHECK (target_type IN ('global', 'team')),
  target_id uuid NULL,
  feature_key text NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  updated_by uuid NULL REFERENCES public.profiles(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (target_type, target_id, feature_key)
);

COMMENT ON TABLE public.desktop_permissions IS
  'Desktop permission flags. target_type=global 是全局默认，target_type=team 是团队覆盖；缺失配置表示开启。feature_key 示例：tab.dispatch、dispatch.text2video、providers.bind、history.detail、history.watermark_removal、creation.watermark。';

CREATE INDEX IF NOT EXISTS idx_desktop_permissions_target
  ON public.desktop_permissions (target_type, target_id, feature_key);

CREATE INDEX IF NOT EXISTS idx_desktop_permissions_updated
  ON public.desktop_permissions (updated_at DESC);

ALTER TABLE public.desktop_permissions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "desktop_permissions_select_authenticated" ON public.desktop_permissions;
CREATE POLICY "desktop_permissions_select_authenticated"
  ON public.desktop_permissions
  FOR SELECT
  TO authenticated
  USING (
    target_type = 'global'
    OR (
      target_type = 'team'
      AND EXISTS (
        SELECT 1
        FROM public.team_members tm
        WHERE tm.team_id = desktop_permissions.target_id
          AND tm.user_id = auth.uid()
      )
    )
  );

DROP POLICY IF EXISTS "desktop_permissions_admin_all" ON public.desktop_permissions;
CREATE POLICY "desktop_permissions_admin_all"
  ON public.desktop_permissions
  FOR ALL
  TO authenticated
  USING (public.is_admin())
  WITH CHECK (public.is_admin());

ALTER TABLE public.desktop_permissions REPLICA IDENTITY FULL;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_publication
    WHERE pubname = 'supabase_realtime'
  ) AND NOT EXISTS (
    SELECT 1
    FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'desktop_permissions'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.desktop_permissions;
  END IF;
END $$;

-- ============ 0023_desktop_permissions_grant.sql ============
-- 0023_desktop_permissions_grant.sql
-- 修复 0022 未显式授权的场景：authenticated 角色读写 desktop_permissions。

GRANT ALL ON TABLE public.desktop_permissions TO authenticated;

-- 全局配置 target_id 为 null，普通 UNIQUE 约束不会阻止重复行；补一个部分唯一索引。
DELETE FROM public.desktop_permissions a
USING public.desktop_permissions b
WHERE a.target_type = 'global'
  AND b.target_type = 'global'
  AND a.feature_key = b.feature_key
  AND a.id < b.id;

DROP INDEX IF EXISTS idx_desktop_permissions_global_feature_unique;
CREATE UNIQUE INDEX IF NOT EXISTS idx_desktop_permissions_global_feature_unique
  ON public.desktop_permissions (target_type, feature_key)
  WHERE target_type = 'global';

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_publication
    WHERE pubname = 'supabase_realtime'
  ) AND NOT EXISTS (
    SELECT 1
    FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'desktop_permissions'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.desktop_permissions;
  END IF;
END $$;

-- ============ 0024_creation_videos.sql ============
-- 0024_creation_videos.sql
-- 桌面端创作中心「视频灵感库」：由 Admin 运营管理，普通登录用户只读 enabled=true。

CREATE TABLE IF NOT EXISTS public.creation_videos (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title text NOT NULL,
  cover_url text NOT NULL,
  video_url text,
  duration_sec integer NOT NULL DEFAULT 5,
  category text NOT NULL,
  tags text[] NOT NULL DEFAULT '{}',
  prompt text NOT NULL,
  provider_hint text,
  enabled boolean NOT NULL DEFAULT true,
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_creation_videos_category
  ON public.creation_videos (category);

CREATE INDEX IF NOT EXISTS idx_creation_videos_enabled
  ON public.creation_videos (enabled);

CREATE INDEX IF NOT EXISTS idx_creation_videos_sort_order
  ON public.creation_videos (sort_order);

CREATE INDEX IF NOT EXISTS idx_creation_videos_updated_at
  ON public.creation_videos (updated_at DESC);

COMMENT ON TABLE public.creation_videos IS
  '创作中心视频灵感库：管理员维护的优秀视频案例、参考提示词与分类。';

ALTER TABLE public.creation_videos ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "creation_videos_select_enabled" ON public.creation_videos;
CREATE POLICY "creation_videos_select_enabled"
  ON public.creation_videos
  FOR SELECT
  TO authenticated
  USING (enabled = true);

DROP POLICY IF EXISTS "creation_videos_admin_all" ON public.creation_videos;
CREATE POLICY "creation_videos_admin_all"
  ON public.creation_videos
  FOR ALL
  TO authenticated
  USING (public.is_admin())
  WITH CHECK (public.is_admin());

GRANT ALL ON TABLE public.creation_videos TO authenticated;

ALTER TABLE public.creation_videos REPLICA IDENTITY FULL;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_publication
    WHERE pubname = 'supabase_realtime'
  ) AND NOT EXISTS (
    SELECT 1
    FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'creation_videos'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.creation_videos;
  END IF;
END $$;

-- 桌面端第一版本地样例一次性 seed；ON CONFLICT 避免覆盖后续管理端修改。
INSERT INTO public.creation_videos (
  id,
  title,
  cover_url,
  video_url,
  duration_sec,
  category,
  tags,
  prompt,
  provider_hint,
  enabled,
  sort_order
)
VALUES
  (
    '00000000-0000-0000-0000-000000000001',
    '雪后山巅少年剑客',
    'https://images.unsplash.com/photo-1533106418989-88406c7cc8ca?auto=format&fit=crop&w=640&q=80',
    NULL,
    10,
    '国漫3D风',
    ARRAY['国漫3D', '雪山', '云海'],
    '高规格国漫3D风格，少年剑客站在雪后山巅，衣摆随风翻飞，远处云海翻涌，镜头从正面缓慢推进，金色晨光穿透云层照亮剑锋。',
    '豆包 · Seedance 2.0 Mini',
    true,
    10
  ),
  (
    '00000000-0000-0000-0000-000000000002',
    '雨夜霓虹巷战',
    'https://images.unsplash.com/photo-1519681393784-d120267933ba?auto=format&fit=crop&w=640&q=80',
    NULL,
    5,
    '动作打斗',
    ARRAY['打斗', '雨夜', '慢镜头'],
    '高速动作打斗，雨夜巷战，两道人影在霓虹灯光下贴身交锋，慢镜头捕捉拳脚与雨滴碰撞，镜头快速切换，压迫感强。',
    '可灵 · 标准',
    true,
    20
  ),
  (
    '00000000-0000-0000-0000-000000000003',
    '霓虹雨幕天桥',
    'https://images.unsplash.com/photo-1519608487953-e999c86e7455?auto=format&fit=crop&w=640&q=80',
    NULL,
    10,
    '赛博都市',
    ARRAY['赛博朋克', '城市夜景', '全息广告'],
    '赛博都市夜景，巨型全息广告在雨幕中闪烁，主角撑伞穿过拥挤天桥，霓虹色彩反射在积水路面，航拍缓慢拉升。',
    '豆包 · Seedance 2.0 Mini',
    true,
    30
  ),
  (
    '00000000-0000-0000-0000-000000000004',
    '白衣仙人御剑过云海',
    'https://images.unsplash.com/photo-1500530855697-b586d89ba3ee?auto=format&fit=crop&w=640&q=80',
    NULL,
    5,
    '古风仙侠',
    ARRAY['仙侠', '御剑', '云海'],
    '古风仙侠意境，白衣仙人御剑飞过云海，衣袂飘动，瀑布从青翠山崖倾泻，镜头围绕仙人环绕半周。',
    '千问 · 万相',
    true,
    40
  ),
  (
    '00000000-0000-0000-0000-000000000005',
    '午后窗台的小猫',
    'https://images.unsplash.com/photo-1514888286974-6c03e2ca1dba?auto=format&fit=crop&w=640&q=80',
    NULL,
    5,
    '治愈系',
    ARRAY['治愈', '猫咪', '阳光'],
    '治愈系田园短片，小猫在午后窗台伸懒腰，阳光洒进房间，窗帘随风轻摆，镜头缓慢靠近猫爪，画面温暖柔光。',
    '海螺 · 标准',
    true,
    50
  ),
  (
    '00000000-0000-0000-0000-000000000006',
    '黄昏停机坪的机甲少女',
    'https://images.unsplash.com/photo-1528459801416-a9e53bbf4e17?auto=format&fit=crop&w=640&q=80',
    NULL,
    10,
    '国漫3D风',
    ARRAY['国漫3D', '机甲', '黄昏'],
    '国漫3D风战斗前奏，少女机甲在黄昏停机坪单膝落地，装甲表面亮起蓝色能量纹路，镜头低角度环绕展示细节。',
    '豆包 · Seedance 2.0 Mini',
    true,
    60
  ),
  (
    '00000000-0000-0000-0000-000000000007',
    '悬浮载具追车',
    'https://images.unsplash.com/photo-1550745165-9bc0b252726f?auto=format&fit=crop&w=640&q=80',
    NULL,
    10,
    '赛博都市',
    ARRAY['追车', '悬浮载具', '光轨'],
    '科幻城市追车戏，悬浮载具贴着高架桥高速穿行，车灯拖出光轨，镜头跟拍并切换俯冲视角，城市灯火快速掠过。',
    '可灵 · 大师',
    true,
    70
  ),
  (
    '00000000-0000-0000-0000-000000000008',
    '竹林红袖剑气',
    'https://images.unsplash.com/photo-1541701494587-cb58502866ab?auto=format&fit=crop&w=640&q=80',
    NULL,
    5,
    '古风仙侠',
    ARRAY['古风', '剑气', '竹海'],
    '古风仙侠，林间竹海起雾，女子红袖掠过竹叶，剑气切开雾气，镜头跟随红色衣袂穿行，风起叶落。',
    '千问 · 万相',
    true,
    80
  ),
  (
    '00000000-0000-0000-0000-000000000009',
    '雨天咖啡馆窗边',
    'https://images.unsplash.com/photo-1509042239860-f550ce710b93?auto=format&fit=crop&w=640&q=80',
    NULL,
    5,
    '治愈系',
    ARRAY['治愈', '咖啡馆', '雨天'],
    '治愈系动画，雨天咖啡馆窗边，热咖啡升起白雾，小猫趴在桌角看雨滴滑落，镜头缓慢推近，色调温柔安静。',
    '海螺 · 标准',
    true,
    90
  )
ON CONFLICT (id) DO NOTHING;

-- ============ 0025_feedback.sql ============
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

-- ============ 0026_add_chatglm_provider.sql ============
-- 0026_add_chatglm_provider.sql
-- 智谱清言（chatglm.cn）账号绑定 seed；本轮不接入视频生成，capabilities 暂留空。
-- Idempotent：重复执行只更新 seed 字段，不重复插入。

INSERT INTO providers (id, name, logo, capabilities, auth_type, unit_name, default_daily_quota, equivalent_count_divisor)
VALUES
  (
    'chatglm',
    '智谱清言',
    '清',
    '{}'::jsonb,
    'cookie',
    '次',
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

-- ============ 0027_add_zhipu_provider.sql ============
-- 0027_add_zhipu_provider.sql
-- 智谱（bigmodel.cn）账号绑定 seed：API Key 登录，非网页 cookie 登录。
-- apikey 型厂商「额度单位 / 默认日额度 / 等效除数」不在 Admin 端手工填写，
-- 额度由接入层自动核算（智谱免费模型 cogvideox-flash 无公开余额接口，走每日账本 daily_total）。
-- 视频模型定价（2026-08 实测）：
--   cogvideox-flash: 免费（usage=0，公测不扣费）
--   cogvideox-2: 付费 ¥0.5/次（按量计费，按次扣费而非 token）
--   cogvideox-3: 付费 ¥1/次
-- Idempotent：重复执行只更新 seed 字段，不重复插入。

INSERT INTO providers (id, name, logo, capabilities, auth_type, unit_name, default_daily_quota, equivalent_count_divisor)
VALUES
  (
    'zhipu',
    '智谱（bigmodel）',
    '智',
    '{"models":[
      {"id":"cogvideox-flash","modes":["text2video","img2video"],"free":true,"price":"免费"},
      {"id":"cogvideox-2","modes":["text2video","img2video"],"free":false,"price":"¥0.5/次"},
      {"id":"cogvideox-3","modes":["text2video","img2video"],"free":false,"price":"¥1/次"}
    ]}'::jsonb,
    'apikey',
    '次',
    50,
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

-- ============ 0028_qf_images_storage.sql ============
-- 0028_qf_images_storage.sql
-- Public storage bucket for user-uploaded video-generating reference images.
-- 说明：智谱等开放平台 API 要求 image_url 必须是可公网访问的 http(s) 地址，
--       因此存储桶设为 public，生成 https 公开 URL 后透传给厂商。
-- Idempotent: run in Supabase SQL Editor or via migration runner.

INSERT INTO storage.buckets (id, name, public)
VALUES ('qf-images', 'qf-images', TRUE)
ON CONFLICT (id) DO UPDATE SET public = TRUE;

-- 公开读：厂商服务端可直接拉取 https URL
DROP POLICY IF EXISTS "qf-images public read" ON storage.objects;
CREATE POLICY "qf-images public read"
  ON storage.objects
  FOR SELECT
  USING (bucket_id = 'qf-images');

-- 写入：仅登录用户，且只能写入自己目录（第一段 = auth.uid()）
-- 约定路径: <uid>/<uuid>.<ext>
DROP POLICY IF EXISTS "qf-images owner insert" ON storage.objects;
CREATE POLICY "qf-images owner insert"
  ON storage.objects
  FOR INSERT
  TO authenticated
  WITH CHECK (
    bucket_id = 'qf-images'
    AND (storage.foldername(name))[1] = auth.uid()::text
  );

DROP POLICY IF EXISTS "qf-images owner update" ON storage.objects;
CREATE POLICY "qf-images owner update"
  ON storage.objects
  FOR UPDATE
  TO authenticated
  USING (
    bucket_id = 'qf-images'
    AND (storage.foldername(name))[1] = auth.uid()::text
  )
  WITH CHECK (
    bucket_id = 'qf-images'
    AND (storage.foldername(name))[1] = auth.uid()::text
  );

DROP POLICY IF EXISTS "qf-images owner delete" ON storage.objects;
CREATE POLICY "qf-images owner delete"
  ON storage.objects
  FOR DELETE
  TO authenticated
  USING (
    bucket_id = 'qf-images'
    AND (storage.foldername(name))[1] = auth.uid()::text
  );

GRANT USAGE ON SCHEMA storage TO authenticated;
GRANT ALL ON storage.objects TO authenticated;

-- ============ 0029_add_zhipu_vidu_models.sql ============
-- 0029_add_zhipu_vidu_models.sql
-- 智谱（bigmodel）扩展视频模型：新增 Vidu Q1 / Vidu 2，并补全 cogvideox-3 的首尾帧模式。
-- Vidu Q1/Vidu 2 为统一模型，具体文生/图生/首尾帧/参考生模式在「生成模式」下拉选择，
-- 调度时由 api-branch 的 ZHIPU_API_MODEL 映射为实际 API 子模型（viduq1-*/vidu2-*）。
-- Idempotent：重复执行只更新 capabilities 字段，不重复插入。

UPDATE providers
SET capabilities = '{"models":[
  {"id":"cogvideox-flash","modes":["text2video","img2video"],"free":true,"price":"免费"},
  {"id":"cogvideox-2","modes":["text2video","img2video"],"free":false,"price":"¥0.5/次"},
  {"id":"cogvideox-3","modes":["text2video","img2video","first_last"],"free":false,"price":"¥1/次"},
  {"id":"Vidu Q1","modes":["text2video","img2video","first_last"],"free":false,"price":"¥2.5/次"},
  {"id":"Vidu 2","modes":["img2video","first_last","multi_ref"],"free":false,"price":"¥1.25/次起"}
]}'::jsonb
WHERE id = 'zhipu';

-- ============ 0030_provider_caps.sql ============
-- 0030_provider_caps.sql
-- 桌面端厂商「生成能力」控制：控制每个厂商在调度台可选的视频生成模式（modes）与模型（models）。
-- 缺行（global 与团队均无该 provider 记录）按「使用桌面端硬编码默认」处理；
-- 一行存在即该 provider 在该 scope 的【唯一可选项】，空数组 = 屏蔽该厂商全部模式/模型。
-- target_type=global 是全局默认，target_type=team 是团队覆盖（即使为空也覆盖全局）。

CREATE TABLE IF NOT EXISTS public.provider_caps (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  target_type text NOT NULL CHECK (target_type IN ('global', 'team')),
  target_id uuid NULL,                     -- global 为 null；team 为 team.id
  provider text NOT NULL,                  -- providers.id，如 doubao/zhipu
  modes text[] NOT NULL DEFAULT '{}',      -- 该厂商允许的视频生成模式集合
  models text[] NOT NULL DEFAULT '{}',     -- 该厂商允许的模型集合
  updated_by uuid NULL REFERENCES public.profiles(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (target_type, target_id, provider)
);

COMMENT ON TABLE public.provider_caps IS
  'Desktop provider generation caps. target_type=global 是全局默认，target_type=team 是团队覆盖；缺行表示使用桌面端默认，存在则 modes/models 为唯一可选项，空数组表示屏蔽。modes 扁平键示例：text2video/img2video/multi_ref/first_last/first_frame。';

CREATE INDEX IF NOT EXISTS idx_provider_caps_target
  ON public.provider_caps (target_type, target_id, provider);

CREATE INDEX IF NOT EXISTS idx_provider_caps_updated
  ON public.provider_caps (updated_at DESC);

ALTER TABLE public.provider_caps ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "provider_caps_select_authenticated" ON public.provider_caps;
CREATE POLICY "provider_caps_select_authenticated"
  ON public.provider_caps
  FOR SELECT
  TO authenticated
  USING (
    target_type = 'global'
    OR (
      target_type = 'team'
      AND EXISTS (
        SELECT 1
        FROM public.team_members tm
        WHERE tm.team_id = provider_caps.target_id
          AND tm.user_id = auth.uid()
      )
    )
  );

DROP POLICY IF EXISTS "provider_caps_admin_all" ON public.provider_caps;
CREATE POLICY "provider_caps_admin_all"
  ON public.provider_caps
  FOR ALL
  TO authenticated
  USING (public.is_admin())
  WITH CHECK (public.is_admin());

-- 表级权限：authenticated 需显式授权（仅配置 RLS 策略不够，否则 PostgREST 报 permission denied for table）
GRANT ALL ON TABLE public.provider_caps TO authenticated;

ALTER TABLE public.provider_caps REPLICA IDENTITY FULL;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_publication
    WHERE pubname = 'supabase_realtime'
  ) AND NOT EXISTS (
    SELECT 1
    FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'provider_caps'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.provider_caps;
  END IF;
END $$;

-- ============ 0031_add_volcengine_provider.sql ============
-- 0031_add_volcengine_provider.sql
-- 火山方舟（火山引擎 ARK）账号绑定 seed：API Key 登录，非网页 cookie 登录。
-- apikey 型厂商「额度单位 / 默认日额度 / 等效除数」不在 Admin 端手工填写，
-- 额度由接入层自动核算；火山方舟本轮尚未探测到控制台真实额度接口（见方案 §6），先走每日账本 daily_total。
-- 免费视频模型目录（2026-08-19 实测，有免费推理额度）：Seedance 1.0-pro / 1.5-pro / 1.0-pro-fast，
--   Model ID 为平台固定值，写入 capabilities.models 作为厂商级权威清单（与桌面 spec.ts 的 MODELS.volcengine 镜像）。
-- 说明：1.0-lite-t2v/i2v 虽在开通管理页显示免费额度，官方文档未收录 Model ID，本轮不接入。
-- Idempotent：重复执行只更新 seed 字段，不重复插入。

INSERT INTO providers (id, name, logo, capabilities, auth_type, unit_name, default_daily_quota, equivalent_count_divisor)
VALUES
  (
    'volcengine',
    '火山方舟',
    '火',
    '{"models":[
      {"id":"doubao-seedance-1-0-pro-250528","modes":["text2video","img2video"],"free":true,"price":"免费"},
      {"id":"doubao-seedance-1-5-pro-251215","modes":["text2video","img2video"],"free":true,"price":"免费"},
      {"id":"doubao-seedance-1-0-pro-fast-251015","modes":["text2video","img2video"],"free":true,"price":"免费"}
    ]}'::jsonb,
    'apikey',
    '次',
    50,
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

-- ============ 0032_provider_caps_volcengine.sql ============
-- 0032_provider_caps_volcengine.sql
-- 火山方舟（volcengine）「生成能力」全局登记：把「绑定即抓模型」抓取到的免费视频模型
-- 关联到 provider_caps（global 作用域），使调度台 / Dashboard 把火山方舟限定为这组免费模型与模式。
-- 模型清单为平台固定值（2026-08-19 实测，见 docs/厂商与API平台接入/火山方舟免费视频模型额度对接.md），
-- 与 spec.ts 的 MODELS.volcengine、providers.capabilities.models 三者保持一致（厂商级 Catalog）。
-- provider_caps 语义：global 行存在即作为该 provider 的唯一可选项，空数组=屏蔽；此处给出免费模型白名单。
-- 注意 target_id 为 NULL：Postgres UNIQUE 对 NULL 各自独立，不能依赖 ON CONFLICT 幂等，故用 存在则更 / 否则插。

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.provider_caps
    WHERE target_type = 'global' AND target_id IS NULL AND provider = 'volcengine'
  ) THEN
    UPDATE public.provider_caps
    SET modes = ARRAY['text2video','img2video'],
        models = ARRAY['doubao-seedance-1-0-pro-250528','doubao-seedance-1-5-pro-251215','doubao-seedance-1-0-pro-fast-251015','doubao-seedance-1-0-lite-t2v','doubao-seedance-1-0-lite-i2v'],
        updated_at = now()
    WHERE target_type = 'global' AND target_id IS NULL AND provider = 'volcengine';
  ELSE
    INSERT INTO public.provider_caps (target_type, target_id, provider, modes, models)
    VALUES (
      'global', NULL, 'volcengine',
      ARRAY['text2video','img2video'],
      ARRAY['doubao-seedance-1-0-pro-250528','doubao-seedance-1-5-pro-251215','doubao-seedance-1-0-pro-fast-251015','doubao-seedance-1-0-lite-t2v','doubao-seedance-1-0-lite-i2v']
    );
  END IF;
END $$;

-- ============ 0033_volcengine_lite_model_ids.sql ============
-- 0033_volcengine_lite_model_ids.sql
-- 修正火山方舟（volcengine）provider_caps 免费视频模型目录：lite 系列官方 Model ID 带 -250428 日期后缀
-- （doubao-seedance-1-0-lite-t2v-250428 / doubao-seedance-1-0-lite-i2v-250428），且 t2v/i2v 为两个独立 ID。
-- 与 spec.ts 的 MODELS.volcengine、providers/caps catalog 保持一致（厂商级 Catalog）。
-- provider_caps 语义、NULL target_id 幂等方式同 0032。

UPDATE public.provider_caps
SET models = ARRAY[
      'doubao-seedance-1-0-pro-250528',
      'doubao-seedance-1-5-pro-251215',
      'doubao-seedance-1-0-pro-fast-251015',
      'doubao-seedance-1-0-lite-t2v-250428',
      'doubao-seedance-1-0-lite-i2v-250428'
    ],
    updated_at = now()
WHERE target_type = 'global' AND target_id IS NULL AND provider = 'volcengine';

-- ============ 0034_add_bailian_provider.sql ============
-- 0034_add_bailian_provider.sql
-- 阿里云百炼（Model Studio）账号绑定 seed：API Key 登录，非网页 cookie 登录。
-- apikey 型厂商「额度单位 / 默认日额度 / 等效除数」不在 Admin 端手工填写，额度由接入层自动核算。
-- 首期（2026-08-20）只做绑定 + 测试 + 去重；真实免费额度在控制台 costing-balance/free-quota 页（业务空间维度），
--   需控制台会话捕获，作为后续迭代（见 docs/厂商与API平台接入/阿里云百炼接入方案.md）。本期实际额度走每日账本 daily_total。
-- 视频模型目录（wan2.7-t2v 文生 / wan2.7-i2v 图生）暂不写入 capabilities：模型能力延后，首期 models 留空。
-- Idempotent：重复执行只更新 seed 字段，不重复插入。

INSERT INTO providers (id, name, logo, capabilities, auth_type, unit_name, default_daily_quota, equivalent_count_divisor)
VALUES
  (
    'bailian',
    '阿里云百炼',
    '炼',
    '{"models":[]}'::jsonb,
    'apikey',
    '次',
    50,
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

-- ============ 0035_admin_dashboard.sql ============
-- 0035_admin_dashboard.sql
-- Admin 系统监控（Dashboard）聚合数据源：
--   1. monitor_alert_rules 告警阈值配置表（可配置）+ 种子
--   2. KPI / 趋势 / 厂商健康 / 告警 聚合 RPC（SECURITY DEFINER + is_admin）
-- 幂等：CREATE TABLE IF NOT EXISTS / CREATE OR REPLACE FUNCTION / DROP POLICY IF EXISTS。

-- ============ 1. 告警阈值配置表 ============
CREATE TABLE IF NOT EXISTS monitor_alert_rules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  alert_type TEXT NOT NULL CHECK (alert_type IN ('failure_rate', 'cost_deviation', 'cron_delay')),
  provider_id TEXT NULL REFERENCES providers(id) ON DELETE CASCADE, -- NULL = 全局默认
  threshold NUMERIC NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- 全局规则（provider_id IS NULL）每个 alert_type 唯一（普通 UNIQUE 对 NULL 不生效）
CREATE UNIQUE INDEX IF NOT EXISTS idx_monitor_alert_rules_global_unique
  ON monitor_alert_rules (alert_type) WHERE provider_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_monitor_alert_rules_provider_unique
  ON monitor_alert_rules (alert_type, provider_id) WHERE provider_id IS NOT NULL;

ALTER TABLE monitor_alert_rules ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "monitor_alert_rules_admin_all" ON monitor_alert_rules;
CREATE POLICY "monitor_alert_rules_admin_all" ON monitor_alert_rules
  FOR ALL USING (public.is_admin()) WITH CHECK (public.is_admin());

GRANT ALL ON TABLE monitor_alert_rules TO authenticated;

-- 种子（幂等：不存在才插入；IS NOT DISTINCT FROM 处理 NULL 相等）
INSERT INTO monitor_alert_rules (alert_type, provider_id, threshold, enabled)
SELECT v.alert_type, v.provider_id, v.threshold, v.enabled
FROM (VALUES
  ('failure_rate'::text, NULL::text, 30::numeric, true),
  ('cost_deviation'::text, NULL::text, 20::numeric, true),
  ('cron_delay'::text, NULL::text, 24::numeric, true)
) AS v(alert_type, provider_id, threshold, enabled)
WHERE NOT EXISTS (
  SELECT 1 FROM monitor_alert_rules r
  WHERE r.alert_type = v.alert_type
    AND r.provider_id IS NOT DISTINCT FROM v.provider_id
);

-- ============ 2. KPI 聚合 ============
CREATE OR REPLACE FUNCTION public.admin_dashboard_kpis()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, auth
AS $$
  SELECT jsonb_build_object(
    'active_teams', (SELECT count(*) FROM teams WHERE status = 'active'),
    'registered_users', (SELECT count(*) FROM profiles),
    'today_calls', (
      SELECT count(*) FROM jobs
      WHERE created_at >= (date_trunc('day', now() AT TIME ZONE 'Asia/Shanghai')) AT TIME ZONE 'Asia/Shanghai'
    ),
    'avg_response_ms', (
      SELECT round(avg(extract(epoch FROM (completed_at - created_at)) * 1000))::int
      FROM jobs
      WHERE status = 'success' AND completed_at IS NOT NULL AND created_at IS NOT NULL
    )
  );
$$;

GRANT EXECUTE ON FUNCTION public.admin_dashboard_kpis() TO authenticated;

-- ============ 3. 调用量趋势（按 date 聚合 success / failed） ============
CREATE OR REPLACE FUNCTION public.admin_dashboard_trends(p_days integer)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, auth
AS $$
  SELECT COALESCE(jsonb_agg(item ORDER BY item->>'date'), '[]'::jsonb)
  FROM (
    SELECT jsonb_build_object(
      'date', (j.created_at AT TIME ZONE 'Asia/Shanghai')::date,
      'success', count(*) FILTER (WHERE j.status = 'success'),
      'failed', count(*) FILTER (WHERE j.status IN ('failed', 'not_generated'))
    ) AS item
    FROM jobs j
    WHERE j.created_at >= (date_trunc('day', now() AT TIME ZONE 'Asia/Shanghai') - (p_days - 1) * interval '1 day') AT TIME ZONE 'Asia/Shanghai'
    GROUP BY (j.created_at AT TIME ZONE 'Asia/Shanghai')::date
  ) t;
$$;

GRANT EXECUTE ON FUNCTION public.admin_dashboard_trends(integer) TO authenticated;

-- ============ 4. 厂商健康（近 N 小时成功率） ============
CREATE OR REPLACE FUNCTION public.admin_dashboard_provider_health(p_hours integer)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, auth
AS $$
  SELECT COALESCE(jsonb_agg(item ORDER BY item->>'provider_id'), '[]'::jsonb)
  FROM (
    SELECT jsonb_build_object(
      'provider_id', p.id,
      'name', p.name,
      'total', count(j.id),
      'success', count(j.id) FILTER (WHERE j.status = 'success'),
      'failed', count(j.id) FILTER (WHERE j.status = 'failed'),
      'success_rate', CASE
        WHEN count(j.id) > 0
        THEN round((count(j.id) FILTER (WHERE j.status = 'success'))::numeric / count(j.id) * 100, 1)
        ELSE NULL
      END
    ) AS item
    FROM providers p
    LEFT JOIN jobs j
      ON j.provider_id = p.id
     AND j.created_at >= now() - make_interval(hours => p_hours)
    GROUP BY p.id, p.name
  ) t;
$$;

GRANT EXECUTE ON FUNCTION public.admin_dashboard_provider_health(integer) TO authenticated;

-- ============ 4.5 Supabase 用量（真实测量；免费层配额为外部动态值，不下发/不写死） ============
CREATE OR REPLACE FUNCTION public.admin_dashboard_supabase_usage()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
  v_db_bytes bigint := NULL;
  v_storage_bytes bigint := NULL;
  v_mau bigint := 0;
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'forbidden: admin only' USING ERRCODE = '42501';
  END IF;

  -- 数据库占用：真实字节数
  BEGIN
    SELECT pg_database_size(current_database()) INTO v_db_bytes;
  EXCEPTION WHEN OTHERS THEN
    v_db_bytes := NULL;
  END;

  -- MAU：近 30 天有生成记录的独立用户
  SELECT count(DISTINCT user_id) INTO v_mau
  FROM jobs
  WHERE user_id IS NOT NULL
    AND created_at >= now() - interval '30 days';

  -- 存储占用：storage.objects 元数据 size 求和（扩展/权限不足时降级 null）
  BEGIN
    EXECUTE $st$
      SELECT COALESCE(sum(COALESCE((metadata->>'size')::bigint, 0)), 0)
      FROM storage.objects
    $st$ INTO v_storage_bytes;
  EXCEPTION WHEN OTHERS THEN
    v_storage_bytes := NULL;
  END;

  RETURN jsonb_build_object(
    'db_size_bytes', v_db_bytes,
    'mau', v_mau,
    'storage_bytes', v_storage_bytes
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.admin_dashboard_supabase_usage() TO authenticated;

-- ============ 5. 活跃告警（失败率 / 消耗偏离 / cron） ============
-- 口径说明：
--   failure_rate: 近 1h failed/(success+failed) 超阈值（最小样本 5 条防误报）
--   cost_deviation: 近 24h 实际扣减(cost_amount) 与 消耗表理论值(该 provider 平均 unit_cost × 完成数) 的偏离
--   cron_delay: active cron 任务「近 N 小时有失败运行」或「从未运行」（精确解析调度周期需解析 cron 表达式，故退化为可观测事实）
-- 阈值读 monitor_alert_rules，per-provider 优先、全局兜底。
CREATE OR REPLACE FUNCTION public.admin_dashboard_alerts()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
  v_alerts jsonb := '[]'::jsonb;
  v_cron jsonb;
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'forbidden: admin only' USING ERRCODE = '42501';
  END IF;

  -- (a) failure_rate
  v_alerts := v_alerts || (
    SELECT COALESCE(jsonb_agg(item), '[]'::jsonb)
    FROM (
      SELECT jsonb_build_object(
        'type', 'failure_rate',
        'provider_id', f.provider_id,
        'provider_name', p.name,
        'level', CASE WHEN f.rate > COALESCE(rp.threshold, rg.threshold, 30) + 10 THEN 'danger' ELSE 'warning' END,
        'value', round(f.rate::numeric, 1),
        'threshold', COALESCE(rp.threshold, rg.threshold, 30),
        'created_at', now()
      ) AS item
      FROM (
        SELECT
          j.provider_id,
          (count(*) FILTER (WHERE j.status = 'failed'))::numeric
            / NULLIF(count(*) FILTER (WHERE j.status IN ('success', 'failed')), 0) * 100 AS rate,
          count(*) FILTER (WHERE j.status IN ('success', 'failed')) AS total
        FROM jobs j
        WHERE j.created_at >= now() - interval '1 hour'
          AND j.provider_id IS NOT NULL
        GROUP BY j.provider_id
      ) f
      JOIN providers p ON p.id = f.provider_id
      LEFT JOIN monitor_alert_rules rp ON rp.alert_type = 'failure_rate' AND rp.enabled AND rp.provider_id = f.provider_id
      LEFT JOIN monitor_alert_rules rg ON rg.alert_type = 'failure_rate' AND rg.enabled AND rg.provider_id IS NULL
      WHERE f.total >= 5
        AND f.rate > COALESCE(rp.threshold, rg.threshold, 30)
    ) t
  );

  -- (b) cost_deviation
  v_alerts := v_alerts || (
    SELECT COALESCE(jsonb_agg(item), '[]'::jsonb)
    FROM (
      SELECT jsonb_build_object(
        'type', 'cost_deviation',
        'provider_id', d.provider_id,
        'provider_name', p.name,
        'level', CASE WHEN d.deviation > COALESCE(rp.threshold, rg.threshold, 20) + 10 THEN 'warning' ELSE 'info' END,
        'value', d.deviation,
        'threshold', COALESCE(rp.threshold, rg.threshold, 20),
        'created_at', now()
      ) AS item
      FROM (
        SELECT
          c.provider_id,
          round(abs(c.actual - c.theory) / NULLIF(c.theory, 0) * 100, 1) AS deviation
        FROM (
          SELECT
            j.provider_id,
            COALESCE(sum(j.cost_amount) FILTER (WHERE j.cost_amount > 0), 0) AS actual,
            (
              SELECT COALESCE(avg(ct.unit_cost), 0)
              FROM provider_cost_tables ct
              WHERE ct.provider_id = j.provider_id
            ) * count(*) FILTER (WHERE j.status IN ('success', 'failed')) AS theory
          FROM jobs j
          WHERE j.created_at >= now() - interval '24 hours'
            AND j.provider_id IS NOT NULL
            AND j.cost_amount > 0
          GROUP BY j.provider_id
        ) c
        WHERE c.actual > 0 AND c.theory > 0
      ) d
      JOIN providers p ON p.id = d.provider_id
      LEFT JOIN monitor_alert_rules rp ON rp.alert_type = 'cost_deviation' AND rp.enabled AND rp.provider_id = d.provider_id
      LEFT JOIN monitor_alert_rules rg ON rg.alert_type = 'cost_deviation' AND rg.enabled AND rg.provider_id IS NULL
      WHERE d.deviation > COALESCE(rp.threshold, rg.threshold, 20)
    ) t
  );

  -- (c) cron_delay：动态读取 cron schema，扩展未启用时降级为空数组
  BEGIN
    EXECUTE $cron$
      SELECT COALESCE(jsonb_agg(item), '[]'::jsonb)
      FROM (
        SELECT jsonb_build_object(
          'type', 'cron_delay',
          'provider_id', NULL,
          'provider_name', c.jobname,
          'level', CASE WHEN c.failed > 0 THEN 'warning' ELSE 'info' END,
          'value', c.failed,
          'threshold', COALESCE(r.threshold, 24),
          'created_at', now()
        ) AS item
        FROM (
          SELECT
            j.jobname,
            (j.last_run IS NULL) AS never_run,
            (
              SELECT count(*)
              FROM cron.job_run_details d
              WHERE d.jobid = j.jobid
                AND d.status <> 'succeeded'
                AND d.start_time >= now() - make_interval(hours => COALESCE(r.threshold::int, 24))
            ) AS failed
          FROM cron.job j
        ) c
        CROSS JOIN (
          SELECT threshold FROM monitor_alert_rules
          WHERE alert_type = 'cron_delay' AND enabled AND provider_id IS NULL
          ORDER BY updated_at DESC LIMIT 1
        ) r
        WHERE c.failed > 0 OR c.never_run
      ) t
    $cron$ INTO v_cron;
  EXCEPTION WHEN OTHERS THEN
    v_cron := '[]'::jsonb;
  END;

  v_alerts := v_alerts || COALESCE(v_cron, '[]'::jsonb);

  RETURN v_alerts;
END;
$$;

GRANT EXECUTE ON FUNCTION public.admin_dashboard_alerts() TO authenticated;

-- ============ 6. 阈值配置读写 ============
CREATE OR REPLACE FUNCTION public.admin_get_alert_rules()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, auth
AS $$
  SELECT COALESCE(jsonb_agg(item ORDER BY item->>'alert_type', item->>'provider_id'), '[]'::jsonb)
  FROM (
    SELECT jsonb_build_object(
      'id', id,
      'alert_type', alert_type,
      'provider_id', provider_id,
      'threshold', threshold,
      'enabled', enabled
    ) AS item
    FROM monitor_alert_rules
  ) t;
$$;

GRANT EXECUTE ON FUNCTION public.admin_get_alert_rules() TO authenticated;

CREATE OR REPLACE FUNCTION public.admin_upsert_alert_rule(
  p_alert_type text,
  p_provider_id text,
  p_threshold numeric,
  p_enabled boolean
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'forbidden: admin only' USING ERRCODE = '42501';
  END IF;

  IF p_alert_type IS NULL OR p_alert_type NOT IN ('failure_rate', 'cost_deviation', 'cron_delay') THEN
    RAISE EXCEPTION 'invalid alert_type';
  END IF;

  IF p_threshold IS NULL OR p_threshold < 0 THEN
    RAISE EXCEPTION 'threshold must be >= 0';
  END IF;

  UPDATE monitor_alert_rules
  SET threshold = p_threshold, enabled = p_enabled, updated_at = now()
  WHERE alert_type = p_alert_type
    AND provider_id IS NOT DISTINCT FROM p_provider_id;

  IF NOT FOUND THEN
    INSERT INTO monitor_alert_rules (alert_type, provider_id, threshold, enabled)
    VALUES (p_alert_type, p_provider_id, p_threshold, p_enabled);
  END IF;

  RETURN jsonb_build_object('ok', true);
END;
$$;

GRANT EXECUTE ON FUNCTION public.admin_upsert_alert_rule(text, text, numeric, boolean) TO authenticated;

-- ============ 0036_add_tokenhub_provider.sql ============
-- 0036_add_tokenhub_provider.sql
-- 腾讯云 TokenHub（大模型服务平台）账号绑定 seed：API Key 登录，非网页 cookie 登录。
-- apikey 型厂商「额度单位 / 默认日额度 / 等效除数」不在 Admin 端手工填写，额度由接入层自动核算。
-- 免费额度为主账号(Uin)级共享积分（1 积分=1.0 元），需在「启用管理」页领取后可用（生视频免费包 50 积分/1 年）。
-- 本轮 Uin 级积分采集接口尚未探测确认（见方案 §4.2/4.5），先走每日账本 daily_total。
-- 免费视频模型目录（2026-08-21 实测官方，模型列表 1823/130051 + 产品计费 1823/130055，Model ID 为平台固定值）：
--   hy-video-1.5 文生+图生 1.5积分/次 / yt-video-2.0 图生 2积分/次起(480p) /
--   yt-video-humanactor 图生·按秒 1积分/秒(720p) / yt-video-fx 图生·按模板。
-- 与桌面 spec.ts 的 MODELS.tokenhub 镜像；TokenHub 数据不进 provider_caps 表（见方案 §5 Egress 削减）。
-- Idempotent：重复执行只更新 seed 字段，不重复插入。

INSERT INTO providers (id, name, logo, capabilities, auth_type, unit_name, default_daily_quota, equivalent_count_divisor)
VALUES
  (
    'tokenhub',
    '腾讯云TokenHub',
    '腾',
    '{"models":[
      {"id":"hy-video-1.5","modes":["text2video","img2video"],"free":true,"price":"1.5 积分/次"},
      {"id":"yt-video-2.0","modes":["img2video"],"free":true,"price":"2 积分/次起（480p）"},
      {"id":"yt-video-humanactor","modes":["img2video"],"free":true,"price":"1 积分/秒（720p）"},
      {"id":"yt-video-fx","modes":["img2video"],"free":true,"price":"按模板积分"}
    ]}'::jsonb,
    'apikey',
    '积分',
    50,
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
