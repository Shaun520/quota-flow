# 火山引擎（火山方舟）API Key 绑定实施计划

> 范围：本轮只做 **火山方舟 API Key 绑定**（含 API Key 校验、控制台会话捕获、真实额度查询与展示、账号级去重）。
> 模型目录 / 视频生成（调度台生成能力）**本轮不做**（用户已明确「模型先只接有免费额度的，先暂时不接」），仅预留扩展点。
> 内部 id：`volcengine`；展示名：`火山方舟`。

---

## 1. 摘要

复用智谱（bigmodel）的「API Key 型厂商」接入模式（见 `docs/厂商与API平台接入/智谱AI开放平台账号绑定.md`），把火山方舟作为第二个 API Key 型厂商接入：

- 数据面：火山方舟视频生成 API 为 **Bearer Token 鉴权**（`Authorization: Bearer <ARK_API_KEY>`），与智谱相同，`test API Key` 可复用「明文哈希→只读接口校验」。
- 额度面：火山方舟 **API Key 无法查真实免费额度/资源包**（需火山控制台登录会话 + 内部接口），因此绑定流程需额外捕获**控制台会话**，存档后用其查真实额度（与智谱 `consoleJwt` 同构）。
- 会话会过期，本轮按 **C 级：自动续期** 设计（用户选定）——解析 JWT `exp`、临期/过期时用持久化分区 + 隐藏窗口**静默重捕获**新 JWT 并回写，无需用户手动操作；静默失败才回退本地账本并暴露「重新登录」入口。该机制做成**智谱/火山通用**，火山首期落地。
- 本轮交付：绑定弹窗支持火山方舟、捕获控制台会话并**自动续期**、账号页展示真实剩余额度、账号级去重。

---

## 2. 现状分析（智谱模板，已确认）

| 环节 | 智谱实现（含文件） | 火山要做的 |
|---|---|---|
| 加密存储 | `providers.ts` `decodeZhipuPayload`，格式 `{v:1,apiKey,consoleJwt}` + `safeStorage` | 新增 `decodeVolcenginePayload`，相同结构复用 `{v:1,apiKey,consoleJwt}` |
| 明文→指纹 | `zhipuAccountFingerprint`（customerId → `sha256(zhipu\|...c)`, 否则 key 哈希） | 新增 `volcengineAccountFingerprint` |
| 测试 Key | `testZhipuApiKey` 调 `GET /models` | 新增 `testVolcengineApiKey` 调火山只读接口 |
| 查额度 | `fetchZhipuQuota`（biz 接口+资源包过滤） | 新增 `fetchVolcengineQuota`（火山控制台额度接口） |
| 捕获会话 | `captureZhipuConsoleSession`（fetch+XHR hook 捕获 Bearer JWT） | 新增 `captureVolcengineConsoleSession`；并抽出**通用会话捕获内核**（可见/静默两模式），智谱/火山复用 |
| 过期续期 | 现状**无**：`fetchZhipuQuota` 无 JWT 时退用 API Key→401，`fetchZhipuQuotaOnce` 返回 null→回退本地账本展示，需手动重绑 | 新增 C 级自动续期（见 §5.9） |
| 绑定 UI | `Modals.tsx` AddProviderModal：zhipu 分支「获取 API Key」按钮、存 consoleJwt、去重 | 增加 volcengine 分支，复用同一骨架 |
| 额度刷新 | `useProviders.ts` `refreshZhipuQuota` + 30s 重试窗口 | 新增 `refreshVolcengineQuota` |
| 真实额度展示 | `Providers.tsx` L420 `isApiQuota` / L541、`Dashboard.tsx` L1021 | 条件扩展到 `volcengine` |
| DB seed | `migrations/0027_add_zhipu_provider.sql` | 新增 `migrations/0031_add_volcengine_provider.sql` |

导出链：`packages/providers/src/volcengine.ts`（新）→ `src/index.ts` 增加再导出；桌面端从 `@quota-flow/providers` 引入（主进程 `providers.ts` 已如此引入 zhipu 函数）。

---

## 3. 火山方舟接口调研结论（2026-08 官方文档核对）

