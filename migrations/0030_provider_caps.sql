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