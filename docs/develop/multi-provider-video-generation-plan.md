# 多厂商视频生成接入计划（含账号绑定，第一轮：豆包 / 千问 / 元宝 / MathMind）

> 状态：实施中（第一轮：豆包 / 千问 / 元宝；千问 `qwenwan` 账号绑定完成、多参考/首帧/首尾帧已接入真实 DOM 参数选择与素材上传；元宝 `yuanbao` 账号绑定已接入，视频生成已接入）
> 日期：2026-08-14
> 适用范围：apps/desktop、packages/db-supabase、migrations

## Summary

- 当前 `auto` 硬解析成 `doubao`，`dispatch.ts` 只筛豆包账号，成本、下载、失败语义都写死豆包。
- 目标：抽出 desktop 多厂商执行层，先接入豆包、千问（`qwenwan`）、元宝（`yuanbao`）、MathMind（真实 MCP），让 `auto` 真正多厂商 fallback。
- 账号绑定与生成执行一起实现：先保证新厂商能真实绑定、能健康检查、能被调度候选池看到，再接入对应生成 adapter。
- 当前完成：千问账号绑定去重/刷新已对齐豆包；`qwenwan` 显式选择可走 WebView 生成，模型/生成模式/清晰度/比例/时长/配音通过页面真实 DOM 操作选择，不再拼进 prompt；生成模式按模型限定（万相 2.7 多参考/首尾帧，万相 2.6 与 HappyHorse 1.0 多参考/首帧），必须至少上传一张素材图片；HappyHorse 1.0 不设置智能配音；`auto` 暂不包含千问。
- 本轮完成：元宝 `yuanbao` 账号绑定复用现有 cookie 登录窗口与账号分区，登录页为 `https://yuanbao.tencent.com/chat/naQivTmsDa`，健康页为 `https://yuanbao.tencent.com/`；指纹沿用 `pt2gguin/hy_user`；绑定 UI 对齐豆包/千问去重语义，已有账号重复绑定直接刷新，不出现“新增账号/刷新已有账号”选择弹层；视频生成已接入，发送时在 prompt 前补 `视频生成：`，素材图片通过输入框 Ctrl+V 粘贴上传，调度台不接 `auto`。
- 素材上限：千问本轮限制最多上传 5 张图片，元宝最多上传 10 张；dispatch 对 `qwenwan` 按 5 张、`yuanbao` 按 10 张裁剪，UI 上传区同步限制。

## Public API / Interface Changes

- `GenerateInput.providerId` 支持 `auto | doubao | qwenwan | yuanbao | mathmind`；renderer 不再把 `auto` 转成 `doubao`。
- 新增 desktop provider 契约：`DesktopVideoProvider` 提供 `id/capabilities/supportedDurations/cost/runGenerate/downloadContext/isNonRetryable`，统一返回 `VideoGenerateResult`。
- credential 解析统一从 `providers.ts`/共享 helper 导出，删除 `dispatch.ts` 里的重复解析；解析不再默认豆包 origin，新厂商 storage 按各自 `providerSite` origin 处理。
- `spec.ts`/renderer 增加 `qwenwan`、`yuanbao`、`mathmind` 的显示、模型、时长、成本规则；MathMind 不提供 text2video。

## Account Binding Changes

- **千问/元宝（cookie 型）**：复用现有 `provider:login`、`partitionFor`、`providerSite`、`health-check` 框架；绑定窗口打开对应 loginUrl，登录完成后收集该 partition 的 cookie/storage，加密写入 `provider_keys`。
- **MathMind（API key 型）**：不走 cookie 登录窗口；绑定页使用 API key/config 录入，`provider_keys.auth_type = 'apikey'`；健康检查改为 MCP `initialize/list tools` 或握手成功，不再依赖空 healthUrl。
- **绑定后能力**：写入 `health_status`、`enabled`、默认账号标记；绑定成功即初始化当日 `quota_ledger` 行；被调度候选池识别，失败/过期可被 `auto` 跳过。
- **账号去重/指纹**：qwenwan 使用千问登录后的账号级 Cookie（`b-user-id` / `_QW_HASH_UID` / `_QW_WG_UID`）指纹；yuanbao 沿用 `pt2gguin/hy_user`；MathMind 用 API key 哈希指纹，复用现有 fingerprint 字段。
- **UI**：`Providers` 页/`AddProviderModal` 对 cookie 型显示登录窗口流程，对 MathMind 显示 API key 录入；新厂商绑定后立即出现在生成页厂商选项。

## Yuanbao Account Binding Changes

- **登录与存储**：元宝走 cookie 登录窗口，复用 `provider:login`、`partitionFor`、`providerSite`、`health-check` 框架；登录分区与账号分区继续使用 `persist:qf-p:yuanbao:<keyId>`。
- **存储 origin**：`providers.ts` 中默认存储 origin 不再只按豆包/千问硬编码，改为按 `providerSite(providerId)` 解析，避免元宝凭证解析/注入回退到 `doubao.com`。
- **会话校验**：登录成功后会话 cookie 校验增加元宝/QQ 登录 token 兼容名称，覆盖 `hy_`、`uin`、`skey`、`pt4_token` 等，避免登录成功却被误判为无会话。
- **去重兜底**：`Modals.tsx` 中把 qwenwan 专用“已有账号直接刷新、不弹新增/刷新选择”的逻辑抽成通用辅助逻辑，并扩展到 `yuanbao`。指纹匹配已有账号时刷新该账号；指纹有值且与所有已有账号指纹都不匹配时按新账号保存；指纹缺失或旧账号无指纹时默认刷新第一个已有账号。
- **额度初始化**：保存元宝账号继续走 `addProviderKey` + `getOrInitLedger`，沿用迁移中 seed 的 `default_daily_quota=5`、`supported_durations=[5]`。
- **本轮不做**：元宝 `auto` fallback、API key 接入均不在本轮范围。