### 3.1 视频生成数据面 API（本轮只用于校验 Key，生成后续再接）
- Host：`https://ark.cn-beijing.volces.com/api/v3`
- 鉴权：`Authorization: Bearer <ARK_API_KEY>`（数据面 API Key 鉴权，与智谱 id 相同，非签名 v4）
- 提交：`POST /contents/generations/tasks`，body `{ model, content:[{type,text|url}], parameters:{...} }` → 返回任务 `id`
- 查询：`GET /contents/generations/tasks/{id}`，`status ∈ queued/running/cancelled/succeeded/failed/expired`，视频在 `content.video_url`

### 3.2 校验 API Key（不产生费用）
- 用只读/开销为零的请求区分「无效 key(401)」：推荐 `GET /api/v3/contents/generations/tasks/{不存在id}`——有效 key 返回 404（未找到任务），无效 key 返回 401。
- 落地时先用 curl 实测确认该路径的 401/404 区分；若不可靠，再退化为控制台会话内校验（见 §5）。

### 3.3 真实免费额度 / 资源包（需控制台会话，本轮交付之一）
- 火山 API Key **无法**直接读取资源包/免费额度（同智谱 biz 域，属控制台内部 API）。
- 额度展示入口：`https://console.volcengine.com/ark/region:cn-beijing/openManagement?…&tab=ComputerVision`（用户提供）及 API Key 管理页 `https://console.volcengine.com/ark/region:cn-beijing/apikey`。
- **确切额度接口 / 请求头 / 响应字段需运行时抓包确认**（见 §6，为唯一开放性风险）。

---

## 4. 关键决策

1. **内部 id = `volcengine`，展示名 = `火山方舟`**（用户选定）。
2. **额度展示 = 控制台会话捕获**（用户选定：本轮就做控制台会话捕获，不退回「静态/账本」）。
3. **模型目录/生成能力本轮不做**：不新增 `provider_caps` 记录、不注册完整 `api-branch` 生成分支。
4. **额度查询优先「控制台同源内执行」**：火山控制台请求带 AK/SK 签名头（`Authorization`/`X-Auth-*`/`X-t-*signature`）且有会话 cookie 绑定，主进程盲发请求难以重放签名；改为在**捕获会话用的持久化分区 webview 页内**发起同源 `fetch` 查额度接口，把 JSON 传回主进程解析。这样签名与 cookie 自动带上，最稳。
5. **去重维度**：优先取火山账号标识（uid / IAM / customer），取不到则回退 API Key 哈希。
6. **会话过期策略 = C 级自动续期（通用机制）**：解析 JWT `exp` 感知过期；临期/过期触发**静默重捕获**（见 §5.9），静默窗口利用持久化分区已有登录态直接拿到新 JWT，覆盖回写 provider_keys。静默失败才回退本地账本 + 暴露「重新登录」。智谱与火山共用同一套「会话捕获/过期管理」内核，火山首期落地。

---

## 5. 实施步骤（决策完整，可按序执行）

### 5.1 DB 迁移：`migrations/0031_add_volcengine_provider.sql`
参照 `migrations/0027_add_zhipu_provider.sql`：
- `INSERT INTO providers (id, name, logo, capabilities, auth_type, unit_name, default_daily_quota, equivalent_count_divisor)`
- 值：`id='volcengine'`、`name='火山方舟'`、`logo`（取「火」字，同智谱「智」风格）、`auth_type='apikey'`、`capabilities` 本轮给**空 models 数组**（模型延后）、`unit_name='次'`、`default_daily_quota`/`equivalent_count_divisor` 参照 zhipu（50/1）。
- `ON CONFLICT (id) DO UPDATE ...`（幂等，同 0027）。

### 5.2 `packages/providers/src/volcengine.ts`（新增）
复制智谱 zhipu.ts 的日志/脱敏/容错骨架，仅实现本轮所需函数：

