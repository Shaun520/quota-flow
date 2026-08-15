-- 0020_remove_mathmind.sql
-- MathMind 无免费额度，移除该厂商配置；删除会级联清理 provider_keys / quota_ledger。

DELETE FROM provider_cost_tables
WHERE provider_id = 'mathmind';

DELETE FROM providers
WHERE id = 'mathmind';
