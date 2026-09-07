-- 0039_add_jobs_client_version.sql
-- admin 查看「用户用哪个桌面端版本生成视频」：jobs 新增 client_version 列。
-- 只在生成时写入一次（insert 时带上当前 app.getVersion()）；历史记录该列为 NULL。
-- Idempotent: ADD COLUMN IF NOT EXISTS；在 Supabase SQL Editor 或迁移 runner 执行。

ALTER TABLE public.jobs
  ADD COLUMN IF NOT EXISTS client_version TEXT;

COMMENT ON COLUMN public.jobs.client_version
  IS '桌面端生成该记录时的客户端版本号（app.getVersion()）；历史记录为 NULL，表示未知';