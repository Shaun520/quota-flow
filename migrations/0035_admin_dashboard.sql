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