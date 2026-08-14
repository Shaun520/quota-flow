# 团队模块 MVP 实施计划

日期：2026-08-14

## 摘要与现状

当前 Admin 端团队页还是静态 HTML 原型，只展示假数据，详情、封禁、重置额度等按钮没有真实逻辑；桌面端团队 Tab 在导航里被直接拦截，提示“系统暂未实现”，页面组件也只用 `TEAM` 静态数据。数据库已经有 `teams`、`team_members`、`team_invitations`、`subscriptions`、`member_usage` 等基础表和 Admin RLS 策略，但缺少团队列表 RPC、桌面端创建/加入/邀请服务、以及真实 UI 数据流。

本次范围：Admin 团队管理 + 桌面端基础团队功能一起做，不包含共享额度池。

## 关键改动

- 新增 `migrations/0013_team_rpc.sql`：
  - `admin_list_teams(p_search, p_status, p_limit, p_offset) returns json`：Admin 专用，聚合团队名称、owner、成员数、席位、套餐、状态、最近订阅、本月/累计用量、绑定账号数。
  - `admin_list_team_members(p_team_id) returns json`：Admin 专用，返回成员资料、角色、日限额、加入时间、用量统计。
  - `create_team(p_name)`：事务化创建团队并插入 owner 成员记录，返回 `TeamContext`。
  - `join_team_by_invite(p_token)`：校验邀请码、过期时间、席位上限，插入成员并消费邀请码，返回 `TeamContext`。
  - `get_team_detail(p_team_id)`：桌面端成员读取团队信息、订阅摘要、成员数与用量。
  - `get_team_members(p_team_id)`：桌面端成员读取团队成员的资料、日限额、加入时间与用量统计。
  - `create_team_invite(p_team_id, p_email, p_role, p_expires_at)`：owner 生成单次邀请码，默认 7 天有效。
  - 所有 RPC 都 `SECURITY DEFINER` 并显式校验权限，`GRANT EXECUTE` 给 `authenticated`。
- Admin 端替换团队页：
  - 新增 `apps/admin/src/lib/api/teams.ts`，类型为 `AdminTeam`、`AdminTeamMember`、状态筛选等。
  - 新增团队表格、筛选、分页、详情弹窗组件，沿用现有用户管理页的模式。
  - 详情弹窗展示团队成员、订阅信息、用量；支持修改 `plan`、`seats_limit`、`status` 并写 `audit_logs`。
  - 不实现“重置额度”或“成员封禁”的额度/封禁业务，保留为后续独立项。
- 桌面端加入真实团队服务：
  - 在 `@quota-flow/db-supabase` 增加 `TeamService`，并在桌面 renderer 的 `auth/service.ts` 增加 `getTeamService()` 单例。
  - 方法包括：创建团队、邀请码加入、成员列表、生成邀请码、移除成员、更新成员日限额、读取团队信息。
  - `useAuth` 增加 `refreshTeam()`，创建/加入成功后刷新顶部团队徽标和 Profile 弹窗。
  - `App.tsx` 移除团队 Tab 的拦截，并把 `team` 纳入可恢复的 hash tab。
- 重写桌面端 `Team.tsx`：
  - 无团队时显示真实空状态，支持“创建团队”和“输入邀请码加入”。
  - 有团队时展示成员表格、团队信息、邀请码生成/复制；owner 可移除成员、设置成员日限额。
  - 移除对静态 `TEAM` 数据的依赖；“升级套餐”按钮隐藏或禁用，因为计费/套餐购买不在本轮范围。

## 公共 API / 类型变化

- 新增 RPC：`admin_list_teams`、`admin_list_team_members`、`create_team`、`join_team_by_invite`、`get_team_detail`、`get_team_members`、`create_team_invite`。
- 新增 TS 类型：`AdminTeam`、`AdminTeamMember`、`TeamDetail`、`TeamMemberView`、`TeamInvitation`。
- 新增导出：`@quota-flow/db-supabase` 的 `TeamService`，桌面端 `auth/service.ts` 的 `getTeamService()`，`useAuth` 的 `refreshTeam()`。

## 测试计划

- SQL：在 Supabase 本地或远程环境幂等执行迁移，验证非 admin 调用 Admin RPC 被拒绝；验证 `create_team` 后 owner 能读团队、`join_team_by_invite` 对无效/过期/满员/重复加入返回合理错误。
- Admin：运行 `pnpm --filter @quota-flow/admin typecheck` 和 `pnpm --filter @quota-flow/admin build`；人工验证团队列表、筛选、分页、详情成员、状态/套餐编辑、审计日志写入。
- 桌面端：运行 `pnpm --filter @quota-flow/db-supabase typecheck`、`pnpm --filter @quota-flow/desktop typecheck` 和 `pnpm --filter @quota-flow/desktop build`；人工验证创建团队、邀请码加入、成员列表、生成邀请码、owner 操作、团队徽标刷新。
- 根目录跑一次 `pnpm typecheck`，确认共享包和两端类型兼容。

## 假设

- 本轮不实现共享额度池、计费支付、公共账号绑定/额度扣减改造。
- 邀请码采用 8 位大写 token，默认 7 天有效，单次使用后消费；暂不使用邀请邮箱匹配。
- Admin 团队操作以 `teams` 表字段为主，订阅周期只读展示，不新增订阅账务流程。
- 保留现有 `prototype-pages.ts` 和其他原型页不动，仅团队页切到真实数据。
