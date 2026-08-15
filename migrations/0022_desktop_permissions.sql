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