## Implementation Changes

- **调度执行**：`dispatch.ts` 已支持显式 `qwenwan` 走 `runQwenGeneration`、显式 `yuanbao` 走 `runYuanbaoGeneration`；元宝生成任务在创建前将 prompt 改为 `视频生成：<prompt>`，图片按最多 10 张传给 WebView。本轮继续保留 `auto` 映射到 `doubao`，不把千问/元宝纳入 auto fallback。后续再改成 provider registry + fallback，显式厂商只尝试该厂商；`blocked/content policy` 和手动取消立即停止。
- **WebView 框架**：保留豆包 DOM 脚本，把 `webview-engine.ts` 重构为通用 WebView provider 基础（partition、cookie/storage 注入、窗口生命周期、进度事件、轮询/取消）加 `doubao/qwenwan/yuanbao` adapter。千问、元宝走真实 WebView 页面流；现有 HTTP adapter 只作参考。
- **千问 WebView**：`qwen-webview.ts` 负责千问视频生成：cookie/storage 注入 → 打开 `www.qianwen.com/chat` → 点击“AI生视频”入口并强制 guide 容器可交互 → 选择模型、生成模式（万相 2.7：多参考/首尾帧；万相 2.6 与 HappyHorse 1.0：多参考/首帧）、上传素材图片、点击参数摘要按钮（如 `720P·5s`）设置清晰度/比例/时长/配音（HappyHorse 1.0 跳过智能配音）→ 填写 prompt → 点击发送 → 捕获 chat 请求 → 轮询 detail 提取 mp4。当前仅支持需要素材的多参考/首帧/首尾帧；参数通过页面真实 DOM 控件选择，不注入 prompt；已补充登录态、提交失败、等待超时、内容审核拒绝等错误语义。
- **元宝 WebView**：新增 `yuanbao-webview.ts` 负责元宝视频生成：cookie/storage 注入 → 打开 `https://yuanbao.tencent.com/chat/naQivTmsDa` → 聚焦输入框并通过 Ctrl+V 粘贴素材图片（最多 10 张）→ 在输入框末尾追加调度台已补 `视频生成：` 前缀的 prompt → 点击发送 → 从 `webRequest` 捕获 chat/detail 请求里的 `conversationId` 与请求头 → 轮询 `conversation/detail` 提取视频 URL。元宝当前没有独立视频生成 DOM，因此不操作生成模式/清晰度/比例/时长/配音控件。
- **MathMind**：新增 desktop MCP provider，安装 `@modelcontextprotocol/sdk`，读 `data/mathmind-mcp.json` 的 transport（默认 stdio `npx -y mcp_mathmind-video`），实现 `imageGenVideo`，不做 dry-run。
- **成本/额度/下载**：成本改为 provider 的 `cost(input)` 或 `provider_cost_tables` 等价规则；job 的 `providerId/costAmount/costUnit`、`consumeLedger/consumeTeamQuotaAndFinalize` 使用实际厂商；`downloadVideo` 使用 provider 的 Referer/UA 上下文。
- **UI**：生成页 provider 选项按已绑定、启用、支持当前 mode/duration 过滤；`qwenwan` 只显示当前模型支持的素材生成模式，并显示上传区，未上传素材时阻止生成；HappyHorse 1.0 隐藏智能配音入口；`handleGenerate` 传真实 `provider` 值；MathMind 仅在 `img2video` 可调用时显示；stage 文案去掉豆包硬编码。
- **DB**：新增小迁移修正 MathMind 能力声明（desktop v1 只允许 img2video），补齐第一轮厂商需要的 `provider_cost_tables` 行，避免调度/UI 误判。

## Test Plan

- 类型检查：`pnpm --filter @quota-flow/desktop typecheck`、`pnpm --filter @quota-flow/providers typecheck`。
- 绑定：真实账号验证千问、元宝登录绑定、健康检查、账号指纹去重；MathMind API key 绑定和 MCP 握手。
- 回归：豆包 `doubao` 与 `auto` 文生/图生视频仍能生成、下载、扣豆包额度；`blocked` 不换号。
- 新厂商生成：千问、元宝 WebView 文生视频；MathMind `img2video`；text2video 不出现在 MathMind 候选。
- 素材上限：千问多参考/首帧/首尾帧最多 5 张，元宝图片参考最多 10 张；超过上限时 UI 不再追加，dispatch 侧也按对应上限裁剪。
- Fallback：构造第一厂商失败（过期/额度不足/风控），`auto` 切到下一可用厂商；遇到内容政策/手动取消立即停止。

## Assumptions / Defaults

- 第一轮只接 `doubao / qwenwan / yuanbao / mathmind`；即梦、可灵、海螺按同一框架后续补齐。
- 千问、元宝以 WebView 为默认，静态 cookie HTTP adapter 不进入 desktop 调度。
- MathMind 当前 MCP 契约默认 stdio；如果实际服务器需要 HTTP 或自定义参数，只改 `data/mathmind-mcp.json` 与 client 初始化。
- `auto` 总尝试上限默认 3 次；每个 provider 内账号排序优先 default、healthy、剩余额度充足，再按成本排序。
