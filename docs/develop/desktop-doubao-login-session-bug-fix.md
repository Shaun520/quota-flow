# 豆包 Cookie 失效问题修复记录

> 修复日期：2026-08-11
> 修复范围：apps/desktop 主进程 + 渲染进程 + packages/db-supabase

---

## 一、问题描述

豆包账号登录后：
1. 登录时提示 **"登录态校验失败（cookie + storage 未能在干净环境生效）"**
2. 生成时提示 **"豆包账号未登录（cookie 可能已失效）"**，但页面实际上已能打开并显示输入框，仅因检测到导航栏的「登录」按钮就误判

日志特征：
```
ERR_CONNECTION_CLOSED / passport.doubao.com / sso.doubao.com / auth.doubao.com
handshake failed; SSL error code 1, net_error -100
handshake failed; SSL error code 1, net_error -103
```

---

## 二、根因分析

### 根因 1（核心）：Cookie Domain 语义丢失（域 cookie → host-only）

豆包的会话 cookie（`sessionid`、`uid` 等）是 **domain cookie**：
```
domain=".doubao.com"   ← 前导点号，匹配所有子域名：www.doubao.com、v.doubao.com…
```

`injectCookies` 构造 URL 时去掉了前导点 `replace(/^\./, '')`，然后 Electron `cookies.set({ url: 'https://doubao.com/' })` **只传 url，不传 domain 参数**，Electron 默认将其视为 **host-only cookie**（仅匹配精确域名 `doubao.com`）。

**结果**：`www.doubao.com` 收不到任何会话 cookie，所以注入了 0 条 cookie，也等于没注入。

### 根因 2：登录检测误判（导航栏「登录」按钮始终存在）

`inspectScript` 检测逻辑：
```typescript
const hasLogin = /登录|扫码|手机号|验证码/.test(btns.join(' '))
```
豆包导航栏右上角**始终有「登录」按钮**（无论是否登录）。已登录用户的页面自然也会命中这个检测，导致被误判为「未登录」。

### 根因 3：多 Origin Storage 收集触发无效请求（错误日志刷屏）

`DOUBAO_ORIGIN_CANDIDATES` 中包含以下域名，但这些域名**并不存在或 SSL 证书无效**：
- `sso.doubao.com` → `ERR_CONNECTION_CLOSED`
- `passport.doubao.com` → `ERR_CONNECTION_CLOSED`
- `auth.doubao.com` → `ERR_CONNECTION_CLOSED`
- `signin.volcengine.com` → `ERR_BLOCKED_BY_RESPONSE`

用 `iframe` 批量访问这些域名时，会产生大量 SSL 握手失败 / 连接关闭日志。虽然加了 3 秒超时后脚本不再挂起，但这些无效请求本身是多余的。

### 根因 4：validateDoubaoCookies 强制校验阻断

跨分区校验本身不可靠：即使 UA 统一、cookie 注入正确，豆包服务端仍可能根据 **IndexedDB / Service Worker / 浏览器指纹** 判定为"新设备"并要求重新登录。把校验结果作为登录成功的硬性条件，导致大量合法登录被误拦截。

### 根因 5：新增账号流程未激活候选 C（登录分区 ≠ 生成分区）

`Modals.tsx` 调用 `providers.login(providerId)` **不传 keyId**，登录在 `persist:qf-p:doubao` 分区；
生成时使用 `persist:qf-p:doubao:<keyId>` 分区，分区不同，登录态需要跨分区迁移，而迁移本身不可靠。

同时 `collectPartitionCookies(providerId)` **不接受 keyId 参数**，始终读默认分区，当后续有传 keyId 的场景时会读错分区。

---

## 三、修复方案

### 修复 1：Cookie 注入显式传 domain 参数（保留域 cookie 语义）

**改动 3 处**：`webview-engine.ts injectCookies`、`providers.ts injectCookies`、`providers.ts validateDoubaoCookies 注入`

```typescript
// Before（错误）：只传 url，Electron 把 domain cookie 降级为 host-only
await ses.cookies.set({
  url: `https://${c.domain.replace(/^\./, '')}${c.path || '/'}`,
  name: c.name,
  value: c.value,
  ...
})