1. 常量：`VOLC_BASE_URL = "https://ark.cn-beijing.volces.com/api/v3"`、控制台地址、分区 `persist:qf-volc-console`。
2. `decodeVolcenginePayload(decrypted): { apiKey; consoleJwt? }`——与 `decodeZhipuPayload` 同构（兼容纯 key 旧格式）。导出。
3. `testVolcengineApiKey(apiKey): Promise<{ok; error?}>`——调用 §3.2 只读校验。导出。
4. `fetchVolcengineQuota(apiKey, consoleJwt?): Promise<{ok:true; quota:VolcQuota}|{ok:false;error}>`
   - 优先用 consoleJwt 查火山控制台额度接口；请求本身在**控制台同源**执行（参数携带「在页面内执行的脚本」或回传 URL+headers 供页内跑）。
   - `VolcQuota` 结构对齐 zhipu：`{ available, total, remaining, expiresAt?, packageName?, expired?, accountId? }`。
   - **注意**：由于额度接口未定（§6），先按「页内同源 fetch 指定接口 + 返回 raw，再由主进程按探测到的字段解析」封装，字段解析逻辑留探测后补齐。
5. `volcengineAccountFingerprint(payload): Promise<string|null>`——有 consoleJwt 时先取账号标识，回退 key 哈希。导出。
6. `export interface VolcengineQuota`。
7. 会话过期工具（放同一文件或抽 `console-session.ts` 新文件，先放本文件、后续统一重排）：
   - `jwtExpiryMs(jwt): number | null`——解码 `eyJ...` 中段(base64url)取 `exp`（秒→毫秒）；解析不了返回 null。
   - 供主进程读取会话状态与过期时间。

### 5.3 `packages/providers/src/index.ts`
在文件顶部加 `export * from "./volcengine"`（并确认 zhipu 的再导出在源码中的正确位置，见「注意」）。

> ⚠️ 注意：当前 `src/index.ts` **源码**未再导出 zhipu（仅在已构建的 `dist/index.*` 里有），易在下次 rebuild 时把桌面端 zhipu 导入打穿。落地时应先在 `src/index.ts` 补上 zhipu 再导出（保持 dist 与 src 一致），再放 volcengine。

### 5.4 主进程 `apps/desktop/src/main/providers.ts`
1. import：`testVolcengineApiKey`、`fetchVolcengineQuota`（来自 `@quota-flow/providers`）。
2. `decodeVolcenginePayload` 导出（或复用 zhipu 同名结构，直接复用 `decodeZhipuPayload`——两厂商 payload 结构相同，可直接复用，避免重复）。
3. `provider:encrypt`：在 `providerId === 'zhipu'` 分支旁加 `providerId === 'volcengine' ? await volcengineAccountFingerprint(plain):...`。
4. `provider:test-api-key`：当前硬编码 `testZhipuApiKey`；改为按 `_providerId` 路由（zhipu→testZhipuApiKey，volcengine→testVolcengineApiKey）。
5. `provider:fetch-quota`：同时按 `_providerId` 路由。
6. 新增 `captureVolcengineConsoleSession()`（参照 `captureZhipuConsoleSession`）：
   - 分区：`persist:qf-volc-console`；窗口 `paintWhenInitiallyHidden:true`、`contextIsolation:true`、`nodeIntegration:false`、**`sandbox:false`**；加载前 `clearStorageData()`（保留 HTTP 缓存）。
   - 加载 `https://console.volcengine.com/ark/region:cn-beijing/apikey`。
   - 注入 hook（用 `window.__QUOTA_FLOW_VOLC__` 去重）：hook `window.fetch` + `XMLHttpRequest.setRequestHeader/open/send`，捕获 `authorization`、`x-auth-ctoken`、`x-auth-session` 等头里的令牌；`store()` 时先剥离 `Bearer ` 前缀并尝试 JWT 正则；兜底扫描 localStorage/sessionStorage + 主进程 `session.cookies` 取 auth cookie。
   - 注入条：标题「⋮⋮  Quota-Flow · 火山方舟控制台」，文案说明在「API Key 管理/开通管理」页操作，绿色按钮「已获取key返回」，可拖拽（复用智谱条样式与拖拽逻辑）。
   - 轮询 `window.__VF_SUBMIT__`，拿到会话令牌后 `done({ok:true, consoleJwt})`。
