-- 0036_add_tokenhub_provider.sql
-- 腾讯云 TokenHub（大模型服务平台）账号绑定 seed：API Key 登录，非网页 cookie 登录。
-- apikey 型厂商「额度单位 / 默认日额度 / 等效除数」不在 Admin 端手工填写，额度由接入层自动核算。
-- 免费额度为主账号(Uin)级共享积分（1 积分=1.0 元），需在「启用管理」页领取后可用（生视频免费包 50 积分/1 年）。
-- 本轮 Uin 级积分采集接口尚未探测确认（见方案 §4.2/4.5），先走每日账本 daily_total。
-- 免费视频模型目录（2026-08-21 实测官方，模型列表 1823/130051 + 产品计费 1823/130055，Model ID 为平台固定值）：
--   hy-video-1.5 文生+图生 1.5积分/次 / yt-video-2.0 图生 2积分/次起(480p) /
--   yt-video-humanactor 图生·按秒 1积分/秒(720p) / yt-video-fx 图生·按模板。
-- 与桌面 spec.ts 的 MODELS.tokenhub 镜像；TokenHub 数据不进 provider_caps 表（见方案 §5 Egress 削减）。
-- Idempotent：重复执行只更新 seed 字段，不重复插入。

INSERT INTO providers (id, name, logo, capabilities, auth_type, unit_name, default_daily_quota, equivalent_count_divisor)
VALUES
  (
    'tokenhub',
    '腾讯云TokenHub',
    '腾',
    '{"models":[
      {"id":"hy-video-1.5","modes":["text2video","img2video"],"free":true,"price":"1.5 积分/次"},
      {"id":"yt-video-2.0","modes":["img2video"],"free":true,"price":"2 积分/次起（480p）"},
      {"id":"yt-video-humanactor","modes":["img2video"],"free":true,"price":"1 积分/秒（720p）"},
      {"id":"yt-video-fx","modes":["img2video"],"free":true,"price":"按模板积分"}
    ]}'::jsonb,
    'apikey',
    '积分',
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