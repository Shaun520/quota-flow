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