7. **抽通用会话捕获内核并支持静默模式（C 级自动续期的根基）**：把 `captureZhipuConsoleSession` 与火山版本重构为共用 `runConsoleCapture({ partition, url, inject, tokenKey, name, quiet })`：
   - `quiet === true`：`new BrowserWindow({ show:false, paintWhenInitiallyHidden:true, webPreferences:{...} })`，**不注入可拖拽条**，仅注入 hook；轮询 `window.<capturedVar>` 直到捕获到令牌 或 超时（如 25s）自动销毁；成功/超时后 `done(...)`。因持久化分区保留登录 cookie，静默加载已登录分区会自然触发已鉴权请求、hook 自动捕获新 JWT。
   - `quiet === false`：现有可见窗口 + 注入条 + 用户点击按钮返回（保持智谱/火山首绑交互不变）。
8. **新增会话状态/续期 IPC**（C 级）：
   - `provider:console-session-status({ providerId, encrypted })` → 主进程解码 payload，取 `consoleJwt`，用 `jwtExpiryMs` 算 `expMs`，返回 `{ hasConsoleJwt:boolean; expMs:number|null }`（无 consoleJwt → `hasConsoleJwt:false, expMs:null`）。
   - `provider:renew-console-session({ providerId, encrypted })` → 解码 payload 分理出 `apiKey`，调 `runConsoleCapture(..., { quiet:true })` 静默拿新 `consoleJwt`；成功后返回 `{ ok:true, consoleJwt }`（渲染层据此重加密回写）；失败返回 `{ ok:false, error:'会话需重新登录' }`。
9. `initProviders()`：注册 `provider:capture-volcengine-session`、`provider:console-session-status`、`provider:renew-console-session` IPC。

### 5.5 `apps/desktop/src/preload/index.ts`
在 `providers` 接口下新增三组（`encrypt`/`testApiKey`/`fetchQuota` 已接收 providerId，天然通用无需改）：
- `captureVolcengineSession: () => Promise<{ ok: boolean; consoleJwt?: string; error?: string }>`。
- `consoleSessionStatus: (providerId: string, encrypted: string) => Promise<{ hasConsoleJwt: boolean; expMs: number | null }>`。
- `renewConsoleSession: (providerId: string, encrypted: string) => Promise<{ ok: boolean; consoleJwt?: string; error?: string }>`。

### 5.6 渲染层 `apps/desktop/src/renderer/src/components/Modals.tsx`
1. `saveApiKey`：`const raw = (providerId === 'zhipu' || providerId === 'volcengine') && consoleJwt ? JSON.stringify({v:1,apiKey:trimmed,consoleJwt}) : trimmed`。
2. 新增 `openGetVolcEngineKey()`：调 `window.api.providers.captureVolcengineSession()`，`ok && consoleJwt` → `setConsoleJwt`。
3. 按钮区（L1256）：`{(providerId === 'zhipu' || providerId === 'volcengine') && (<button ... onClick={providerId==='volcengine'?openGetVolcEngineKey:openGetApiKey}>获取 API Key</button>)}`。
4. 复用既有去重/刷新已绑定流程，无需改。

### 5.7 额度刷新 `apps/desktop/src/renderer/src/hooks/useProviders.ts`
- 新增 `refreshVolcengineQuota`（镜像 `refreshZhipuQuota`：`window.api.providers.fetchQuota('volcengine', secret.encrypted_key)` + 30s 重试窗口 + 覆盖展示）。
- 在初始化/账号切换时把 `volcengine` 账号一并纳入额度刷新。
- **会话状态表（C 级续期驱动）**：新增 `sessionStates: Record<keyId, { hasConsoleJwt:boolean; expMs:number|null; state:'alive'|'expiring'|'expired'|'missing'|'renewing'|'renew_failed' }>`，与额度刷新联动。

### 5.8 展示扩展
- `spec.ts`：`PROVIDER_LABEL.volcengine = '火山方舟'`；`MODELS.volcengine` 本轮给空/注释（模型延后）。
- `Providers.tsx`：L420 `isApiQuota` 与 L541 展示分支条件从 `providerId === 'zhipu'` 扩为同时支持 `volcengine`（展示真实剩余额度；额度单位/默认日额度/等效除数字段对 apikey 厂商隐藏，火山同 zhipu）；L422 附近对 `hasConsoleJwt` 为空的 apikey 账号显示「未捕获会话」提示，`renew_failed` 显示「会话需重新登录」+ 点击重取入口。
- `Dashboard.tsx`：L1021 `isApiQuota` 同理扩展；本轮不做模型下拉/价格徽标（模型延后）。

