# 公共通知模块 + App 更新方案

> 更新时间：2026-08-13

## Summary

- 后台公告页从静态原型改为真实管理页：发布、编辑、下架/恢复、删除（软删除），并写 `audit_logs`。
- 桌面端右上角用户区新增铃铛：点开显示通知下拉，点击条目打开详情弹窗；未读角标用本地存储记录。
- App 更新不在公告里做安装逻辑；公告只作为“版本更新说明”。实际更新走 `electron-updater` + GitHub Releases，桌面端启动/手动检查并下载安装。

## 数据/接口变化

- 新增迁移 `migrations/0011_announcements_notifications.sql`，扩展现有 `announcements`：
  - `kind text not null default 'notice' check (kind in ('notice','update'))`
  - `published boolean not null default true`
  - `created_by uuid null references profiles(id)`
  - `updated_at timestamptz default now()`
  - `deleted_at timestamptz null`
- 调整 RLS：`announcements_select_all` 改为只允许 authenticated 读取 `published = true and deleted_at is null`；admin 保留全量管理。
- Admin 新增 `apps/admin/src/lib/api/announcements.ts`：`listAnnouncements`、`createAnnouncement`、`updateAnnouncement`、`deleteAnnouncement`、`togglePublished`；操作成功后写 `audit_logs`。
- 桌面端新增 `useAnnouncements` hook 和 `NotificationBell` 组件，读取 `announcements` 的 `target = 'all'` 已发布未删除记录。

## Admin 公告页

- 替换 `apps/admin/src/app/(dashboard)/announcements/page.tsx` 静态 `PrototypePage`。
- 页面先渲染列表骨架/空态，再异步拉数据；支持搜索标题和按类型筛选（全部/公告/版本更新）。
- 列表项显示：类型徽标、标题、发布时间、发布状态、内容摘要；操作按钮为编辑、发布/下架、删除。
- 发布/编辑弹窗字段：类型、标题、内容、是否立即发布；MVP 只发送给全部用户，不展示团队选择。
- 删除使用软删除，列表不显示已删除记录；后台记录 `announcement.delete` 等审计事件。

## 桌面端铃铛与详情

- 在 `apps/desktop/src/renderer/src/App.tsx` 的 `.user-area` 中，`team-badge` 和 `avatar-wrap` 之间插入铃铛按钮；点击展开通知下拉，而不是 hover。
- 下拉展示最新 50 条通知，最多显示标题、时间、类型；未读数量显示角标；点击条目打开详情 Modal 并标记该条已读。
- 已读状态按用户保存在 `localStorage`，key 使用 `qf:announcements:read:<userId>`；换设备不共享，符合当前 MVP。
- 拉取时机：登录/应用进入后拉一次，打开铃铛时重新拉一次；同时订阅 Supabase Realtime，新发布/下架/删除后即时刷新。

## App 更新

- `apps/desktop/package.json` 增加 `electron-updater`。
- `electron-builder.yml` 增加 `publish` GitHub Releases 配置：owner `Shaun520`，repo `quota-flow`，private `false`。
- 主进程接入 `autoUpdater`：启动后静默检查、下载；通过 IPC 向渲染进程推送状态（检查中/无更新/可下载/已下载）。
- 渲染进程暴露更新状态：状态栏或设置中显示“发现新版本”，下载完成后提供“重启安装”；不把安装逻辑放进公告。
- 公告类型 `kind='update'` 仅用于展示版本说明，实际版本安装由 `electron-updater` 处理。

## Test Plan

- 执行迁移后，admin 发布一条公告：桌面端在线时铃铛即时出现；下架/删除后即时消失。
- 创建 `kind=update` 的版本公告，桌面端铃铛显示版本更新类型；同时验证 `electron-updater` 能按配置检查到 GitHub Releases 更新。
- Admin 跑 `pnpm --filter @quota-flow/admin typecheck`；桌面端跑 `pnpm --filter @quota-flow/desktop typecheck`。
- 验证未读角标：点击详情后该条不再计入未读；重新登录同一用户本地已读仍保留。
- 验证删除/编辑/发布切换均写入 `audit_logs`，且 RLS 不会让普通用户读到草稿或已删除公告。

## Assumptions

- MVP 桌面端只显示 `target = 'all'` 通知，后台也只发布全部用户通知；团队通知后续再做。
- 已读状态采用本地存储，不新增 `announcement_reads` 表。
- 删除采用软删除，避免普通用户读到已删除内容，也便于审计。
- 自动更新使用 GitHub Releases；当前仓库远程为公开仓库 `Shaun520/quota-flow`。
