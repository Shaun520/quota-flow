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
