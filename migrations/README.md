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

- `0001_providers.sql`：团队 / 厂商元信息 / 绑定账号 / 每日额度账本（P1）
- `0002_account_fingerprint.sql`：账号指纹去重（P2，方案 A）
- `0003_jobs.sql`：生成任务历史（P2，数据库为真相源；RLS 团队成员可见本团队任务）
- `0004_quota_ledger_index.sql`：额度账本按用户+日期倒序索引（厂商列表查询加速）
