# PostgREST 数据与 AI 开发规范

> 本规范是 QuotaFlow 的长期开发标准。任何 AI 编码任务都必须先读本文件；Supabase/PostgREST 相关改动必须按本规范审查。

## 背景

QuotaFlow 主要从桌面端和管理端直连 Supabase PostgREST。此前出现 PostgREST 响应体过大导致的 Egress 超额，尤其是 `/rest/v1/jobs`、`/rest/v1/provider_keys`、`/rest/v1/teams` 等接口。为避免再次发生，所有新增/修改代码必须遵守以下规则。

## 规则

### R1 列表查询必须显式字段

- 禁止 `select('*')`、`select()` 全字段拉取。
- 列表、表格、下拉、搜索、批量操作前先列最小展示字段。
- 如果某个字段只在详情或处理流程中使用，不能出现在列表查询中。

### R2 大字段和密钥不能默认下发

- 默认不下发：`encrypted_key`、完整 `options`、`attempts`、`cost_breakdown` 等大字段。
- `prompt` 只在列表确实需要展示或搜索时返回；不需要时不要随列表带出。
- `encrypted_key` 属于密钥，不得随账号列表返回；需要密钥的路径单独提供 `getProviderKeySecret` 或 `WithSecrets` 方法。
- `attempts`、完整 `options` 只在 job 详情、去水印、重试等真正需要完整数据的地方读取。

### R3 列表必须服务端分页/limit

- `jobs`、`quota_ledger`、`teams`、`provider_keys` 等列表必须带 `limit`/`range` 或 page/pageSize，不能无限制全量拉取。
- 前端不要把分页数据拉到客户端再过滤；搜索、厂商、状态等筛选尽量传到服务端。
- 批量操作只作用于当前页或明确选中的 id，不能为了全选重新拉全量列表。
- Admin 端团队下拉等选项列表使用轻量 option 查询，只查 `id, name` 等字段，不使用 `pageSize: 1000` 全量列表。

### R4 客户端不能高频全量轮询

- 禁止为实时状态高频拉取全表/全量列表。
- 优先使用 Supabase Realtime 订阅；若不能用 Realtime，用 `updated_at > lastSyncAt` 增量查询。
- 轮询必须有明确上限和间隔，并在实现时说明为什么不能走 Realtime/增量。

### R5 写入操作返回最小字段

- `insert`/`update`/RPC 默认不 `.select()` 返回整行大 JSON。
- 如果调用方只需要 id/状态，返回 id/状态即可；需要完整详情再单独查询或使用显式字段。

### R6 新增查询/服务要提供显式类型

- 在 `packages/db-supabase` 等数据访问层优先定义 summary/detail 类型，如 `ProviderKeySummary`、`JobListItem`、`JobDetail`。
- 禁止让调用方拿到未声明的数据库 row 大对象。

## 例外

- 用户在当前任务中明确要求某条规则不适用，并且已在代码中写清原因时，可以例外。
- 必须把例外收敛到最小范围；列表/批量路径不要使用例外。

## 审查清单

改动 Supabase/PostgREST、列表页、历史、厂商账号、Admin 管理端相关代码时，逐项检查：

- 没有新增 `.select('*')` 或 `.select()`。
- `encrypted_key` 没有出现在列表查询/默认查询。
- 大字段（`options`、`attempts`、`cost_breakdown`）没有随列表返回。
- 列表查询带 `limit`/`range`/分页，前端筛选服务端执行。
- 没有新增前端高频全量轮询。
- Admin 下拉/选项没有使用 `pageSize: 1000` 全量拉取。
- 新增数据访问方法返回显式字段/类型，而不是整行 row。

## 文档位置

- 本规范属于仓库开发标准，统一放在 `docs/开发规范`。
- 不要使用 `docs/develop` 存放新开发文档；现有 `docs/README.md` 已明确废弃该目录。
