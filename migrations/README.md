# migrations

Supabase Postgres 迁移脚本目录（含 `provider_cost_tables` 初始消耗规则）。

## 约定

- 命名：`NNNN_描述.sql`，NNNN 为递增序号（如 `0001_create_tables.sql`），必须按升序执行
- 执行方式（二选一）：
  - 方式 A：Supabase Dashboard → SQL Editor → 粘贴脚本按顺序执行（自部署推荐）
  - 方式 B：`supabase db push`（若使用 supabase CLI）
- 幂等性：优先使用 `IF NOT EXISTS` / `CREATE OR REPLACE`，允许重复执行不报错
- 表结构依据：REQUIREMENTS.md §5.7（profiles / teams / team_members / provider_keys / provider_cost_tables / quota_ledger / member_usage / jobs 等）

## 当前状态

尚未编写任何迁移脚本（待实现）。