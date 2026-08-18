-- 0027_add_zhipu_provider.sql
-- 智谱（bigmodel.cn）账号绑定 seed：API Key 登录，非网页 cookie 登录。
-- apikey 型厂商「额度单位 / 默认日额度 / 等效除数」不在 Admin 端手工填写，
-- 额度由接入层自动核算（智谱免费模型 cogvideox-flash 无公开余额接口，走每日账本 daily_total）。
-- 视频模型定价（2026-08 实测）：
--   cogvideox-flash: 免费（usage=0，公测不扣费）
--   cogvideox-2: 付费 ¥0.5/次（按量计费，按次扣费而非 token）
--   cogvideox-3: 付费 ¥1/次
-- Idempotent：重复执行只更新 seed 字段，不重复插入。

INSERT INTO providers (id, name, logo, capabilities, auth_type, unit_name, default_daily_quota, equivalent_count_divisor)
VALUES
  (
    'zhipu',
    '智谱（bigmodel）',
    '智',
    '{"models":[
      {"id":"cogvideox-flash","modes":["text2video","img2video"],"free":true,"price":"免费"},
      {"id":"cogvideox-2","modes":["text2video","img2video"],"free":false,"price":"¥0.5/次"},
      {"id":"cogvideox-3","modes":["text2video","img2video"],"free":false,"price":"¥1/次"}
    ]}'::jsonb,
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