# 团队模块 MVP 实施计划

日期：2026-08-14

## 摘要与现状

当前 Admin 端团队页还是静态 HTML 原型，只展示假数据，详情、封禁、重置额度等按钮没有真实逻辑；桌面端团队 Tab 在导航里被直接拦截，提示“系统暂未实现”，页面组件也只用 `TEAM` 静态数据。数据库已经有 `teams`、`team_members`、`team_invitations`、`subscriptions`、`member_usage` 等基础表和 Admin RLS 策略，但缺少团队列表 RPC、桌面端创建/加入/邀请服务、以及真实 UI 数据流。

本次范围：Admin 团队管理 + 桌面端基础团队功能一起做，并补上团队共享额度池的豆包日额度扣减链路。

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
- 新增 `migrations/0014_team_quota_rpc.sql`：
  - `team_quota_snapshot(p_team_id, p_provider_id)`：返回团队共享日额度汇总，按团队豆包账号额度求和，成员或 admin 可读。
  - `get_team_quota(p_team_id, p_provider_id)`：返回当前成员看到的团队额度 + 个人今日用量/日限额。
  - `team_consume_quota_and_finalize(...)`：团队任务成功后原子扣团队额度、扣成员日限额、写 `quota_operations`，替代个人 `reconcile_consume_and_finalize` 的团队分支。
  - `admin_reset_team_quota(p_team_id)`：Admin 重置今天团队池、账号账本和成员用量，并写 `audit_logs`。
  - 扩展 `admin_list_teams` 和 `get_team_detail`，返回团队共享额度快照。
- Admin 端替换团队页：
  - 新增 `apps/admin/src/lib/api/teams.ts`，类型为 `AdminTeam`、`AdminTeamMember`、状态筛选等。
  - 新增团队表格、筛选、分页、详情弹窗组件，沿用现有用户管理页的模式。
  - 详情弹窗展示团队成员、订阅信息、用量；支持修改 `plan`、`seats_limit`、`status` 并写 `audit_logs`。
  - 支持“重置今日额度”，写 `audit_logs`；“成员封禁”仍保留为后续独立项。
- 桌面端加入真实团队服务：
  - 在 `@quota-flow/db-supabase` 增加 `TeamService`，并在桌面 renderer 的 `auth/service.ts` 增加 `getTeamService()` 单例。
  - 方法包括：创建团队、邀请码加入、成员列表、生成邀请码、移除成员、更新成员日限额、读取团队信息。
  - `useAuth` 增加 `refreshTeam()`，创建/加入成功后刷新顶部团队徽标和 Profile 弹窗。
  - `App.tsx` 移除团队 Tab 的拦截，并把 `team` 纳入可恢复的 hash tab。
  - 重写桌面端 `Team.tsx`：
  - 无团队时显示真实空状态，支持“创建团队”和“输入邀请码加入”。
  - 有团队时展示成员表格、团队信息、邀请码生成/复制；owner 可移除成员、设置成员日限额。
  - 移除对静态 `TEAM` 数据的依赖；“升级套餐”按钮隐藏或禁用，因为计费/套餐购买不在本轮范围。
  - 桌面端生成、厂商列表、额度展示、绑定账号均支持 `teamId`；加入团队后走团队豆包账号和团队额度池。

## 公共 API / 类型变化

- 新增 RPC：`admin_list_teams`、`admin_list_team_members`、`create_team`、`join_team_by_invite`、`get_team_detail`、`get_team_members`、`create_team_invite`、`team_quota_snapshot`、`get_team_quota`、`team_consume_quota_and_finalize`、`admin_reset_team_quota`。
- 新增 TS 类型：`AdminTeam`、`AdminTeamMember`、`TeamDetail`、`TeamMemberView`、`TeamInvitation`、`TeamQuota`、`TeamQuotaSummary`。
- 新增导出：`@quota-flow/db-supabase` 的 `TeamService`、`TeamQuota`、`TeamQuotaSummary`、`ProviderService.listTeamProviderKeys`、`ProviderService.listTeamLedger`、`ProviderService.consumeTeamQuotaAndFinalize`；桌面端 `auth/service.ts` 的 `getTeamService()`，`useAuth` 的 `refreshTeam()`。

## 测试计划

- SQL：在 Supabase 本地或远程环境幂等执行迁移，验证非 admin 调用 Admin RPC 被拒绝；验证 `create_team` 后 owner 能读团队、`join_team_by_invite` 对无效/过期/满员/重复加入返回合理错误。
- Admin：运行 `pnpm --filter @quota-flow/admin typecheck` 和 `pnpm --filter @quota-flow/admin build`；人工验证团队列表、筛选、分页、详情成员、状态/套餐编辑、审计日志写入。
- 桌面端：运行 `pnpm --filter @quota-flow/db-supabase typecheck`、`pnpm --filter @quota-flow/desktop typecheck` 和 `pnpm --filter @quota-flow/desktop build`；人工验证创建团队、邀请码加入、成员列表、生成邀请码、owner 操作、团队徽标刷新。
- 根目录跑一次 `pnpm typecheck`，确认共享包和两端类型兼容。

