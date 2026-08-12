# 会话过期自动续期 + 重新登录提示（修复记录）

> 修复日期：2026-08-12
> 修复范围：packages/auth（新增 refreshSession）+ apps/desktop 渲染进程（会话守卫、useAuth、数据层兜底、生成前保鲜）

---

## 一、问题描述

用户反馈：调度台「厂商」和「历史记录」突然全部为空，**没有红色报错**，退出登录再重新登录一次仍为空，疑似数据丢失。

排查后确认数据未丢失，真正问题是**应用侧 Supabase 登录态过期后没有自动续期，查询被 RLS 静默挡成空列表**，界面看起来像“数据没了”。

---

## 二、排查结论（证据）

1. **数据完好**：用用户本机存储的登录态直接查 Supabase：
   - `jobs`：21 条；`provider_keys`：5 个（豆包 3、元宝 2）；`quota_ledger`：16 条；`providers`：7 家。
   - 同一会话（`setSession`）能正常读到全部数据，说明 RLS 与数据本身没问题。
2. **代码/构建正常**：带远程调试（CDP）启动当前构建、用与运行应用一致的 userData，厂商数据正常显示（豆包 19/20、元宝 10/10）。
3. **根因**：`createSupabaseClient` 配置了 `autoRefreshToken: false`，access token 1 小时过期后客户端**不会自动续期**；过期后 REST 查询返回 401，被 RLS 挡成空数组，**且不抛错** → 页面空、无红字。

> 诊断细节：`auth.json` 用 Electron safeStorage（DPAPI）加密，独立脚本需 `app.setPath('userData', …)` 指向运行应用的用户目录才能解密；直接 `electron.exe out/main/index.js` 会因应用名变成默认 `Electron` 而读不到会话，需用 `app.setName('@quota-flow/desktop')` 包装入口复现真实环境。

---

## 三、修复方案（四层防护）

### 1. AuthService 增加主动续期能力

`packages/auth/src/service.ts`：

```typescript
async refreshSession(): Promise<Session | null> {
  const { data, error } = await this.client.auth.refreshSession()
  if (error) return null
  return data.session ?? null
}
```

### 2. 新增会话守卫模块

`apps/desktop/src/renderer/src/auth/session.ts`：

- `ensureFreshSession()`：检查当前 token 有效期，**到期前 2 分钟自动用 refresh token 续期**；续期成功把新 token 写回 `auth.json`；续期失败清空登录态并广播 `onSessionExpired`。模块级锁防止并发重复刷新。
- `isAuthError(e)`：识别 JWT 过期/无效、401/403 等鉴权类错误。
- `onSessionExpired(cb)`：失效通知订阅，供 useAuth 清理界面状态。

### 3. 登录态生命周期管理

`apps/desktop/src/renderer/src/hooks/useAuth.ts`：

- 启动恢复会话后先 `ensureFreshSession()`，保证进入应用就是新鲜 token；
- 订阅 `onSessionExpired`：续期失败 → 清空 user/team，登录页显示红字“**登录已过期，请重新登录**”；
- 常开场景：**到期前 60 秒定时自动续期**，续期成功后按新 expires_at 重新排程（循环）。

### 4. 数据层与生成入口兜底

- `useJobs.ts` / `useProviders.ts`：查询遇到鉴权类错误 → `ensureFreshSession()` → **仅当真正刷新过才重试一次**（避免死循环）；刷新失败则提示重新登录。
- `Dashboard.tsx handleGenerate`：生成前先 `ensureFreshSession()`，保证传给主进程的 access/refresh token 新鲜。

---

## 四、代码位置

| 文件 | 改动 |
| --- | --- |
| `packages/auth/src/service.ts` | 新增 `refreshSession()` |
| `apps/desktop/src/renderer/src/auth/session.ts` | 新增：`ensureFreshSession` / `isAuthError` / `onSessionExpired` |
| `apps/desktop/src/renderer/src/hooks/useAuth.ts` | 恢复时强校验、订阅失效通知、到期前 60s 定时续期 |
| `apps/desktop/src/renderer/src/hooks/useJobs.ts` | 鉴权错误 → 自动续期 → 重试一次 |
| `apps/desktop/src/renderer/src/hooks/useProviders.ts` | 同上 |
| `apps/desktop/src/renderer/src/components/Dashboard.tsx` | 生成前 `ensureFreshSession()` |

---

## 五、验证情况

- ✅ `packages/auth` 重新构建（tsup）
- ✅ `apps/desktop` typecheck + build 通过
- ✅ 带 CDP 启动构建验证：正确 userData 下厂商数据正常加载
- ⏳ 需用户实测：应用常开跨过 access token 到期点（约 1 小时），确认自动续期生效、数据不消失；以及将 refresh token 置为无效后，确认回到登录页并提示“登录已过期，请重新登录”

---

## 六、后续可改进

- 主进程 `dispatch:generate` 的 `setSession` 本身会携带 refresh token 自动续期（supabase-js 行为），本次未改动；后续可在主进程侧统一加超时/失败提示。
- 续期失败时可记录一次告警日志（当前仅 UI 提示），便于远程定位。
- 若后续启用多窗口，需把 `onSessionExpired` 事件升级为跨窗口广播。
