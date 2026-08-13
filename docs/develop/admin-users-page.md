# 后台「用户管理」页实现总结

> 完成日期：2026-08-13
> 实现范围：apps/admin 用户管理页（从静态原型替换为真实数据驱动）
> 关联设计：[admin-system-plan.md](./admin-system-plan.md)、REQUIREMENTS.md §13.4.1

---

## 1. 背景

`apps/admin` 后台骨架阶段，8 个页面均通过 `PrototypePage` 注入 `docs/prototype` 导出的静态 HTML 字符串渲染，用户管理页同样如此——数据、筛选器、按钮全是写死的，无任何交互。

本次将「用户管理」页替换为真实实现：从 Supabase 读取数据、支持筛选/搜索/分页/封禁解封/详情/导出 CSV。其余 7 个页面暂保持静态原型不变。

---

## 2. 改动总览

| 文件 | 改动类型 | 说明 |
|------|---------|------|
| `migrations/0010_admin_users_rpc.sql` | 新增 | `admin_list_users` RPC：聚合用户列表 |
| `apps/admin/src/lib/api/users.ts` | 新增 | 数据访问层（列表/封禁解封/最近任务/CSV 导出） |
| `apps/admin/src/lib/utils/format.ts` | 新增 | 日期/数字格式化 + 头像缩写与配色 |
| `apps/admin/src/components/users/user-filters.tsx` | 新增 | 角色/状态筛选 + 搜索框 |
| `apps/admin/src/components/users/user-table.tsx` | 新增 | 用户列表表格 |
| `apps/admin/src/components/users/user-detail-modal.tsx` | 新增 | 用户详情弹窗（含最近任务） |
| `apps/admin/src/components/users/pagination.tsx` | 新增 | 分页组件（带省略号） |
| `apps/admin/src/app/(dashboard)/users/page.tsx` | 重写 | 由静态原型改为客户端组件，组装以上所有 |
| `apps/admin/.env.local` | 新增（本地，已 gitignore） | 配 `NEXT_PUBLIC_SUPABASE_URL` / `ANON_KEY` |

> 说明：`.env.local` 值复制自 `apps/desktop/.env` 的 `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY`（同一 Supabase 项目 `pnhvyjyexiwmecblfwly`），该文件已被 `.gitignore` 忽略、仅本地存在。

---

## 3. 数据库改动

### 3.1 `admin_list_users` RPC

聚合 `profiles` + `team_members` + `teams` + `jobs`，一次调用返回分页后的用户列表与总数：

```sql
CREATE OR REPLACE FUNCTION public.admin_list_users(
  p_search TEXT DEFAULT NULL,   -- 邮箱/用户名 ILIKE
  p_role TEXT DEFAULT NULL,     -- 'admin' | 'member' | 'none'(无团队=个人)
  p_status TEXT DEFAULT NULL,   -- 'active' | 'banned' | 'exhausted'
  p_limit INTEGER DEFAULT 20,
  p_offset INTEGER DEFAULT 0
)
RETURNS json   -- { total, items: [...] }
```

关键点：

- **安全**：`SECURITY DEFINER SET search_path = public, auth`，函数体首行 `IF NOT public.is_admin() THEN RAISE EXCEPTION` 兜底，仅管理员可调用。
- **消费口径**：对 `jobs` 按 `user_id` 求和 `COALESCE(equivalent_count, 0)`（等效「次」），跨厂商可比；`month_usage` 用 `date_trunc('month', now() AT TIME ZONE 'Asia/Shanghai')` 对齐项目统一的每日额度重置时区。
- **团队**：`LEFT JOIN team_members` + `LEFT JOIN teams`，无团队用户 `team_name` / `team_role` 为 `NULL`。
- **排序**：`ORDER BY p.created_at DESC, p.id`（加 `id` 作 tiebreaker 保证分页稳定）。

### 3.2 依赖的前置迁移

用户页依赖以下表/策略，需先执行：

- `migrations/0007_admin_tables.sql`：`profiles`（含 `is_admin` / `status`）、`is_admin()` 函数、`profiles_admin_all` / `jobs_admin_all` / `teams_admin_all` / `team_members_admin_all` / `audit_logs_admin_all` 等 RLS 策略。
- `migrations/0001_providers.sql`：`teams` / `team_members`（`role` = admin|member）。
- `migrations/0003_jobs.sql`：`jobs`（`equivalent_count` / `user_id` / `created_at`）。

---

## 4. 前端改动

