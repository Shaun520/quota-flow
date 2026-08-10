-- 0002_account_fingerprint.sql
-- P2：账号指纹去重（方案 A）
-- provider_keys 增加 account_fingerprint：绑定登录后从页面提取账号标识（手机号/邮箱/uid 等）的 sha256。
-- 同一用户对同一厂商同一账号重复绑定 → 指纹相同 → 绑定前拦截提示。
-- 幂等：IF NOT EXISTS / IF NOT EXISTS 索引；在 Supabase SQL Editor 按序执行。

ALTER TABLE provider_keys
  ADD COLUMN IF NOT EXISTS account_fingerprint TEXT;

CREATE INDEX IF NOT EXISTS idx_provider_keys_fp
  ON provider_keys (owner_user_id, provider_id, account_fingerprint);

COMMENT ON COLUMN provider_keys.account_fingerprint IS
  '账号指纹：登录后从页面提取的账号标识（手机号/邮箱/uid等）归一化后 sha256；NULL=未提取（不参与去重）';