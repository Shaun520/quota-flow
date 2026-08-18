# 智谱 AI 开放平台（open.bigmodel.cn）账号绑定实现参考

> 目标：完整记录智谱（bigmodel）账号绑定的整体思路与关键实现，沉淀一套可复用的模式，便于后续接入其他「API Key 型」厂商时快速复制。
> 本文是「开放思路/通用方法论」文档，围绕 **会话令牌捕获 + 真实额度查询 + 账号级去重** 三条主线展开。

---

## 1. 背景与智谱的特殊性

| 维度 | 说明 |
| --- | --- |
| 生成接口 | `open.bigmodel.cn/api/paas/v4/*`，用 `Authorization: Bearer <API Key>` |
| 额度查询 | `open.bigmodel.cn/api/biz/tokenAccounts/list/my`，**API Key 调不通（返回 401「身份验证失败」）**，必须用**网页控制台登录会话 JWT** |
| API Key 与账号 | 一个智谱账号可建多个 API Key，彼此共享同一控制台资源包 / 同一 `customerId` |
| 免费模型 | `cogvideox-flash` 免费、不计费；付费模型按次（cogvideox-2、cogvideox-3） |
| 已过期资源包 | 接口返回的包带 `status: "EXPIRED"`，不能当作有效额度展示 |

**核心难点**：真实额度不在 PaaS API 可查的范围内，而在控制台的 `api/biz` 域下；认证用的是 **web 登录会话 JWT**，而非 API Key。因此绑定流程必须额外捕获并保存一份「控制台会话令牌」。

---

## 2. 整体架构

```
渲染层 (renderer)
  Modals.tsx       绑定表单：API Key + 「获取 API Key」按钮 + 同账号去重提示
  useProviders.ts  额度状态 & 自动查询
  Providers.tsx / Dashboard.tsx  账号明细展示（含「已过期」态）
        │  window.api.providers.*  (preload 桥接)
        ▼
主进程 (main)
  providers.ts
    provider:capture-zhipu-session   打开控制台窗口、注入拦截脚本、抓取 JWT
    provider:encrypt-key             加密「API Key+JWT」、按账号生成去重指纹
    provider:fetch-quota             解密后用 JWT 调 api/biz 查真实额度
        │
        ▼
providers 包 (@quota-flow/providers/src/zhipu.ts)
  fetchZhipuQuota   封装修正态、URL 解码、JWT 提取、资源包过滤、customerId 透出
```

三个 IPC 通道各有职责，互相独立、可单独复用。

---

## 3. 会话令牌捕获（核心）

目标：拿到 `open.bigmodel.cn` 域下的 `Authorization: Bearer eyJ...`。

采用**四路并发**捕获，任一命中即可，且优先标准 JWT：

1. **请求拦截（最可靠）** —— 在页面注入 hook，从真实请求头里抓
   - `window.fetch` 改写：匹配 `/api/biz/` 请求，读 `init.headers` 的 `Authorization`。
   - **`XMLHttpRequest` 改写（关键）**：智谱控制台前端用 axios/XHR 发请求，`window.fetch` 拦不到。改写 `open`（记录 URL）、`setRequestHeader`（`name.toLowerCase()==='authorization'` 时取值）、`send`。
   - 用 `__QF_ZHIPU_HOOKED__` 去重，避免每次导航重复 hook。
2. **Storage 扫描** —— `localStorage` / `sessionStorage` 里找 key 名像令牌或值形如 JWT 的项。
3. **Cookie 提取** —— 令牌常放在 **httpOnly cookie**，页面 JS 读不到，需主进程经 `session.cookies` 读取。
4. **兜底——URL 解码 + JSON 深度挖** —— 见 `extractJwt`（下面单独讲）。

注入脚本注意要点：
- **写成 `try { … } catch { }` 隔离**：拦截逻辑失败不影响提示条 UI 创建。
- **提示条与拦截解耦**：提示条是 `qf-session-bar` 浮动条，`did-finish-load` / `did-navigate` / `did-navigate-in-page` 三个时机重注入，内部都有去重，登录跳转后仍会重新出现。
- 主进程 `webContents.executeJavaScript` 注入，窗口加 `paintWhenInitiallyHidden: true` 防白屏。
- `sandbox: true` 会隔离渲染进程、拖慢加载/JS 执行，**去掉 sandbox**，保留 `contextIsolation: true` + `nodeIntegration: false` 作为安全边界。

### 3.1 为什么「抓到的 token 是脏值」以及 `extractJwt` 兜底

日志常出现 `prefix={"session_id":...` / `%7B%22session_id%22...`，即捕获到的 `consoleJwt` 其实是：
- 一个 `{"session_id": ...}` 的 **JSON 结构**；
- 内部 JWT 的 `.` 被 URL 编码成 `%2E`（可能多套一层编码），普通正则匹配不到。

`extractJwt`（zhipu.ts）的处理策略：
1. `fullyDecode`：反复 `decodeURIComponent` 到不再含 `%XX`；
2. 解码后直接用 `eyJ...A.B.C` 正则扫描；
3. 仍无 → `JSON.parse` 后**深度遍历所有字符串字段**，在任意一层抠出 JWT。

> 结论：会话令牌的取值必须**标准化为 `eyJ` 开头的 JWT** 才算数。前端/后端在判断「是否已获取会话」时，都以「能提取到标准 JWT」为准，否则视为未捕获（返回错误提示，而不是假装成功）。

---

## 4. 加密存储与兼容

存储格式：

```ts
interface ZhipuKeyPayload { v: 1; apiKey: string; consoleJwt?: string | null }
```

