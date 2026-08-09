# 桌面端登录注册系统方案

> 状态：待实施（设计稿）
> 日期：2026-08-09
> 适用范围：apps/desktop（Electron + Vite + React）
> 关联需求：REQUIREMENTS.md §10.2 首次启动流程
> 关联包：packages/auth、packages/db-supabase

## 1. 现状分析

| 项 | 现状 |
|---|---|
| 桌面端 | Electron + Vite + React（apps/desktop），纯前端 UI 演示，数据来自静态 `data.ts` |
| `packages/auth` | 空壳（仅 `export {}`），需实现 Supabase Auth 封装 |
| `packages/db-supabase` | 空壳（仅 `export {}`），需实现 Supabase 客户端 |
| 需求文档 | REQUIREMENTS.md §10.2 已定义首次启动流程：**欢迎页选模式 → 内嵌注册/登录 → 进入主界面** |

## 2. 总体架构

```
┌─────────────────────────────────────────────────────────────┐
│                    桌面端 Electron                            │
│                                                             │
│  ┌──────────────┐   ┌────────────────────────────────────┐  │
│  │  React UI    │   │  packages/auth（Supabase Auth 封装） │  │
│  │  登录/注册页  │──▶│  packages/db-supabase（客户端）      │  │
│  └──────┬───────┘   └──────────────┬─────────────────────┘  │
│         │                          │                        │
│         │  IPC（preload 桥接）      │ 直连 Supabase           │
│         ▼                          ▼                        │
│  ┌──────────────────────────────────────────────────────┐   │
│  │  Electron 主进程（main/index.ts）                      │   │
│  │  • 安全存储 session（safeStorage 加密）                 │   │
│  │  • 启动时校验登录态 → 决定渲染登录页 or 主界面           │   │
│  └──────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────┘
```

## 3. 核心设计决策

### 3.1 认证方式：Supabase Auth（官方托管 + 自部署双模式）

需求文档明确两种模式共用同一套 Supabase Auth：

- **官方托管**：连内置 Supabase（URL + anon key 编译进包）
- **自部署**：用户首次启动填自己的 Supabase URL + anon key，存本地

**关键点**：`packages/auth` 封装成"可配置 Supabase 客户端"，启动时根据模式注入不同配置。

### 3.2 登录态持久化：Electron safeStorage（而非 localStorage）

- **为什么不用 localStorage**：renderer 的 localStorage 可被 XSS 读取，且 Electron 中不安全
- **方案**：session token 存主进程，用 `safeStorage.encryptString()` 加密后写本地文件（`app.getPath('userData')/auth.json`）
- **流程**：登录成功 → IPC 仅传 3 个最小 token 字段（见 3.5）给主进程 → 主进程加密落盘（入参随即清零） → 重启时主进程解密校验 → 决定渲染哪个页面

### 3.3 页面路由：登录态门控（Auth Gate）

```
App.tsx 启动
  │
  ├─ 主进程校验本地 session（IPC: auth:get-session）
  │
  ├─ 无 session → 渲染 <AuthScreen>（登录/注册/选模式）
  │
  └─ 有 session → 校验 Supabase（getUser）→ 有效 → 渲染主界面
                              └─ 无效 → 清 session → 渲染 <AuthScreen>
```

### 3.4 首次启动流程（对应需求 §10.2）

```
首次启动
  │
  ▼
欢迎页（选模式）
  ├─ 官方托管（推荐）→ 直接进登录/注册
  └─ 自部署 → 填 Supabase URL + anon key → 存本地 → 进登录/注册
  │
  ▼
登录 / 注册页（内嵌，无边框窗口内）
  │
  ▼
进入主界面（App.tsx 现有 4 Tab）
```

### 3.5 token 最小化：IPC 只传必要字段

原则：**渲染进程是唯一持久化方，renderer 不拿 refresh token、不落盘任何 token**。

| 通道 | 内容 | 说明 |
|---|---|---|
| set（renderer → main） | `{ accessToken, refreshToken, expiresAt }` 三字段 | 不传整个 Session 对象；user 元数据由主进程 `auth.getUser()` 从 token 解析 |
| get（main → renderer） | `{ user, expiresAt }` | 返回类型不含 token，API 层面杜绝回传 |
| refresh（main → renderer） | `{ accessToken, expiresAt }` | 全系统唯一单向 token 回传路径，见 3.6 |

- 处理完成后两端立即清零：`setSession` 主进程落盘后清零入参引用，renderer 拿到 access token 用完即置 `null`
- 不开启任何 token 日志：禁 console 打印、主进程 `safeStorage` 出错时不输出明文、devtools 关闭
- **为什么 access token 必然在 renderer**：账本/jobs 等业务请求由 renderer 直连 Supabase 发起，access token 必须在浏览器侧；最小化目标 = refresh token 永不出主进程 + IPC 字段最少化

