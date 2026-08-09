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
- **流程**：登录成功 → IPC 把 token 传给主进程 → 主进程加密落盘 → 重启时主进程解密校验 → 决定渲染哪个页面

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
  signUp(email, password, displayName): Promise<AuthResult>
  signIn(email, password): Promise<AuthResult>
  signOut(): Promise<void>
  getSession(): Promise<Session | null>   // 校验本地 token 有效性
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
auth:get-session      → 读本地加密 session，返回 { user } 或 null
auth:set-session      → 加密存 session（登录成功后调用）
auth:clear-session    → 删除本地 session（退出登录）
auth:get-mode         → 返回当前模式（hosted/selfhosted）+ 配置
auth:set-mode         → 保存模式 + Supabase 配置（自部署）
```

### 4.4 preload（`apps/desktop/src/preload/index.ts` 扩展）

```ts
auth: {
  getSession: () => Promise<{ user: User | null }>
  setSession: (session: Session) => Promise<void>
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
    RegisterForm.tsx      # 注册表单（邮箱+密码+显示名）
    ForgotPassword.tsx    # 忘记密码
    ModeSelect.tsx        # 首次启动选模式（官方托管 vs 自部署）
    SelfHostedConfig.tsx  # 自部署填 Supabase URL + anon key
  hooks/
    useAuth.ts            # 登录态 hook（供 App.tsx 门控）
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
| token 存储 | 主进程 safeStorage 加密，renderer 不接触明文 token |
| 网络 | 仅 HTTPS 连 Supabase |
| 自部署配置 | URL + anon key 存本地（明文可接受，anon key 本身是公开的） |
| 退出登录 | 清 session + 清本地缓存数据 |
| 会话过期 | 启动时 getUser 校验，401 自动跳登录页 |

## 6. UI 设计（沿用现有风格）

- 复用现有 `styles.css` 的变量（`--bg`、`--accent` 等），保持暗色主题一致
- 登录/注册页用无边框窗口内的居中卡片，顶部保留 TitleBar（最小化/关闭）
- 表单字段：邮箱、密码、显示名称（注册时）
- 错误提示：内联红色文字 + 顶部 toast

## 7. 实施步骤（建议顺序）

1. **实现 `packages/auth`**：AuthService + 双模式工厂（依赖 `@supabase/supabase-js`）
2. **实现 `packages/db-supabase`**：createSupabaseClient
3. **主进程扩展**：auth IPC handler + safeStorage 持久化
4. **preload 扩展**：暴露 auth API
5. **renderer 新增 AuthScreen 组件**：登录/注册/选模式/自部署配置
6. **App.tsx 接入 useAuth 门控**
7. **联调测试**：注册 → 登录 → 重启保持登录 → 退出登录

## 8. 依赖新增

- `@supabase/supabase-js`（加到 `packages/auth` 和 `packages/db-supabase`）
- 无需新增 Electron 依赖（safeStorage 内置）

---

**总结**：方案完全对齐需求文档 §10.2 的首次启动流程，采用 Supabase Auth + Electron safeStorage 持久化 + IPC 桥接 + React 登录页门控的架构。`packages/auth` 和 `packages/db-supabase` 两个空包正好是为此预留的，实现后即可打通"注册 → 登录 → 主界面"的完整链路。