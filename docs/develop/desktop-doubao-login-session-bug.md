# 豆包登录态跨分区失效 Bug 排查记录（未解决）

> 记录日期：2026-08-10
> 状态：**未解决**，已尝试 5 轮修复仍未通过「干净环境登录态校验」，留待后续排查
> 范围：Quota-Flow 桌面端（Electron）豆包 WebView 生成链路

---

## 1. 现象

调度台点「开始生成」报错：

```
豆包账号未登录（cookie 可能已失效），请在厂商页重新登录后重试
{"url":"https://www.doubao.com/chat/","title":"豆包 - 字节跳动旗下 AI 智能助手","inputFound":true,"inputTag":"textarea","hasLogin":true,"buttons":["下载电脑版","登录",...]}
```

即：**登录窗口明明完成了扫码登录，但收集到的凭据（cookie / cookie+localStorage）注入全新分区后，豆包仍显示登录墙**。

## 2. 已确认的关键事实（证据）

1. **登录成功过、也传输成功过**：2026-08-10 20:01 通过登录窗口收集的 cookie（`data/doubao-auth.json`），在 14:45 注入全新分区 `persist:qf-p:doubao:debug1` 实测**有效**（页面显示已登录、进入视频生成界面）。
2. **同一批 cookie 后来失效**：15:30 用同样方式注入全新分区，页面显示登录墙。推测是用户后续重新登录同一账号时，**豆包服务端把旧会话顶掉了**（每次新登录会使该账号旧 session 失效）。
3. **App 内新登录的凭据无法传输**：登录窗口「已完成登录」后收集的 cookie（含会话类 cookie），注入全新分区校验**失败**。
4. 页面登录态判定依据：可见按钮里有「登录」且无头像/账号标识（如 `yq6664578`）→ 未登录。

## 3. 已尝试的修复（按时间顺序）

| # | 修复 | 位置 | 结果 |
|---|---|---|---|
| 1 | 引擎检测「登录」按钮 → 明确报错 + 页面快照 + 截图 | `webview-engine.ts` | 诊断用，未解决 |
| 2 | 登录窗口：点「已完成登录」后轮询确认登录态（15s）+ 等 1.2s 再收集 + 校验含会话 cookie | `providers.ts` | 未解决（仍存无效 cookie） |
| 3 | 登录后**决定性校验**：把收集的 cookie 注入全新临时分区，能登录才保存 | `providers.ts` `validateDoubaoCookies` | 校验开始拒绝无效登录，但仍失败 |
| 4 | 登录时**同时收集 localStorage**，校验/生成时注入 cookie+localStorage 并刷新页面 | `providers.ts` + `webview-engine.ts` + `dispatch.ts` | **仍未通过校验** |
| 5 | 选号按「已失效」排序、失败自动换号、失败标记 expired | `dispatch.ts` | 辅助，未解决根因 |

存储格式已兼容新旧：新格式 `{ cookies, localStorage }`，旧格式为 `ProviderCookie[]`（`providers.ts: parseStoredCredentials`）。

## 4. 代码位置

- 登录窗口：`apps/desktop/src/main/providers.ts`（`openLoginWindow` → `collectPartitionCookies` → `validateDoubaoCookies`）
- 生成引擎：`apps/desktop/src/main/webview-engine.ts`（`runDoubaoGeneration`，分区 `persist:qf-p:doubao:<keyId>`）
- 调度选号：`apps/desktop/src/main/dispatch.ts`
- 调试产物：
  - 生成失败截图：`userData/debug/login-wall-*.png`
  - 登录收集元信息：`userData/fingerprint-debug.jsonl`（`type: login-collected`，含 cookie 名/域名/过期时间/localStorage 数量）

## 5. 未解决根因候选（按可能性排序，后续逐个验证）

### 候选 A：localStorage 来源/范围不完整（最可能）

登录窗口只收集**当前页面 origin（www.doubao.com）**的 localStorage。若豆包扫码登录发生在**弹窗（window.open 的 SSO origin，如 sso.doubao.com / passport）**里，会话 token 可能存于**其他 origin 的 localStorage/sessionStorage/IndexedDB**，主窗口的 localStorage 为空 → 传输后仍无登录态。

**验证方法**：登录完成后，在登录窗口执行脚本枚举 `localStorage` / `sessionStorage` / `indexedDB` 键值，并检查收集时 `location.href` 是否停留在 www.doubao.com（排除中间跳转页）。

### 候选 B：登录分区与生成分区 User-Agent 不一致

- 登录窗口 / 校验窗口：**未设置 UA**（默认 Electron UA）
- 生成引擎：`webview-engine.ts` 显式设置为 Chrome 143 UA

若豆包会话与 UA/设备指纹绑定，会导致「校验通过、生成失败」或双方不一致。**即使 14:45 的实测表明 UA 差异当时未阻断传输，也应统一三处 UA 后再验证。**

### 候选 C：会话强绑定原窗口环境（非迁移性）

可能依赖 sessionStorage、IndexedDB、Service Worker 缓存、或浏览器指纹（`fp`/`a_bogus` 签名上下文）。若 A/B 排除后仍失败，基本可判定为「不可跨分区迁移」。

**应对方案**：改为「**登录分区 = 生成分区**」——按账号使用独立分区（如 `persist:qf-p:doubao:<accountId>`），登录窗口和生成窗口共用同一分区，不做跨分区搬运；`provider_keys` 存分区标识（或约定 keyId 即分区名）。代价：换机器/清 userData 后需重新登录；但能彻底绕开会话迁移问题。

### 候选 D：收集时机仍过早

页面 UI 已显示登录态，但最终会话 cookie 在后续请求/跳转后才落定（已等 1.2s，可能不足）。可改为：收集后**持续监听分区 cookie 变化**，等 `sessionid` 类 cookie 出现且稳定后再收集。

## 6. 后续排查步骤建议

1. **先做候选 A 的验证**：登录完成后在登录窗口 dump 所有 storage（localStorage/sessionStorage/IndexedDB 各 origin），确认收集是否完整；若发现其他 origin 的 token，扩展收集与注入。
2. **统一 UA**：登录窗口、校验、生成三处使用同一 UA（候选 B）。
3. 若仍失败 → 直接上**候选 C 的「登录分区 = 生成分区」**方案（绕开迁移），这是兜底且大概率可行。
4. 每次验证后核对 `fingerprint-debug.jsonl` 的 `login-collected` 与失败截图，判断是「收集不全」还是「注入后仍无效」。

## 7. 关联

- 多账号方案与记账：`docs/develop/desktop-dispatch-doubao.md`
- 生成链路实现：`apps/desktop/src/main/webview-engine.ts`、`dispatch.ts`