### 3.6 会话续期与 401 处理

```
过期判定
  ├─ 启动：主进程 getUser 校验；距 expiresAt < 60s 时先续期再校验
  └─ 运行：主进程定时器按 expiresAt 提前 60s 触发 refresh-session（静默续期）
              ↓
续期（仅在主进程执行，持有 refresh token）
  ├─ 成功 → 新 access token 下发 renderer + 加密覆盖落盘
  └─ 失败（refresh 失效/撤销/断网）→ clear-session → 推送 renderer → 跳登录页
              ↓
renderer 兜底：业务请求收到 401 / AuthSessionMissingError / AuthInvalidJwtError
  ├─ 若主进程未续期 → 调 refresh-session 重试 1 次（最多 1 次）
  └─ 仍失败 → 放弃重试，清本地态 → <AuthScreen>，避免死循环
```

- 静默续期优先、renderer 兜底仅 1 次，防止请求风暴
- 退出登录时需连同 refresh token 一并销毁（主进程），否则未登出的 refresh 仍可用

### 3.7 用户与团队绑定（方案 B：team 可空态）

需求 §5.7/§5.8 已定义 `teams / team_members / team_invitations` 与 RLS 规则，本节补充会话层的衔接约定：

**会话上下文**
- `getSession` 返回 `user` 时 join 一次 `team_members`（按 `user_id`），得出 `team: { id, role } | null`
- 注册新用户默认 `team = null`（贴合个人免费档：无团队池）；`team_members` 查询放 `db-supabase`，auth 层不感知
- 个人→团队的切换点只有 `team_members` 一行，会话每次校验都实时读，无本地缓存过期问题

**绑定入口（三处）**
1. **注册页**：可选填邀请码（`team_invitations.token`，8 位大写随机，72h 过期，码内含目标角色）；有码 → 创建 profile 后直接插 `team_members`
2. **团队 Tab**：`创建团队`（建 `teams` + `team_members`(admin, 1人)）或 `输入邀请码加入`（供已登录未入队成员）
3. **admin** 在团队 Tab 生成邀请码（团队内共享），过期作废

**业务关联约定**
- `jobs / quota_ledger / member_usage / provider_keys` 全部带 `team_id` 列，客户端一律传当前 `team.id`
- 权限不信任客户端：所有 RLS 用 `auth.uid() ↔ team_members.team_id` 校验，客户端传任意 team_id 也查不到数据（对应 §5.8）
- `team = null` 时仅允许本地看板（静态 data.ts）与演示操作，任何写操作引导先创建/加入团队，防止孤儿数据

## 4. 模块划分与实现清单

### 4.1 `packages/auth`（Supabase Auth 封装）

```ts
// 核心 API
export interface AuthConfig {
  supabaseUrl: string
  supabaseAnonKey: string
}

export class AuthService {
  constructor(config: AuthConfig)
  signUp(email, password, displayName, inviteCode?): Promise<AuthResult>  // inviteCode 见 3.7
  signIn(email, password): Promise<AuthResult>
  signOut(): Promise<void>
  getSession(): Promise<Session | null>   // 校验本地 token 有效性
  getTeamContext(): Promise<{ id: string; role: 'admin' | 'member' } | null>  // 经 db-supabase join team_members
  onAuthStateChange(cb): Unsubscribe
  resetPassword(email): Promise<void>
}

// 双模式工厂
export function createAuthService(mode: 'hosted' | 'selfhosted', config?: AuthConfig): AuthService
```

### 4.2 `packages/db-supabase`（Supabase 客户端）

```ts
export function createSupabaseClient(config: AuthConfig): SupabaseClient
// 供 packages/auth 和后续业务（账本、jobs、团队）共用
```

### 4.3 主进程（`apps/desktop/src/main/index.ts` 扩展）

新增 IPC handler：

```
auth:get-session        → 读本地加密 session，返回 { user, expiresAt, team } 或 null（不含 token）
auth:set-session        → 入参 { accessToken, refreshToken, expiresAt }，加密落盘后清零（登录成功后调用）
auth:refresh-session    → 主进程用 refresh token 续期；成功回传 { accessToken, expiresAt }，失败清 session 返回 null
auth:clear-session      → 删除本地 session（含 refresh token，退出登录）
auth:get-mode           → 返回当前模式（hosted/selfhosted）+ 配置
auth:set-mode           → 保存模式 + Supabase 配置（自部署）
```

### 4.4 preload（`apps/desktop/src/preload/index.ts` 扩展）

