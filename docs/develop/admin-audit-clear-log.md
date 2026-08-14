# 后台「审计日志 · 清除日志」实现总结

> 完成日期：2026-08-14
> 实现范围：在审计日志页「导出 CSV」左侧新增「清除日志」功能，按当前筛选条件删除命中日志
> 关联文档：[admin-audit-log.md](./admin-audit-log.md)（审计日志列表页）、REQUIREMENTS.md §13.4.5

---

## 1. 背景

审计日志页已支持列表查询与 CSV 导出，但缺少清除能力。合规场景下需要「只保留近 N 天 / 定期清理」的运维手段，因此新增「清除日志」入口。

为与「导出 CSV」保持一致、避免误清全表，清除范围采用**当前筛选条件**（操作类型 / 团队 / 用户 / 时间范围 / 搜索），而非无条件清空。无任何筛选时等价于清除全部。

---

## 2. 改动总览

| 文件 | 改动类型 | 说明 |
|------|---------|------|
| `migrations/0019_audit_clear_rpc.sql` | 新增 | `admin_clear_audit_logs` 清除 RPC |
| `apps/admin/src/lib/api/audit.ts` | 扩展 | `clearAuditLogs`、`buildFilterArgs` 复用、`audit.clear` 中文标签 |
| `apps/admin/src/app/(dashboard)/audit/page.tsx` | 扩展 | 「清除日志」按钮 + 确认弹窗 + 清除后刷新 |

---

## 3. 数据库改动

### 3.1 `admin_clear_audit_logs`

```sql
CREATE OR REPLACE FUNCTION public.admin_clear_audit_logs(
  p_action TEXT DEFAULT NULL,
  p_team_id UUID DEFAULT NULL,
  p_user_id UUID DEFAULT NULL,
  p_from TIMESTAMPTZ DEFAULT NULL,
  p_to TIMESTAMPTZ DEFAULT NULL,
  p_search TEXT DEFAULT NULL
)
RETURNS json   -- { deleted: 被删除条数 }
```

关键点：

- **安全**：`SECURITY DEFINER SET search_path = public, auth`，首行 `IF NOT public.is_admin()` 兜底，仅 admin 可调用。
- **范围一致**：筛选条件与 `admin_list_audit_logs` 逐条对齐（`action LIKE p_action || '%'`、时间区间、`target` / `metadata::text` ILIKE），保证「清除」与「列表 / 导出」命中同一批数据。
- **计数**：`GET DIAGNOSTICS v_deleted = ROW_COUNT` 取删除条数，返回给前端展示。
- **留痕**：清除后内联写入一条 `audit.clear` 记录，metadata 记录删除条数与原筛选条件（`jsonb_strip_nulls` 去掉空字段）。「清除」动作本身可追溯。

---

## 4. 前端改动

### 4.1 数据访问层（lib/api/audit.ts）

- 抽出 `buildFilterArgs(params)`，将 `AuditLogListParams` 映射为 RPC 命名参数，列表 / 清除共用，杜绝两处筛选条件漂移。
- 新增 `clearAuditLogs(params)` → 调 `admin_clear_audit_logs` RPC，返回删除条数。
- `actionLabel` 增加 `"audit.clear": "清除日志"`，使清除记录在表格中展示中文标签。

### 4.2 页面（app/(dashboard)/audit/page.tsx）

- 表头「导出 CSV」左侧新增「清除日志」按钮（无数据即 `result.total === 0` 时禁用）。
- 点击弹出确认弹窗，文案显示将清除的条数（`result.total`）并标注「不可恢复」；确认按钮为 `btn-danger`。
- 清除成功后 toast 提示「已清除 N 条日志」，并刷新列表：当前第 1 页直接重载，非第 1 页重置回第 1 页。

---

## 5. 关键设计决策

| 决策点 | 结论 |
|--------|------|
| 清除范围 | 复用当前筛选条件，与「导出 CSV」对称，避免误清全表；无筛选即全清 |
| 权限与安全 | 下沉为 `SECURITY DEFINER` RPC，`is_admin()` 守卫，客户端不可绕过 |
| 留痕 | 清除动作写入 `audit.clear` 记录；清除「全部」时该条作为唯一残留项保留 |
| 计数展示 | 前端直接复用 `result.total`（列表 RPC 已返回当前筛选总数）作为弹窗中的待删条数 |
| 交互 | 破坏性操作走确认弹窗（复用 `modal-overlay` / `modal` 样式），与公告删除弹窗一致 |

---

## 6. 部署与验证

### 部署步骤

1. 确认 `migrations/0007_admin_tables.sql`、`migrations/0018_audit_rpc.sql` 已执行。
2. 执行 `migrations/0019_audit_clear_rpc.sql`（SQL Editor 或迁移 runner）。

### 验证点

| 项 | 预期 |
|----|------|
| 权限 | 非 admin 调用 RPC 返回 `forbidden: admin only` |
| 范围 | 按操作类型 / 时间范围 / 搜索清除时，仅命中对应记录 |
| 全清 | 无筛选时清除全部，仅残留一条 `audit.clear` 记录 |
| 反馈 | 弹窗显示待删条数；成功后 toast 提示「已清除 N 条日志」并刷新列表 |
| 联动 | 清除动作本身出现在审计日志中（`audit.clear`），操作人正确 |

---

## 7. 相关文档

- [admin-audit-log.md](./admin-audit-log.md) — 审计日志列表页整体实现
- [admin-users-page.md](./admin-users-page.md) — 用户管理页实现套路（本页参考模板）
- [data-consistency-fix-summary.md](./data-consistency-fix-summary.md) — RPC 与 Supabase 迁移先例写法
