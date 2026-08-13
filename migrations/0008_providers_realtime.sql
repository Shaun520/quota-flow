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
