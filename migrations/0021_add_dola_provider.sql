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