```ts
auth: {
  getSession: () => Promise<{
    user: User | null
    expiresAt: number | null
    team: { id: string; role: 'admin' | 'member' } | null   // join team_members 得出（见 3.7）
  }>  // 永不返回 token
  setSession: (t: { accessToken: string; refreshToken: string; expiresAt: number }) => Promise<void>
  refreshSession: () => Promise<{ accessToken: string; expiresAt: number } | null>
  clearSession: () => Promise<void>
  getMode: () => Promise<{ mode: 'hosted' | 'selfhosted'; config?: AuthConfig }>
  setMode: (mode, config?) => Promise<void>
}
```

### 4.5 renderer 新增组件

```
src/renderer/src/
  auth/
    AuthScreen.tsx        # 登录/注册容器（含模式切换）
    LoginForm.tsx         # 登录表单
    RegisterForm.tsx      # 注册表单（邮箱+密码+显示名+可选邀请码）
    ForgotPassword.tsx    # 忘记密码
    ModeSelect.tsx        # 首次启动选模式（官方托管 vs 自部署）
    SelfHostedConfig.tsx  # 自部署填 Supabase URL + anon key
  hooks/
    useAuth.ts            # 登录态 hook（含 team 上下文，供 App.tsx 门控 + 各 Tab）
  team/
    TeamGuide.tsx         # Team.tsx 无 team 时的引导：创建团队 / 输入邀请码
    InviteCode.tsx        # admin 生成/复制 8 位邀请码（含有效期展示）
```

### 4.6 App.tsx 改造

```tsx
export default function App() {
  const { user, loading } = useAuth()
  if (loading) return <SplashScreen />
  if (!user) return <AuthScreen />
  return <MainApp />   // 现有主界面
}
```

## 5. 安全设计

| 项 | 方案 |
|---|---|
| token 存储 | 主进程 safeStorage 加密；IPC 最小化（见 3.5）：get 无 token、set/refresh 仅必要字段 |
| token 明文面 | access token 仅 renderer 持有（业务请求必需）；refresh token 仅主进程持有（续期唯一执行方） |
| 内存清零 | set/refresh 结束即刻置空局部变量；不打印、不写入任何日志 |
| 网络 | 仅 HTTPS 连 Supabase |
| 自部署配置 | URL + anon key 存本地（明文可接受，anon key 本身是公开的） |
| 退出登录 | 清 session（含 refresh token）+ 清本地缓存数据 |
| 会话过期 | 主进程提前 60s 静默续期；401 兜底重试 1 次后回登录页（见 3.6） |
| 团队权限 | RLS 一律 `auth.uid() ↔ team_members` 校验，不信任客户端传入的任意 team_id（见 3.7） |

## 6. UI 设计（沿用现有风格）

- 复用现有 `styles.css` 的变量（`--bg`、`--accent` 等），保持暗色主题一致
- 登录/注册页用无边框窗口内的居中卡片，顶部保留 TitleBar（最小化/关闭）
- 表单字段：邮箱、密码、显示名称（注册时）
- 错误提示：内联红色文字 + 顶部 toast

## 7. 实施步骤（建议顺序）

1. **实现 `packages/auth`**：AuthService + 双模式工厂（依赖 `@supabase/supabase-js`）
2. **实现 `packages/db-supabase`**：createSupabaseClient
3. **主进程扩展**：auth IPC handler（含 refresh-session 定时续期）+ safeStorage 持久化
4. **preload 扩展**：暴露 auth API（getSession 无 token，set/refresh 最小字段）
5. **renderer 新增 AuthScreen 组件**：登录/注册/选模式/自部署配置
6. **App.tsx 接入 useAuth 门控**（Team.tsx 同步接入 team 状态：无团队显示引导）
7. **联调测试**：注册（带邀请码入队 / 无码）→ 团队创建/加入 → 重启保持登录 → 挂机至 token 过期自动续期（不掉线） → 401 兜底回登录页 → 退出登录

## 8. 依赖新增

- `@supabase/supabase-js`（加到 `packages/auth` 和 `packages/db-supabase`）
- 无需新增 Electron 依赖（safeStorage 内置）

---

**总结**：方案完全对齐需求文档 §10.2 的首次启动流程，采用 Supabase Auth + Electron safeStorage 持久化 + IPC 桥接 + React 登录页门控的架构。token 遵循最小化原则（refresh 只进主进程、get 永不含 token），续期统一由主进程集中执行、401 兜底一次，避免 renderer 长期持有明文凭据。`packages/auth` 和 `packages/db-supabase` 两个空包正好是为此预留的，实现后即可打通"注册 → 登录 → 主界面"的完整链路。