- 用 `safeStorage.encryptString(JSON.stringify(payload)).toString('base64')` 整段加密。
- 解密时 `decodeZhipuPayload` **兼容旧版本纯 API Key 格式**（非 `{` 开头直接用明文 key）。
- `consoleJwt` 取出时做一次 `decodeURIComponent`（兼容被 URL 编码存储的脏值）。

---

## 5. 真实额度查询（fetchZhipuQuota）

流程（zhipu.ts）：

1. `const jwt = extractJwt(consoleJwt)` —— 标准化。
2. **仅当能提取到标准 JWT 才用 `Bearer <jwt>`**；否则回退 `Bearer <apiKey>`（用于非 biz 的场景，biz 会 401，日志会打标记 `(true:consoleJwt,false:apiKey)` 便于排查）。
3. 请求 `GET /api/biz/tokenAccounts/list/my?pageNum=1&pageSize=50&filterEnabled=false`，`AbortSignal.timeout(15000)`。
4. 过滤资源包：
   - **排除 `status === 'EXPIRED'`**（已过期包不当有效额度）；
   - 优先匹配名称含「图片/视频生成 / 文生视频 / 图生视频」的视频按次包；
   - 兜底所有 `consumeType === 'TIMES'` 的按次包。
5. 计算剩余：优先 `availableBalance`（未用数量），再回退 `tokenBalance` / `tokensMagnitude`。
6. **透出 `customerId`**（`rows[0].customerId`），供账号级去重用。
7. 无任何有效候选、但存在已过期的视频/TIMES 包时，`quota.expired = true`，UI 显示「已过期」。

---

## 6. 账号级去重（customerId 指纹）

**问题**：智谱一个账号可建多个 API Key，若只按 API Key 指纹（`sha256(providerId|apiKey)`）去重，同一账号用不同 Key 会重复出现。

**方案**：绑定保存时，若带控制台会话 JWT，先调 `fetchZhipuQuota` 解析出 `customerId`，指纹改为：

```
sha256( providerId | "zhipu-account:" + customerId )
```

- 同一账号不同 Key → `customerId` 相同 → 指纹相同 → 前端去重拦截，给出友好确认「检测到这个智谱账号已绑定，是否更新其 API Key？」。
- 拿不到 `customerId`（未带会话 / 接口失败）→ 回退按 API Key 指纹，避免误拦截。

UI 去重在保存时执行（Modals.tsx）：

1. 用 `await svc.list*ProviderKeys()` 取当前 scope（个人/团队）的账号；
2. 找到 `provider_id` 相同且 `account_fingerprint` 相同的即有重复；
3. 命中 → 友好提示 + 可选更新该账号的 API Key（不重复新增）；否则正常新增。

---

## 7. 前端绑定 UI 要点

- 登录方式区分：API Key 型厂商带「API Key」标识；智谱 apikey 场景需隐藏额度单位、默认日额度、等效除数字段（额度由接口按真实资源包返回）。
- 按钮文案：「**获取 API Key**」+ `btn-sm primary`（绿色主按钮，与其他厂商统一）；捕获中显示「正在获取控制台会话…」，有会话时「重新获取控制台会话」+ `✓ 已获取控制台会话`。
- 「已获取」状态必须依赖**真实捕获到标准 JWT**，不能因任意 token（如 session_id 脏值）就显示成功。
- 账号明细下拉展示模型信息与额度详情；无有效额度且有过期包时显示「已过期」。

---

## 8. 埋点 / 诊断日志

整个链路带分步日志，便于排障：

```
[qf-zhipu] 1) fetch拦截 __QF_ZHIPU_TOKEN__: …   # 请求拦截是否抓到
[qf-zhipu] 2) storage: …                         # storage 扫描
[qf-zhipu] 3) cookie extractTokenFromCookies: …  # cookie 提取
[qf-zhipu] 最终 token: 标准JWT/非标准/空          # 归一化结果
[zhipu-quota] auth=JWT prefix=… (true:consoleJwt,false:apiKey)  # 实际用哪种认证
[zhipu-quota] HTTP … rows=…                       # 接口返回的资源包数量
```

判断链路问题：只要出现 `非标准` 或 `false`，优先回到「捕获/归一化」环节排查，而不是额度计算。

---

## 9. 可复用的「绑定 API Key 系列厂商」清单

接入任何「API Key 型厂商」前，对照以下清单逐项确认：

1. **额度查询方式**：官方是否提供「按 API Key 可查」额度接口？
   - 能 → 直接 `Bearer <API Key>` 查询，最省事。
   - 不能（如智谱 biz）→ 需要**捕获网页控制台会话 JWT**，走 3-5 节方案。
2. **会话令牌存放位置**：请求头 / localStorage / sessionStorage / httpOnly cookie / URL 编码 JSON？
   - 先扩源码确认，优先用请求拦截（fetch + XHR 都要 hook）。
3. **账户去重维度**：同一账号是否有多个 Key？
   - 有 → 尽量按账号级标识（customerId / userId）指纹去重，而非仅 Key。
4. **资源包语义**：接口返回哪些字段（总量 / 剩余 / 已过期 / 包类型）？剩余字段与总量字段分别是什么？是否有 `EXPIRED` 态需过滤？
5. **加密存储**：按 `{ v, apiKey, consoleJwt }` 结构化 + safeStorage，并兼容旧格式。
6. **UI**：隐藏额度单位默认值（接口为准）、「获取 API Key」绿色按钮、同账号去重友好提示、无额度/已过期态展示。
7. **日志**：捕获三路 + 认证来源 + 接口返回样本，全套打点。