// After（正确）：显式传 domain，保留 ".doubao.com" 域语义
const cleanDomain = (c.domain || '').replace(/^\./, '') || 'www.doubao.com'
await ses.cookies.set({
  url: `https://${cleanDomain}${c.path || '/'}`,
  domain: c.domain || undefined,   // ← 显式保留原始域 cookie
  name: c.name,
  value: c.value,
  ...
})
```

Electron 文档说明：`cookies.set` 同时传 `url` 和 `domain` 时，以 `domain` 为准。domain 参数支持前导点号（domain cookie）、无前导点号（host-only）或 undefined（根据 url 推断 host-only）。

### 修复 2：登录检测改为「登录墙 ∨ 无用户信息」双条件

**改动 3 处**：`webview-engine.ts inspectScript`、`providers.ts 登录轮询`、`providers.ts 校验轮询`

```typescript
// Before（误判）：导航栏常驻「登录」按钮命中
const hasLogin = btns.some((t) => /^(登录|立即登录)$/.test(t))

// After（准确）：检测登录墙按钮 + 用户头像/昵称
const hasLoginWall = btns.some((t) =>
  /^(扫码登录|立即登录|手机号登录|短信登录)$/.test(t)
)
const hasAvatar = !!document.querySelector(
  '[class*="avatar" i], [class*="userinfo" i], [class*="user-info" i]'
)
const hasLogin = hasLoginWall || !hasAvatar  // 有登录墙 或 无用户信息 = 未登录
```

同时在生成的错误日志中暴露 `hasLoginWall` 和 `hasUserInfo` 两个子字段，便于后续排查。

### 修复 3：去掉多 Origin iframe 收集（消除错误日志）

移除 `DOUBAO_ORIGIN_CANDIDATES` 常量和所有 iframe 跨域访问逻辑，只收集**当前页面 origin**的 localStorage + sessionStorage。

理由：
1. 会话 cookie（`sessionid` / `uid` / `sso` 等）由 Electron session 统一管理，`ses.cookies.get({})` 已经跨 origin 收集完整
2. localStorage **按 origin 隔离**，而豆包主站（www.doubao.com）本身就有完整会话状态，不需要额外去其他域名读
3. 那些域名实际上不存在或被墙，iframe 请求只会产生无效错误日志

### 修复 4：validateDoubaoCookies 改为非阻断式

校验结果不再作为登录成功的硬性条件，仅写入 `fingerprint-debug.jsonl`（`type: validate-result`）供事后排查。

```typescript
// 5) 非阻断式校验：跨分区校验本身不可靠（豆包会话可能绑定指纹），
//    不应作为登录成功的硬性条件。校验结果仅记录到日志，不影响登录流程。
let validateOk = false
try {
  validateOk = await validateDoubaoCookies(cookies, storages, legacyEntries)
} catch {}
appendFingerprintDebug({
  type: 'validate-result',
  providerId,
  keyId: keyId || null,
  validateOk
})
```

真正的登录态最终由「生成引擎在生成分区里实际打开页面」完成检查。

### 修复 5：候选 C 真正激活（登录分区 = 生成分区）

新增账号流程也共用同一分区：

1. **前端（Modals.tsx）**：点击登录时生成 `tempId = crypto.randomUUID()`，传 `providers.login(providerId, tempId)`
2. **登录窗口（providers.ts）**：使用分区 `persist:qf-p:doubao:<tempId>`，登录直接在该分区完成
3. **新建账号记录（db-supabase）**：`AddProviderKeyInput.id` 字段，把 `tempId` 作为 DB 记录 `id` 保存
4. **生成流程**：用 `persist:qf-p:doubao:<keyId>`（= DB id = tempId），**登录、生成分区完全相同**，无需跨分区迁移
5. **指纹匹配或用户选择刷新已有账号**：`migratePartition(srcTempId → dstKeyId)` 把 cookie 从临时分区迁移到目标账号分区，然后清空临时分区

**新增 IPC：provider:migrate-partition**
```typescript
ipcMain.handle('provider:migrate-partition', async (_e, providerId, srcKeyId, dstKeyId) => {
  const cookies = await collectPartitionCookies(providerId, srcKeyId)
  await injectCookies(providerId, cookies, dstKeyId)
  await session.fromPartition(`persist:qf-p:${providerId}:${srcKeyId}`).clearStorageData()
  return { ok: true, cookieCount: cookies.length }
})
```

**配套修复**：`collectPartitionCookies(providerId, keyId?)` 接受 keyId 参数，始终读正确分区。

---

## 四、改动文件清单

| 文件 | 改动内容 |
|---|---|
| [providers.ts](file:///d:/project/quota-flow/apps/desktop/src/main/providers.ts) | ① injectCookies 显式传 domain<br>② validateDoubaoCookies 注入同修复①+去掉 iframe 脚本<br>③ openLoginWindow：iframe 收集简化为单 origin、keyId 分区、storage 超时+cookie 稳定监听、校验改为非阻断<br>④ collectPartitionCookies 加 keyId 参数<br>⑤ 登录/校验页面 DOM 检测改为登录墙+头像双条件<br>⑥ 新增 provider:migrate-partition IPC |
| [webview-engine.ts](file:///d:/project/quota-flow/apps/desktop/src/main/webview-engine.ts) | ① injectCookies 显式传 domain<br>② inspectScript 改为登录墙+头像双条件<br>③ 去掉 iframe 多 origin 注入，只注入当前页面 storage<br>④ inspectScript 类型注解扩展 hasLoginWall/hasUserInfo |
| [dispatch.ts](file:///d:/project/quota-flow/apps/desktop/src/main/dispatch.ts) | parseProviderCredentials 解析 v2 storage 格式，生成时把 storages 传入 runDoubaoGeneration |
| [preload/index.ts](file:///d:/project/quota-flow/apps/desktop/src/preload/index.ts) | ① login/healthCheck/cancelLogin 加可选 keyId 参数<br>② 新增 migratePartition API 类型 + 实现 |
| [Modals.tsx](file:///d:/project/quota-flow/apps/desktop/src/renderer/src/components/Modals.tsx) | ① 新增 loginTempId state<br>② 登录点击时生成 tempId 并传给 login<br>③ saveEncrypted 新建时 id=tempId，刷新时调用 migratePartition |
| [db-supabase index.ts](file:///d:/project/quota-flow/packages/db-supabase/src/index.ts) | AddProviderKeyInput 加 id 字段，addProviderKey 支持自定义 id |

---

## 五、验证步骤

1. **清除旧缓存**：在 Electron 应用数据目录（`%APPDATA%\quota-flow`）删除 `Partitions/` 目录下的 `qf-p:doubao*` 分区
2. **厂商页新增豆包账号**：扫码登录
   - 观察控制台不再出现 `sso.doubao.com` / `passport.doubao.com` 错误日志
   - 观察 `fingerprint-debug.jsonl` 中 `login-collected.storageOrigins` 为 `[{origin, localStorage, sessionStorage}]`（单 origin）
   - 不再被强制校验阻断
3. **确认 DB 记录 id = loginTempId**：`provider_keys.id` 是一个 UUID，和登录时的 tempId 一致
4. **调度台生成**：选择刚刚新增的豆包账号，发起 5 秒文生视频
   - inspect 结果中 `hasLogin: false`，`hasUserInfo: true` 或 `hasLoginWall: false`
   - 正常进入「视频生成」页面并完成生成

---

## 六、关键结论

1. **Electron `cookies.set` 必须显式传 `domain` 参数**：只传 url 会把 domain cookie 降级为 host-only cookie，子域名收不到。所有跨子域名的 cookie 注入都要注意这个坑。
2. **豆包导航栏的「登录」按钮不能作为未登录判定依据**：它常驻在导航栏，检测未登录必须依赖「登录墙大号按钮」或「用户头像缺失」的组合特征。
3. **跨 partition 校验不可靠**：即使 cookie/storage 全部正确，Electron 底层的 IndexedDB / Service Worker / 设备指纹差异仍会导致豆包把"已登录会话"判定为"新设备需要重新登录"。跨分区搬运只能作为兜底，优先方案是让登录与生成分区相同。
4. **iframe 收集多 origin storage 前要先验证域名连通性**：不要假设 `sso.<domain>` / `passport.<domain>` 这类域名一定存在。