## 假设

- 本轮共享额度池只做豆包团队日额度池和团队任务扣减；不实现计费支付、套餐购买、公共账号绑定/额度扣减的完整改造。
- 邀请码采用 8 位大写 token，默认 7 天有效，单次使用后消费；暂不使用邀请邮箱匹配。
- Admin 团队操作以 `teams` 表字段为主，订阅周期只读展示，不新增订阅账务流程。
- 保留现有 `prototype-pages.ts` 和其他原型页不动，仅团队页切到真实数据。

## 账号归属与模式切换补充（0015）

日期：2026-08-14

### 目标

桌面端把“是否在团队”和“生成时用谁的额度”拆开。账号归属仍用 `provider_keys.team_id` 表达：`team_id = NULL` 是个人账号，非 NULL 是团队共享账号。本轮不实现共享额度池扩展、计费、Admin 端改动。

### 关键改动

- 新增 `migrations/0015_team_account_scope_rpc.sql`：
  - `team_leave(p_team_id)`：仅非 owner 成员可调用；删除团队成员记录，并把该成员自己共享给该团队的 `provider_keys.team_id` 置为 NULL。
  - `set_provider_key_scope(p_key_id, p_team_id nullable)`：仅账号 owner 可调用；设置个人/团队归属，若目标团队非空则校验当前用户仍是该团队有效成员。
  - 收紧 `provider_keys` 直接写入策略：INSERT/UPDATE 只能写本人账号，且 `team_id` 非空时必须是当前用户所属团队。
- 扩展 `@quota-flow/db-supabase`：
  - `TeamService.leaveTeam(teamId)`。
  - `ProviderService.setProviderKeyScope(keyId, teamId | null)`。
  - 新增 `ViewScope = 'personal' | 'team' | 'global'`、`UsageScope = 'personal' | 'team'`。
- 桌面端状态：
  - `viewScope` 控制账号展示范围：个人模式只显示个人账号，团队模式只显示团队账号，全局模式同时显示两种。
  - `usageScope` 控制生成时使用哪个额度：个人/团队模式下固定；全局模式内提供“个人额度 / 团队额度”选择。
  - `dispatch.generate` 只在 `usageScope === 'team'` 时传 `teamId`；个人额度路径只选个人账号。
- 账号列表与新增：
  - 有团队时新增账号可选择“个人账号 / 团队账号”；无团队时默认新增个人账号。
  - 自己的个人账号可共享到团队；自己的团队账号可取消共享和删除；其他成员的团队账号只读展示。
  - 个人账号删除、改名、启停、默认、健康检查仍只对本人账号开放。
- Team 页面：
  - 非 owner 成员可退出团队；退出前提示自己共享给该团队的账号会变回个人账号。
  - owner 不显示退出按钮；本轮不做 owner 转让或解散团队。

### 公共 API / 类型变化

- 新增 RPC：`team_leave`、`set_provider_key_scope`。
- 新增 TS 类型：`ViewScope`、`UsageScope`。
- 新增导出方法：`TeamService.leaveTeam()`、`ProviderService.setProviderKeyScope()`。
- 状态流：账号新增/共享/取消共享/删除/退出团队后，刷新 `providers`、`team`、`usage` 相关状态，顶部团队徽标与 Profile 同步更新。

### 测试计划

- 运行 `pnpm --filter @quota-flow/db-supabase typecheck`、`pnpm --filter @quota-flow/desktop typecheck`、`pnpm --filter @quota-flow/desktop build`。
- 人工验证：
  - 个人模式只显示个人账号，生成走个人额度。
  - 团队模式只显示团队账号，生成走团队额度。
  - 全局模式同时显示个人/团队账号，并可按选择走个人或团队额度。
  - 有团队时新增账号可选择个人或团队，且新增后归属正确。
  - 自己的个人账号可共享到团队，自己的团队账号可取消共享回个人，自己的账号可删除。
  - 其他成员的团队账号可见但不可管理。
  - 非 owner 退出团队后，自己共享的团队账号变回个人账号；owner 不能退出。

### 假设

- 账号归属继续由 `provider_keys.team_id` 表达，不加新模式字段。
- 全局模式不自动混合额度，只允许用户显式选择生成时使用个人额度还是团队额度。
- 退出团队不清理个人账号，只清空自己共享给该团队的账号归属。
- 本轮不实现共享额度池、计费支付、团队 owner 转让、管理员代管团队账号。
