-- 0031_add_volcengine_provider.sql
-- 火山方舟（火山引擎 ARK）账号绑定 seed：API Key 登录，非网页 cookie 登录。
-- apikey 型厂商「额度单位 / 默认日额度 / 等效除数」不在 Admin 端手工填写，
-- 额度由接入层自动核算；火山方舟本轮尚未探测到控制台真实额度接口（见方案 §6），先走每日账本 daily_total。
-- 免费视频模型目录（2026-08-19 实测，有免费推理额度）：Seedance 1.0-pro / 1.5-pro / 1.0-pro-fast，
--   Model ID 为平台固定值，写入 capabilities.models 作为厂商级权威清单（与桌面 spec.ts 的 MODELS.volcengine 镜像）。
-- 说明：1.0-lite-t2v/i2v 虽在开通管理页显示免费额度，官方文档未收录 Model ID，本轮不接入。
-- Idempotent：重复执行只更新 seed 字段，不重复插入。

INSERT INTO providers (id, name, logo, capabilities, auth_type, unit_name, default_daily_quota, equivalent_count_divisor)
VALUES
  (
    'volcengine',
    '火山方舟',
    '火',
    '{"models":[
      {"id":"doubao-seedance-1-0-pro-250528","modes":["text2video","img2video"],"free":true,"price":"免费"},
      {"id":"doubao-seedance-1-5-pro-251215","modes":["text2video","img2video"],"free":true,"price":"免费"},
      {"id":"doubao-seedance-1-0-pro-fast-251015","modes":["text2video","img2video"],"free":true,"price":"免费"}
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