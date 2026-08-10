-- 0004_account_default.sql
-- 多账号：默认账号（优先扣减）+ 每账号额度归属
-- 幂等：IF NOT EXISTS / DROP INDEX IF EXISTS；在 Supabase SQL Editor 按序执行

-- 1. 默认账号标识：每 (owner_user_id, provider_id) 至多一个默认
ALTER TABLE provider_keys ADD COLUMN IF NOT EXISTS is_default BOOLEAN NOT NULL DEFAULT FALSE;

DROP INDEX IF EXISTS idx_provider_keys_default_per_provider;
CREATE UNIQUE INDEX idx_provider_keys_default_per_provider
  ON provider_keys (owner_user_id, provider_id)
  WHERE is_default;

-- 2. 首次绑定账号默认设为默认（已有数据：每个厂商取最新一条置为默认）
UPDATE provider_keys pk
SET is_default = TRUE
WHERE pk.id IN (
  SELECT DISTINCT ON (owner_user_id, provider_id) id
  FROM provider_keys
  WHERE is_default = FALSE
  ORDER BY owner_user_id, provider_id, created_at DESC
)
AND NOT EXISTS (
  SELECT 1 FROM provider_keys p2
  WHERE p2.owner_user_id = pk.owner_user_id
    AND p2.provider_id = pk.provider_id
    AND p2.is_default = TRUE
);

COMMENT ON COLUMN provider_keys.is_default IS '默认账号：调度时优先扣减该账号额度，不足自动切下一账号';
