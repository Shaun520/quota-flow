-- 0034_add_bailian_provider.sql
-- 阿里云百炼（Model Studio）账号绑定 seed：API Key 登录，非网页 cookie 登录。
-- apikey 型厂商「额度单位 / 默认日额度 / 等效除数」不在 Admin 端手工填写，额度由接入层自动核算。
-- 首期（2026-08-20）只做绑定 + 测试 + 去重；真实免费额度在控制台 costing-balance/free-quota 页（业务空间维度），
--   需控制台会话捕获，作为后续迭代（见 docs/厂商与API平台接入/阿里云百炼接入方案.md）。本期实际额度走每日账本 daily_total。
-- 视频模型目录（wan2.7-t2v 文生 / wan2.7-i2v 图生）暂不写入 capabilities：模型能力延后，首期 models 留空。
-- Idempotent：重复执行只更新 seed 字段，不重复插入。

INSERT INTO providers (id, name, logo, capabilities, auth_type, unit_name, default_daily_quota, equivalent_count_divisor)
VALUES
  (
    'bailian',
    '阿里云百炼',
    '炼',
    '{"models":[]}'::jsonb,
    'apikey',
    '次',
    50,
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