### 5.9 C 级：控制台会话过期自动续期设计（通用机制，火山首期落地）

**目标**：额度来源的 `consoleJwt` 过期后无需用户手动操作，后台静默续期；只有静默续期也失败（控制台登录态整体失效）才回退账本并提示重新登录。

**状态机**（每账号一个 `sessionStates[keyId].state`）：
```
missing ──首次捕获──▶ alive ──距 exp < 15min──▶ expiring ──到期──▶ (静默续期)
alive/expiring ──静默续期成功──▶ alive(新 exp)
expiring/expired ──静默续期失败──▶ renew_failed ──(手动「重新登录」)──▶ (可见窗口重捕获)→alive
```

**前端调度（`useProviders.ts`）**：
1. 初始化/账号切换后，对每个 apikey 账号调 `consoleSessionStatus(providerId, encrypted_key)`，得到 `{hasConsoleJwt, expMs}`，写入 `sessionStates`：
   - 无 consoleJwt → `missing`（仅提示「未捕获会话」，不自动续期）。
   - 有 expMs：
     - `expMs - now > 15min` → `alive`（本次不动作，交给定时器）。
     - `0 < expMs - now ≤ 15min` → `expiring` → 本轮即触发续期。
     - `expMs ≤ now` → `expired` → 本轮即触发续期。
   - expMs 解析失败（非标准 JWT）→ 按 `alive` 对待，仅通过额度接口 401 兜底续期。
2. **定时器**（如每 10 分钟）：遍历 apikey 账号，`expiring`/`expired` 的触发续期；顺带把 `alive` 但额度接口近期 401 的也触发。
3. **续期动作 `renewSessionFor(keyId)`**：
   - 置 `state='renewing'`；调 `renewConsoleSession(providerId, encrypted_key)`。
   - 成功返回新 `consoleJwt` → 复用绑定写入路径（`provider:encrypt` 重生成 `{v:1,apiKey,consoleJwt}` → 更新 `provider_keys.encrypted_key`）→ 置 `alive`，随后立即 `fetchQuota` 刷新真实额度。
   - 失败 → 置 `renew_failed`，`zhipuQuotaOverrides` 保持/清空（回退本地账本展示），下次定时器不再反复骚扰（频率上限，如 30min）。
   - 并发防抖：同 keyId 续期进行中时，重复触发直接跳过。
4. **生成后额度刷新**：`quota:updated` 事件仍走 `refreshZhipuQuota`/`refreshVolcengineQuota`；若此时返回 401，则视为会话过期，触发一次续期再查。

**主进程**：`renewConsoleSession` = 解码 payload → `runConsoleCapture({..., quiet:true})` → 返回新 consoleJwt；成功与否都确保隐藏窗口销毁、定时器清理（复用智谱捕获的 done/closed 清理套路）。静默模式不使用 `clearStorageData()`（那是首绑时清登录态用的，续期必须保留 cookie）。

**智谱迁移关系**：机制通用后，智谱的 `provider:fetch-quota`（已在 zhipu 实现 401 回退）可平滑接入同一续期循环；本轮先火山落地，智谱接入作为 §9 后续项，避免一次改动过大。

---

## 6. 控制台额度接口探测（核心开放风险，实施时实测定稿）

火山控制台额度接口未公开、字段未知，**必须在接入时实抓**，步骤（与智谱 biz 抓包同套路）：

1. 用 §5.4 的捕获会话窗口登录后，停留在「开通管理（ComputerVision）」/「API Key 管理」页。
2. 在注入脚本里加**请求日志**：记录所有 `ark`/`openManagement`/`quota`/`resource`/`package` 相关 `fetch/XHR` 的 URL、method、关键请求头（脱敏）、以及响应体前缀，输出到主进程 console（`[volc-console]` 前缀）。
3. 据此确定「返回资源包/免费额度剩余/总量」的那个接口，及其字段（如 `available`/`total`/`status`，确认是否有 `EXPIRED` 类似态需过滤）。
4. 把该接口 URL + 字段映射固化进 `fetchVolcengineQuota`（页内同源执行，见 §4-4 决策，规避签名重放）。
5. 同时从「账号信息/用户接口」找稳定账号标识（uid/IAM/customer）供去重；找不到则用 API Key 哈希回退。