### 4.1 数据访问层（lib/api/users.ts）

- `listUsers(params)` → 调 `admin_list_users` RPC，返回 `{ total, items }`。
- `setUserStatus(userId, status)` → 更新 `profiles.status`（+`updated_at`），并写 `audit_logs`（action=`user.ban` / `user.unban`）。
- `listRecentJobs(userId, limit)` → 详情弹窗的最近任务（走 `jobs_admin_all` RLS）。
- `toCsv` / `downloadCsv` → 客户端生成 CSV（带 BOM，兼容 Excel）。

### 4.2 页面结构（users/page.tsx，客户端组件）

- 搜索框 300ms 防抖；角色/状态变化立即生效并重置到第 1 页。
- 列表/筛选/分页/详情/封禁解封/导出组装为一个页面，操作后刷新列表 + toast 提示。
- 复用了 `globals.css` 中已有的原型样式类（`filter-bar` / `table` / `badge-*` / `cell-*` / `pagination` / `admin-avatar` / `modal-*`），未用 `components/ui.tsx` 里另一套 `DataTable`（类名对不上原型视觉）。

---

## 5. 关键设计决策

| 决策点 | 结论 |
|--------|------|
| 「角色」语义 | 指**团队角色**（`team_members.role` 的 Admin/Member）；「平台管理员」由 `profiles.is_admin` 单独用 badge 标识，两者不混用 |
| 无团队用户 | 视为**个人**：所属团队显示「个人」、角色显示「—」；筛选器新增「个人」选项（否则选 Admin/Member 会把个人用户整体筛没掉） |
| 消费统计 | 求和 `equivalent_count`（单位「次」），不用 `cost_amount`（各厂商单位不一致，灵感值/积分无法跨厂商相加） |
| 封禁力度 | MVP 仅改 `profiles.status`（active↔banned）+ 写审计；**不强踢会话**（需要 service_role / Edge Function，本次不做，桌面端靠读 `status` 拦截） |

---

## 6. 部署与验证

### 部署步骤

1. 确认 `0007_admin_tables.sql` 已执行（profiles 表 + RLS）。
2. 执行 `migrations/0010_admin_users_rpc.sql`（SQL Editor 或 `node packages/db-supabase/deploy-migrations.mjs <db-password>`）。
3. 确认 `apps/admin/.env.local` 已配置（见 §2）。
4. `pnpm dev` 起 admin 应用，登录运营者账号后进入「用户管理」。

### 验证点

| 项 | 预期 |
|----|------|
| 未登录访问 `/users` | `307` 重定向到 `/login?next=/users` |
| 列表 | 显示真实用户（头像/邮箱/团队/角色/注册时间/本月/累计/状态） |
| 筛选/搜索 | 角色、状态、关键字组合过滤正确 |
| 分页 | 按 `total` 分页，切换页码正常 |
| 封禁/解封 | 状态切换生效，`audit_logs` 出现 `user.ban` / `user.unban` 记录 |
| 详情 | 弹窗显示用户信息 + 最近任务 |
| 导出 CSV | 下载文件内容与当前筛选结果一致 |

### 排障：ChunkLoadError

若页面报 `Loading chunk app/(dashboard)/users/page failed`：

- 根因：同一目录 `apps/admin` 同时跑两个 dev server，共用 `.next` 缓存 + 热更新导致 chunk 清单错乱（非代码问题）。
- 处理：停掉旧进程 → `pnpm clean`（清 `.next`）→ 重启单个 `pnpm dev` → 浏览器 `Ctrl+Shift+R` 硬刷新。

---

## 7. 已知残留项

| 项 | 优先级 | 说明 |
|----|--------|------|
| 封禁不强踢会话 | LOW | 封禁仅标记 `status`，用户当前会话不会立刻失效；需 service_role 调用 `auth.admin` 或 Edge Function 撤销 |
| 消费统计只算 `equivalent_count` | LOW | 未计入 `cost_amount`（厂商原生单位）；如需按金额统计需另行聚合 |
| 详情弹窗最近任务仅取前 10 条 | LOW | 未做任务分页 |
| 其余 7 个后台页 | — | 仍为静态原型，待后续逐个按本页套路实现 |

---

## 8. 相关文档

- [admin-system-plan.md](./admin-system-plan.md) — 后台整体开发方案与分阶段规划
- [data-consistency-fix-summary.md](./data-consistency-fix-summary.md) — RPC 与 Supabase 迁移的先例写法
