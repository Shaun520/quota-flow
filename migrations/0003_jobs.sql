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
