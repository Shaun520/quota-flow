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