> 若「页内同源执行」路线遇 CSP 阻断 `executeJavaScript` 的 fetch，则把主进程 replay 作为备选（用捕获到的 headers 集合 + cookie 重放），或直接让捕获窗口在页内静默调额度接口并把结果回填 `window.__VF_QUOTA__` 供主进程轮询取回。

---

## 7. 假设与决策清单

| # | 决策/假设 | 依据 |
|---|---|---|
| 1 | id=`volcengine`，名=`火山方舟` | 用户确认 |
| 2 | 本轮=绑定+会话捕获+真实额度；模型/生成延后 | 用户确认 |
| 3 | 数据面 Bearer 鉴权，testKey 用只读接口 | 官方文档核对 §3 |
| 4 | 额度=控制台内部接口，需会话捕获 | 用户确认 + 智谱先例 |
| 5 | 额度查询走控制台同源执行 | 火山签名头难重放（保守选稳） |
| 6 | payload 复用 `{v:1,apiKey,consoleJwt}` 结构 | 与智谱兼容，减少代码 |
| 7 | 去重优先账号标识、回退 key 哈希 | 智谱先例 |
| 8 | volcengine 同 zhipu 在 apikey 下隐藏额度单位/默认日额度/等效除数 | 智谱先例 |
| 9 | 会话过期 = C 级自动续期（解析 exp + 静默重捕获 + 回写），通用内核火山首期落地 | 用户选定 |
| 10 | 静默续期失败才回退本地账本，并暴露「重新登录」 | 智谱现状补强 |

---

## 8. 验证步骤

1. `pnpm --filter @quota-flow/providers build`（确保 dist 含 volcengine，且不再丢 zhipu 导出）+ 桌面端与 db 包 `typecheck`。
2. 执行 `migrations/0031_add_volcengine_provider.sql`，`providers` 表出现 `volcengine` 行（apikey）。
3. 完全退出并重启桌面应用（旧打包产物不热更）。在「绑定」弹窗选「火山方舟」：
   - 输入火山方舟 API Key → 点「测试 API Key」：无效 key 报红、有效 key 绿提示。
   - 点「获取 API Key」：打开火山控制台，登录后按钮返回，弹窗显示「已获取控制台会话」。
   - 保存：账号出现在厂商列表，展开显示真实剩余额度（来自控制台额度接口），且绑定成功即刷新额度。
4. 去重：同一火山账号用另一 API Key 再绑定 → 弹出「检测到相同账号，更新已有 / 仍要新建」确认（与智谱一致）。
5. 观察主进程以 `[volc-console]` / `[volc-quota]` 前缀日志，确认捕获与额度解析路径正确。
6. **自动续期（C 级）**：
   - 进入「会话状态」：已捕获会话的火山账号 `state=alive` 且 `expMs` 有效。
   - 临时把续期阈值临时调大/伪造一个已过期的 expMs 的 payload 存入该账号 → 观察定时器自动触发 `renewConsoleSession`，隐藏窗口静默捕获新 JWT 并回写 `provider_keys.encrypted_key`，期间无可见窗口闪现。
   - 手动停用/清掉控制台登录态后再触发续期 → `state=renew_failed`，账号行显示「会话需重新登录」、额度回退本地账本，点击「重新登录」能打开可见窗口重捕获恢复。
   - 观察并发防抖：同账号续期中重复触发被跳过，无重复开窗。

---

## 9. 后续（本轮不做，仅记录）

- 智谱接入同一自动续期内核：`provider:fetch-quota` 已有 401 回退，接入 `renewConsoleSession` + 前端 `sessionStates` 循环即可，属增量小改。
- 火山方舟模型目录（只接有免费额度的模型）：新增 `provider_caps` 记录 + `api-branch` 注册 `volcengine` 分支（提交 `POST /contents/generations/tasks`、轮询 `GET .../{id}`、取 `content.video_url`），同步 `spec.ts` 模式/时长/价格/提示词辅助提示、Dashboard 模型下拉与价格徽标。
- 会话捕获/过期内核完成后，理论上可推广到元宝/千问等「登录 Cookie」型厂商（若其 cookie 同样会过期），作为远期统一会话管理。