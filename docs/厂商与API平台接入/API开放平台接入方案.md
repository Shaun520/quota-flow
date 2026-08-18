# 厂商 API 开放平台接入方案（填 apikey 获取视频生成免费额度）

> 状态：调研/方案（尚未编码）
> 调研时间：2026-08-17
> 参考对标：https://github.com/tashfeenahmed/freellmapi（聚合免费额度的 OpenAI 兼容网关思路）
> 说明：文中各平台「免费额度」「接口路径」以调研当日信息为准，**接入前必须核对各官方开放平台最新文档**，标注 `⚠️` 处为不确定项需实测。

## 1. 背景与目标

Quota-Flow 现有 7 家厂商全部走 **WebView cookie 注入 + 自动提交**（逆向页面内部接口），只有 history 里有 mcp_mathmind 一个真 API 厂商。WebView 路线的痛点：登录态会过期、网页改版即失效、需凌晨保活。

目标：新增一档「**官方 API + apikey**」的接入方式，用户只需在 App/桌面端输入厂商赋能平台申请的 `apikey`，即可调用**官方视频生成 API** 并消耗其**赠送/免费额度**，与现有 WebView 厂商一起进入同一调度池。

与 freellmapi 的本质区别：

- freellmapi 聚合的是「LLM 推理 API 的免费 token 额度」，多数是 OpenAI 兼容端点（chat/embedding），**并非为视频生成设计**。
- 本方案针对**视频生成**的官方异步任务式 API，路线不同，但「填 key → 加密存储 → 调度选路 → 按 key 记账控额度」的**架构思路完全可复用**。

⚠️ 关键事实核查结论（决定了各平台优先级）：

- 这些平台的「免费」**多为注册一次性赠送 / 新模型公测期免费，不是持续每日免费**。
- **阿里云百炼（通义万相）** 送 50 图 / 50 秒视频（90 天有效），Wan3.0 公测再送 30 秒 —— 免费最实在。
- **智谱 bigmodel** 新注册送 token，`cogvideox`（清影）挂在 OpenAI 兼容接口下 —— 最适合第一个验证打通。
- **火山引擎（Seedance 2.5）** 已上线 API，但按量计费，免费额度属当期活动，非默认。
- **腾讯混元 / 百度千帆 / 千问平台**：多为商用计费或网页端免费，稳定的 apikey 免费视频额度不明确。

## 2. 接入清单与优先级

| 优先级 | 平台 | 厂商 id（建议） | 对接成本 | 免费额度确定性 | 首期是否接入 |
|---|---|---|---|---|---|
| P0 | 阿里云百炼（通义万相） | `bailian_wan` | 中 | 高（送 50 秒视频） | ✅ 首选验证 |
| P1 | 智谱 bigmodel（清影） | `zhipu_cogvideo` | 低（OpenAI 兼容） | 高（送 token） | ✅ 首选验证 |
| P2 | 火山引擎（Seedance） | `volcengine_seedance` | 高（Volc SDK/签名） | 中（活动制） | 视活动 |
| P3 | 腾讯云（混元生视频） | `tencent_hunyuan` | 高（TC3 签名 + 内测申请） | 低 | 延后 |
| P3 | 百度千帆（文生视频） | `baidu_qianfan` | 中（鉴权较直白） | 低 | 延后 |
| P3 | 千问平台 | `qwen_wan` | 低-中 | 低（网页免费为主） | 延后 |
| P2 | Vidu（生数科技） | `vidu` | 低（Token 鉴权 + REST） | 中（完善信息送积分 + 错峰低价） | ✅ 可选验证 |

> 落地顺序建议：先做 **智谱**（最快验证全链路）→ **阿里百炼**（免费额度最实在）→ **Vidu**（接口规范、错峰便宜）→ 其余按需。

## 3. 通用接入模式（各家共同点）

所有视频生成 API 平台几乎都遵循**同一种异步任务模式**，可与现有 `BaseProvider.generate()` 无缝对齐：

```
1. 提交任务   POST {提交接口}  → 返回 task_id
2. 轮询结果   GET  {查询接口}  → { status: processing|success|fail, ... }
3. 提取输出   success 后取 video_url（+ optional cover/video_duration）
4. 失败降级   返回 fail → 调度器自动切下一家
```

`GenerateResult`（`packages/core/src/types.ts`）现有字段已覆盖：`ok / providerId / traceId / videoUrl / durationMs / errorMessage / raw`。每个 Provider 只需实现 `generate()` + `estimateCost()`，与 [yuanbao.ts](file:///d:/project/quota-flow/packages/providers/src/yuanbao.ts) 的 `pollDetail` 结构同构。

### 3.1 鉴权差异（各家不同，需分别封装）

| 平台 | 鉴权方式 | headers |
|---|---|---|
| 智谱 | Bearer Token | `Authorization: Bearer <apikey>` |
| 阿里百炼 | Bearer Token（attached model platform） | `Authorization: Bearer <apikey>` + 同地域 endpoint |
| 火山引擎 | 签名（ACCESS_KEY/SECRET_KEY 生成） | `Authorization` 动态签名（Volc OpenAPI 签名 v4）或 SDK |
| 腾讯云 | TC3-HMAC-SHA256 签名 | `Authorization` 动态签名 + `X-TC-*` 头 |
| 百度千帆 | Bearer Token / AK 鉴权 | `Authorization: Bearer <ak>` 或鉴权头 |

> 火山/腾讯/百度用到「AK/SK 签名」，与「纯 apikey」不同，接入成本更高，这也是它们排在 P2/P3 的原因。

### 3.2 一键式 Key 管理（复用现有能力）

apikey 属密钥，按仓库规范（`docs/开发规范/PostgREST数据与AI开发规范.md` R2）：

- 个人 key 存 `provider_keys.encrypted_key`（AES，桌面端本地解密）。
- 团队公共 key 走 Edge Function 代调用，key 不出云端。
- 列表查询永不返回 `encrypted_key`。
- 每个账号可单独启用/停用（沿用账号级开关）。

## 4. 各平台接口细节

> 以下为调研整理的接口要点，**接入实现前必须逐项以官方最新文档核对**。

### 4.1 阿里云百炼（通义万相）【P0，首选验证】

- 官网/控制台：https://bailian.console.aliyun.com/ ｜ API 参考：https://help.aliyun.com/zh/model-studio/text-to-video-api-reference
- 免费额度：新用户 50 张图 / **50 秒视频**（约 90 天有效）；Wan3.0 公测另送 30 秒；控制台可开「免费额度用完即停」防误扣费。
- 模式：异步任务式。提交 `POST`（模型如 `wan2.6-t2v` / `Wan3.0`，endpoint 与 key 须**同地域**）→ 轮询任务状态 → 成功后取 `video_url`。
- 鉴权：Bearer Token（`Authorization: Bearer <api_key>`）。
- 主要能力：文生视频、图生视频（`*`-i2v 模型）、分镜短片 / 多段拼接（Wan3.0 长视频）。
- 注意：视觉理解系列（Qwen-VL）不在此列；其视频生成模型名随版本迭代（wan2.5 / 2.6 / 2.7 / 3.0），`provider_cost_tables` 需跟模型名对应。

#### 4.1.1 文生视频接口（官方确认）

**提交（创建任务）**

```
POST https://{WorkspaceId}.cn-beijing.maas.aliyuncs.com/api/v1/services/aigc/video-generation/video-synthesis
POST https://{WorkspaceId}.ap-southeast-1.maas.aliyuncs.com/api/v1/services/aigc/video-generation/video-synthesis
```

> `{WorkspaceId}` 为百炼控制台「业务空间详情」里的业务空间 ID；旧域名 `dashscope.aliyuncs.com` 仍可用。

请求头（Headers）：

| Header | 必填 | 说明 |
|---|---|---|
| `Content-Type` | ✅ | 固定 `application/json` |
| `Authorization` | ✅ | `Bearer sk-xxxx` |
| `X-DashScope-Async` | ✅ | **必须**为 `enable`，否则报错 `current user api does not support synchronous calls` |

请求体（Body）：

```jsonc
{
  "model": "wan2.7-t2v",            // 必填，如 wan2.7-t2v / wan2.7-t2v-2026-06-12
  "input": {
    "prompt": "一只小猫在月光下奔跑",   // 必填，t2v 最长 5000 字符
    "negative_prompt": "低分辨率、错误、最差质量", // 可选，≤500 字符
    "audio_url": "https://... mp3/wav"          // 可选，2~30s，≤15MB
  },
  "parameters": {
    "resolution": "720P",           // 可选：720P / 1080P，默认 1080P（影响费用）
    "ratio": "16:9",                // 可选：16:9/9:16/1:1/4:3/3:4
    "duration": 5,                  // 可选：[2,15] 秒（影响费用，默认 5）
    "prompt_extend": true,          // 可选，智能改写 prompt，默认 true
    "watermark": false,             // 可选，右下角「AI生成」水印，默认 false
    "seed": 12345                   // 可选：[0, 2147483647]
  }
}
```

响应体（成功）——**保存 task_id（有效期 24h）**：

```jsonc
{
  "output": {
    "task_id": "43b954a2-3e86-4681-9443-xxxxxx",
    "task_status": "PENDING"        // PENDING|RUNNING|SUCCEEDED|FAILED|CANCELED|UNKNOWN
  },
  "request_id": "72082605-4559-9bb7-aa5c-xxxxxx"
}
```

**查询（轮询任务结果）**

```
GET https://{WorkspaceId}.cn-beijing.maas.aliyuncs.com/api/v1/tasks/{task_id}
```

- 只需 `Authorization: Bearer sk-xxx`；建议轮询间隔 **15s**。
- 状态流转：`PENDING → RUNNING → SUCCEEDED/FAILED`。
- 成功后响应（`video_url` 有效期 24h，需及时转存）：

```jsonc
{
  "output": {
    "task_id": "43b954a2-...",
    "task_status": "SUCCEEDED",
    "video_url": "https://dashscope-xxx.oss-accelerate.aliyuncs.com/xxx.mp4?Expires=xxx",
    "submit_time": "2026-04-16 10:50:12.718",
    "scheduled_time": "2026-04-16 10:50:21.430",
    "end_time": "2026-04-16 11:02:00.274",
    "orig_prompt": "一只小猫在月光下奔跑"
  },
  "usage": {
    "duration": 10,             // 计费用视频秒数
    "output_video_duration": 10,
    "SR": 720,                  // 分辨率档位
    "ratio": "16:9",
    "video_count": 1
  },
  "request_id": "72082605-..."
}
```

- 计费/额度：以 `usage.duration` 为准（按秒计费，`resolution` 档位也影响）。可配置 `provider_cost_tables` 把秒数折算成「等效次数」。
- ⚠️ 图生视频/分镜短片（Wan3.0 多镜头拼接）走同链路、不同 `model` 与 input 字段，编码时查对应模型文档。

### 4.2 智谱 bigmodel（清影 CogVideoX）【P1，首选验证】

- 官网/控制台：https://bigmodel.cn/ ｜ API：清影 cogvideox（OpenAI 兼容风格）。
- 免费额度：新注册赠送 token；清影 C 端免费，API 走 token 计费，赠送 token 可用于文生视频/图生视频。
- 模式：异步任务式。提交任务 → 轮询任务结果 → 取 `video_result` 或生成结果 URL。
- 鉴权：Bearer Token。
- 主要能力：文生视频、图生视频（支持多个视频方案同批提交 / 批量生成）。
- 价值：**接口最接近 OpenAI 风格，token 赠送明确，是最适合首跑通全链路的平台**（用户实际体验过的就是这个）。

#### 4.2.1 视频生成接口（✅ 实测确认，2026-08-17 已用真实 key 跑通全链路）

- 免费模型：`cogvideox-flash`（文生 / 图生，免费）。付费模型 `cogvideox` / 新版本视控制台模型广场为准。
- 基准域名：`https://open.bigmodel.cn/api/paas/v4`（登录智谱开放平台 API-KEY 鉴权，`Authorization: Bearer <api_key>`）。

**提交（创建生成任务）**

```
POST https://open.bigmodel.cn/api/paas/v4/videos/generations
```

请求体（Body，实测有效）：

```jsonc
{
  "model": "cogvideox-flash",       // 必填
  "prompt": "一只小猫在月光下奔跑",   // 必填，文生视频
  "image_url": "https://.../ref.png" // 可选，图生视频传入参考图 URL
}
```

响应（实测确认）：**task_id 即顶层 `id`，与 `request_id` 相同**：

```jsonc
{
  "id": "20260818102501423653886863409e",   // ← 这就是 task_id（顶层）
  "model": "cogvideox-flash",
  "request_id": "20260818102501423653886863409e",
  "task_status": "PROCESSING"               // PROCESSING / SUCCESS / FAIL
}
```

**查询（轮询任务结果）**

```
GET https://open.bigmodel.cn/api/paas/v4/async-result/{task_id}
```

- 轮询间隔建议 6-10s；实测高峰期任务 PROCESSING 阶段耗时 **约 6-10 分钟**。
- 状态字段：`task_status` ∈ `PROCESSING / SUCCESS / FAIL`。
- 成功终态结构（实测确认，**视频在 `video_result[]`，封面在 `cover_image_url`**）：

```jsonc
{
  "id": "20260818102501423653886863409e",
  "task_status": "SUCCESS",
  "model": "CogVideoX-Flash",
  "usage": { "prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0 },
  "video_result": [
    {
      "url": "https://aigc-files.bigmodel.cn/api/cogvideo/xxx_0.mp4",        // 视频下载地址
      "cover_image_url": "https://maas-watermark-prod-new...watermark.png" // 视频封面
    }
  ]
}
```

- ⚠️ **实测发现的限流**：高峰期提交会间歇性返回 `{"error":{"code":"1305","message":"该模型当前访问量过大，请您稍后再试"}}`（HTTP 429），需在内置**指数退避重试**（本次实测重试第 2 次即成功）。
- ⚠️ 免费模型无 usage 计费（实测 token 全 0）；付费模型 `cogvideox` 的 usage 结构待实测，接入时应容错 `usage` 缺失。
- 限流重试 + 字段解析已可固化为首个可用适配器。

### 4.3 火山引擎（豆包 Seedance）【P2，视活动】

- 官网/控制台：https://console.volcengine.com/ ｜ 产品：火山方舟/豆包大模型（AR-python/video SDK），`Doubao-Seedance-2.5` 等模型。
- ⚠️ 免费额度：Seedance 2.5 API 已于 2026-08 上线，但**默认按量计费**，「免费额度」以当期活动为准，非稳定默认。
- 模式：异步任务式（提交 `create_video_submit` 类接口 → 轮询任务 → 取生成结果）。
- 鉴权：需 Volc OpenAPI **签名 v4**（由 `ACCESS_KEY` + `SECRET_KEY` 动态生成 `Authorization`），或直接用官方 SDK。⚠️ 与「纯 apikey」不同，接入成本高。
- 注意：本项目已有豆包 run 走 WebView（`SeedanceProvider` 为 TODO），可先复用；API 接入作为可选。

### 4.4 腾讯云（混元生视频）【P3】

- 官网/控制台：https://console.cloud.tencent.com/tokenhub ｜ 产品：混元生视频（Hunyuan 文生视频/图生视频）。
- ⚠️ 免费额度：商用 API，前期需**内测/白名单申请**，免费额度不明确。
- 模式：异步任务式（`SubmitHunyuanJob` 提交 → `QueryHunyuanJob` 轮询 → 拿视频 URL）。
- 鉴权：**TC3-HMAC-SHA256** 签名（`Authorization` + `X-TC-Action`/`X-TC-Version`/`X-TC-Timestamp` 等固定头），需 `SecretId` + `SecretKey`。接入成本高。

### 4.5 百度千帆（文生视频）【P3】

- 官网/控制台：https://console.bce.baidu.com/ ｜ 千帆：https://qianfan.cloud.baidu.com/。
- ⚠️ 免费额度：千帆有「大模型普惠计划」（旗舰模型对企业新用户免费），但**视频生成类的稳定 apikey 免费额度不明确**。
- 模式：异步任务式（文生视频接口 → 轮询任务结果 → 取生成 URL）。
- 鉴权：Bearer Token（`Authorization: Bearer <AK>`）相对直白，签名复杂度低于火山/腾讯。

### 4.6 千问平台（platform.qianwenai.com）【P3】

- 官网/控制台：https://platform.qianwenai.com/ ｜ 定价页：https://platform.qianwenai.com/pricing/token-plan。
- ⚠️ 免费额度：千问 APP 端 Wan/Qwen-Image 免费开放，但 **API 平台侧稳定的视频生成免费 apikey 额度不明确**。
- 现有 `qwen.ts`（provider id `qwenwan`）走 WebView；若接入 API，模型指向通义万相（与百炼重叠），建议以百炼为主，此处延后。

## 5. 代码落地草案（不在此次改动，仅规划）

```
packages/providers/src/
  apikey/
    base.ts                 # ApiKeyProvider extends BaseProvider：提交→轮询→提取通用骨架
    zhipu.ts                # 智谱 cogvideox
    bailian.ts              # 阿里百炼 wan
    volcengine.ts           # 火山 Seedance（签名）
    tencent.ts              # 腾讯混元（TC3 签名）
    baidu.ts                # 百度千帆
  index.ts                  # createAllProviders() 增补实例
packages/core/src/types.ts  # ProviderCapabilities 补 video 相关（如需）+ 账号密钥类型
packages/crypto/            # apikey 加解密（沿用现有）
apps/desktop                # 厂商绑定 Tab：apikey 输入 + 「验证额度」按钮
```

新增 Provider 应满足：

- 实现 `BaseProvider.generate()`（提交→轮询→解析 `videoUrl`）与 `estimateCost()`。
- 返回 `GenerateResult.traceId`（对厂商 task_id）以支持历史/重试/状态展示。
- 密钥读取走 `getProviderKeySecret`（不随列表下发）。
- 消耗估算落到 `provider_cost_tables`（admin 可配免费额度 / 计费价格）。

### 4.7 Vidu（生数科技）— ✅ 官方文档确认

- 官网/控制台：https://platform.vidu.cn/ ｜ 产品入口：https://www.vidu.cn/ ｜ 文档：https://platform.vidu.cn/docs/introduction
- 模型系列：ViduQ3、ViduQ2、ViduQ1、Vidu2.0（用户问的「Vidu Q1」「Vidu 2」即 `viduq1` 和 `vidu2.0`）
- 鉴权：`Authorization: Token {api_key}`（⚠️ 注意是 `Token` 前缀，不是 `Bearer`）
- 计费方式：**积分制**，1 积分 = 0.03125 RMB；注册完善信息可获赠积分福利；充值 500 元起（16000 积分，1 年有效）
- 免费额度性质：**不是每日免费，是注册赠送 + 充值积分制**；但「错峰模式」价格减半，近似免费调用量翻倍
- 并发：每账号默认 5 个免费并发

#### 4.7.1 模型对比

| 模型 | 时长 | 清晰度 | 文生视频 | 图生视频 | 参考生视频 | 首尾帧 |
|---|---|---|---|---|---|---|
| `viduq1` | 5S | 1080p | ✅ | ✅ | ✅ | ✅ |
| `vidu2.0` | 4S/8S | 360p/720p/1080p | ❌ | ✅ | ✅ | ✅ |
| `viduq2` | 1-10S | 540p/720p/1080p | ✅ | ❌ | ✅ | ❌ |
| `viduq3-pro` | 1-16S | 540p/720p/1080p | ✅ | ✅ | ✅ | ✅ |

> ⚠️ `vidu2.0` **不支持文生视频**，只支持图生视频/参考生/首尾帧。

#### 4.7.2 定价（官方确认）

**ViduQ1 定价**（固定 5S 1080p）：

| 能力 | 积分消耗 | 错峰积分 | 折合 RMB |
|---|---|---|---|
| 文生视频 | 80 | 40 | 2.5 元 |
| 图生视频 | 80 | 40 | 2.5 元 |
| 参考生视频 | 80 | 40 | 2.5 元 |
| 首尾帧 | 80 | 40 | 2.5 元 |

**Vidu 2.0 定价**：

| 能力 | 时长 | 清晰度 | 积分消耗 | 错峰积分 | 折合 RMB |
|---|---|---|---|---|---|
| 图生视频 | 4S | 360p | 20 | 10 | 0.625 元 |
| 图生视频 | 4S | 720p | 40 | 20 | 1.25 元 |
| 图生视频 | 4S | 1080p | 100 | 50 | 3.125 元 |
| 图生视频 | 8S | 720p | 100 | 50 | 3.125 元 |
| 参考生视频 | 4S | 360p | 80 | 40 | 2.5 元 |
| 参考生视频 | 4S | 720p | 80 | 40 | 2.5 元 |

> 错峰模式：48h 内生成，未完成自动取消并返还积分；`off_peak: true` 触发。

#### 4.7.3 接口详情（官方确认）

**基准域名**：`https://api.vidu.cn/ent/v2`

**创建文生视频任务**

```
POST https://api.vidu.cn/ent/v2/text2video
```

请求头：

| Header | 值 |
|---|---|
| `Content-Type` | `application/json` |
| `Authorization` | `Token {api_key}` |

请求体（Body）：

```jsonc
{
  "model": "viduq1",               // 必填：viduq1 / viduq1-classic（Q1 只支持 5S 1080p）
  "prompt": "一只橘色小猫在月光下追逐萤火虫", // 必填，≤5000 字符
  "style": "general",              // 可选：general / anime（仅 Q1 生效）
  "duration": 5,                  // 可选：Q1 固定 5
  "resolution": "1080p",          // 可选：Q1 固定 1080p
  "aspect_ratio": "16:9",         // 可选：16:9 / 9:16 / 1:1 / 4:3 / 3:4（3:4、4:3 仅 Q2/Q3）
  "movement_amplitude": "auto",   // 可选：auto / small / medium / large（仅 Q1 生效）
  "seed": 0,                       // 可选：随机种子
  "off_peak": false,               // 可选：错峰模式（价格减半，48h 内出片）
  "watermark": false,              // 可选：水印
  "callback_url": "https://...",   // 可选：回调地址
  "payload": "custom-id-123"       // 可选：透传参数
}
```

**创建图生视频任务**（Vidu 2.0 走此接口）

```
POST https://api.vidu.cn/ent/v2/img2video
```

请求体（与文生视频相比，`images` 为必填，其余参数类似）：

```jsonc
{
  "model": "vidu2.0",              // 必填：vidu2.0 / viduq1 / viduq1-classic / viduq2-* / viduq3-*
  "images": ["https://.../ref.png"], // 必填：1 张图（URL 或 base64），≤50MB，比例 < 4:1
  "prompt": "描述文字",            // 可选
  "duration": 4,                  // 可选：vidu2.0 可选 4 或 8
  "resolution": "360p",          // 可选：vidu2.0 可选 360p / 720p / 1080p
  "off_peak": false,
  // ... 其余同文生视频
}
```

**提交响应**（创建成功）：

```jsonc
{
  "task_id": "a1b2c3d4...",
  "state": "created",              // created | queueing | processing | success | failed
  "model": "viduq1",
  "prompt": "...",
  "duration": 5,
  "resolution": "1080p",
  "credits": 80,                  // 消耗积分数
  "off_peak": false,
  "created_at": "2026-08-17T..."
}
```

**查询任务结果**

```
GET https://api.vidu.cn/ent/v2/tasks/{task_id}/creations
```

- 只需 `Authorization: Token {api_key}`；建议轮询间隔 **10-15s**。
- 状态流转：`created → queueing → processing → success / failed`
- 成功后响应：

```jsonc
{
  "id": "a1b2c3d4...",
  "state": "success",
  "credits": 80,
  "creations": [
    {
      "id": "creation-xxx",
      "url": "https://...result.mp4",       // 视频下载地址，24h 有效
      "cover_url": "https://...cover.jpg",  // 封面，24h 有效
      "watermarked_url": "https://...wm.mp4" // 带水印版本（可选）
    }
  ]
}
```

**查询积分余额**

```
GET https://api.vidu.cn/ent/v2/credits
```

- 用于在「厂商账号管理」页展示剩余积分，对应 `provider_cost_tables` 的余额读取。

**取消任务**

```
POST https://api.vidu.cn/ent/v2/cancel-task/{task_id}
```

- 错峰任务可取消并返还积分。

#### 4.7.4 接入要点

- 鉴权是 `Token` 前缀（非 `Bearer`），适配器里不要搞错。
- `vidu2.0` 不支持文生视频，UI 上需要根据模型禁用文生入口。
- **错峰模式** (`off_peak: true`) 价格减半，近似免费量翻倍——可作为调度器优选策略。
- 视频结果 URL 仅 **24h 有效**，必须及时转存（与百炼一致）。
- 支持 `callback_url` 回调通知，比轮询更高效（适配器可优先用回调 + 轮询兜底）。
- `credits` 字段在创建响应和查询响应中都会返回，可用于记账。

## 6. 各平台接口细节核对清单

> 阿里百炼（§4.1）、**智谱（§4.2 已实测确认）**、Vidu（§4.7）均为**官方/实测确认**完整请求/响应结构。火山/腾讯/百度因涉及 AK/SK 签名与内测申请，**仅记录接口要点，具体请求/响应字段在申请到权限后抓包确认**。

| 平台 | 鉴权 | 提交接口 | 查询接口 | 接口细节状态 |
|---|---|---|---|---|
| 阿里百炼 | Bearer + `X-DashScope-Async: enable` | `POST .../services/aigc/video-generation/video-synthesis` | `GET .../api/v1/tasks/{task_id}` | ✅ 官方确认（§4.1.1） |
| 智谱 | Bearer | `POST /api/paas/v4/videos/generations` | `GET /api/paas/v4/async-result/{task_id}` | ✅ 实测确认 · 顶层`id`为task_id · `video_result[].url`（§4.2.1） |
| 火山引擎 | Volc 签名 v4 | `create_video_submit` 类（模型 `Doubao-Seedance-*`） | 任务查询接口 | 🚧 待开通后抓包 |
| 腾讯云 | TC3-HMAC-SHA256 | 混元生视频 `SubmitHunyuanJob` | `QueryHunyuanJob` | 🚧 待内测/白名单后抓包 |
| 百度千帆 | Bearer AK | 文生视频异步接口 | 任务轮询接口 | 🚧 待开通后抓包 |
| 千问平台 | Bearer（同阿里云） | 指向通义万相（同上） | 同上 | 🔁 复用百炼链路 |
| Vidu | `Token` 前缀（非 Bearer） | `POST https://api.vidu.cn/ent/v2/text2video` 或 `.../img2video` | `GET .../ent/v2/tasks/{id}/creations` | ✅ 官方确认（§4.7.3） |

## 7. 风险与合规

- **合规**：官方 API 是授权调用，无「逆向/违反 ToS」问题，比 WebView 更干净，也贴合仓库 `合规边界` 定位。但商业化时仍需遵守各家 API 付费/免费条款，谨防转售/滥用风控封号。
- **免费额度波动**：赠送额度有有效期/每日上限，模型名与价格会变，需在 `provider_cost_tables` 可配 + 提供「验证额度」接口实时查询。
- **签名复杂度**：火山/腾讯/百度的 AK/SK 签名实现需投入额外工作量，优先级靠后。
- **文档时效**：本节接口路径、模型名、免费额度信息为调研快照，编码阶段一律以官方最新文档为准。

## 8. 桌面端厂商模块 UI 结构（确认版）

> 状态：已确认方向（2026-08-17）。三个取向：**① 去重=接口自动+人工兜底；② 额度=实时官方余额；③ 模型=标签式清单**。落在 apps/desktop，复用现有「厂商表 + 展开账号子表」框架（`Providers.tsx` / `AddProviderModal.tsx` / `Dashboard.tsx`）。

### 8.1 设计原则

- **尽量复用**现有 apikey 支持（`providers.auth_type = 'apikey'` 已能单 Key 绑定），只做增强，不重写。
- **Cookie 厂商与 apikey 开放平台并存**，同一张表、同一套聚合；差异仅在 apikey 增加「账号标识 / 实时额度 / 模型标签」三列能力。
- 额度权威来源 = **平台实时余额**（如 Vidu `GET /credits`、百炼 `usage`）；本地 `quota_ledger` 仅作调度扣减依据，双轨不混。

### 8.2 厂商行（列表页，变化小）

```
┌┬─────────┬──────┬──────────────┬──────────────────┬──────┬────────┐
│▸│ 智谱AI   │ 积分  │ 剩 2,150/2,200 │ 2个Key · 1份额度    │ 正常 │ 绑定Key │
└┴─────────┴──────┴──────────────┴──────────────────┴──────┴────────┘
```

- 「账号数」列对 apikey 厂商显示：**`N 个 Key · 去重后 M 份额度`**。多 Key 同账号共享一份积分，不重复计入聚合剩余。
- 其余列（额度单位 / 今日剩余 / 状态 / 操作）沿用现有逻辑。

### 8.3 展开后的「账号/Key 子表」（核心新增）

对 apikey 厂商，子表上比 cookie 厂商**多三列**：

```
┌──────────────┬────────────────┬─────────────────┬─────────┬─────────────┐
│ Key 账号标识   │ 剩余额度(实时)     │ 可用模型(标签)     │ 启用    │ 操作          │
├──────────────┼────────────────┼─────────────────┼─────────┼─────────────┤
│ 智谱·工作号    │ 2,150 积分       │ Q闪/清影          │ ✓启用   │ 详情│共享│解绑│
│  key:zhi-…de  │ Flash另有免费     │ cogvideox-*      │          │             │
└──────────────┴────────────────┴─────────────────┴─────────┴─────────────┘
```

- **Key 账号标识**：绑定后调平台「鉴权/账号信息」接口返回的账号身份（用户 id / 邮箱脱敏 / workspace id）。同账号多 Key 此处显示同名，灰显「共享额度」。
- **剩余额度(实时)**：官方 API 拉取的真实余额，非本地账本估算。
- **可用模型(标签)**：该 Key 可用的模型名做成小标签（如 `cogvideox-flash` / `cogvideox(计费)`），鼠标悬停/点击看费率与免费标识。
- 操作列沿用现有：进入官网(仅 cookie)/共享到团队/设为默认(仅 cookie)/测试/解绑。

### 8.4 绑定弹窗（新增「校验去重」步骤）

在 `AddProviderModal` 增量改造，填 Key 后增加一步「验证并绑定」：

```
填 API Key → 点「验证并绑定」
    ↓ 调平台鉴权接口，解析账号唯一标识
    ├─ 已存在同账号 Key → 弹确认：
    │   「识别到与【智谱·工作号】相同账号(key:zhi-xxx)，两 Key 将共享同一份积分额度，
    │    仍要绑定吗？」  [取消] [仍然绑定]
    └─ 新账号 → 直接保存写 provider_keys
```

- 去重依赖平台是否提供账号标识接口：有则自动比对（推荐）；无标识接口的平台**降级为弹提示人工确认**，不硬拦（§5.3 明确过）。

### 8.5 可选：Key 详情抽屉（点「详情」展开）

```
智谱·工作号   key_id: zhi-xxx
┌ 额度账本 ┐
  剩余 2,150 积分 / 总量 2,200 · 活跃
  ├ 可用模型: cogvideox-flash(免费) · cogvideox(计费)
  └ 费率: 见平台定价(provider_cost_tables 可配)
┌ 最近消耗 ┐ (对接到 quota_ledger)
  07-16 18:32  清影 flash · 5s   消耗 ×0(免费)
  07-16 12:10  清影 · 5s         消耗 -N 积分
```

复用现有「共享到团队 / 测试 / 解绑 / 启用」按钮。

### 8.6 落地改动清单

| 位置 | 改动 |
|---|---|
| `packages/providers` | apikey 厂商适配器增加 `getAccountInfo()`（返账号标识）与 `getBalance()`（返实时余额）、`getModels()`（返可用模型） |
| `AddProviderModal.tsx` | 填 Key 后「验证并绑定」→ 调 `getAccountInfo` 比对去重 → 确认后写库 |
| `Providers.tsx` | 子表为 apikey 厂商渲染账号标识 / 实时余额 / 模型标签三列；聚合列显示「N Key · M 份额度」 |
| `Dashboard.tsx` | apikey 厂商卡片也展示实时余额（复用现有 ProviderStatus 面板） |
| `provider_keys` | 可选加列 `account_id`（账号唯一标识，用于去重） |

## 9. 去重与额度计算逻辑（基于实测字段修订，2026-08-17）

> 本小节基于智谱实测确认的接口结构（task_id=顶层`id`、`video_result[].url`、`cover_image_url`），并把去重/额度的**判定依据与实测字段一一对应**，替代此前笼统的「去重=接口自动+人工兜底」描述。

### 9.1 数据模型：`provider_keys` 需要两个标识字段

| 字段 | 含义 | 来源 |
|---|---|---|
| `account_id` | **账号唯一标识**（去重键） | 平台「账号信息接口」返回；无该接口平台则用**用户名/邮箱脱敏**或 **key 形态指纹** |
| `key_fingerprint` | **单个 key 的不可逆指纹**（SHA-256） | 本地对明文 key 做摘要，用于精确去重、不明文比对 |

> ⚠️ 实测结论：**智谱接口不返回账号标识字段**，纯靠接口无法自动判定"两个 key 是否同一账号"。因此走 §9.2 的分层策略，`account_id` 优先、`key_fingerprint` 兜底。

### 9.2 去重判断逻辑（绑定时的判定优先级）

```
新 key 填进来 → 存入前执行去重：
├─ 若平台返回 account_id（智谱不返回，百炼/Vidu 可能返回）：
│    比对 provider_keys.account_id 是否已存在
│    ├─ 存在（同账号）→ 弹「两 key 共享同一份额度，仍要绑定？」[取消][仍绑定]
│    └─ 不存在 → 跳过，直接新绑定
├─ 若无 account_id（智谱实测场景）：
│    走 key_fingerprint 精确去重
│    ├─ 完全同 key → 拦截「该 key 已绑定，无需重复添加」
│    └─ 不同 key → 无法自动判同账号 → 弹「大概率是新 key，可绑定；若与既有账号属同一账号将共享额度」[绑定]
```

### 9.3 额度计算逻辑（实时余额 + 本地账本双轨）

| 维度 | 来源 | 用途 |
|---|---|---|
| **权威余额** | 平台实时接口（智谱暂无公开余额接口 → 走账本估算；Vidu `GET /credits`；百炼 `usage` 可累计） | UI 展示「剩余额度」 |
| **调度判定** | 本地 `quota_ledger` 按本次消耗扣减 | 决定"这次还能不能生成" |

- **智谱免费模型计费实测**：`cogvideox-flash` 成功返回 `usage` 全 0（token 不扣）、且**没有单项余额字段**。故智谱「剩余额度」无法实时取，只能：当日账本 `daily_total - used` 展示，或按平台赠送 token 折算等效次数（可配在 `provider_cost_tables`）。
- **多 key 同账号额度不重复**：同 `account_id` 的多个 key，权威余额只算一次（作为该账号共享池）；本地账本若按 key 各自记录，UI 聚合时对同 `account_id` 去重求和。

### 9.4 调度扣减（沿用现有 estimateCost，字段已对齐）

- `estimateCost()` 估算本次消耗（时长+分辨率+模型）→ 落到 `quota_ledger`。
- traceId = task_id（顶层 `id`），已实测确认，直接写入 history 用于重试/状态。
- 成功取 `video_result[0].url`（视频）+ `cover_image_url`（封面）；`video_result` 为数组，适配器取 `[0]`。
- 失败时：若是限流 1305 → 标记可重试 → 指数退避回来；其他错误 → 记失败。

## 10. 下一步

1. ✅【已完成】**实测智谱 `cogvideox-flash`**：提交→轮询→拿 video_url 已跑通，§4.2.1 字段已实锤。
2. 【可选】实测阿里百炼 `wan2.7-t2v`（§4.1 已给完整字段）作为第二个 Provider。
3. 【去重待定】实测智谱「账号信息接口」是否存在；若无则确认 §9.2 走 key_fingerprint 兜底路线（当前智谱 key 为 `{id}.{secret}` 形态，可在平台查看归属，需 UI 辅助确认）。
4. 补充调研火山/腾讯/百度的当日免费额度政策与 SDK 示例（编码期做）。
5. UI 按 §8 + §9 落地后，需要时整理成正式开发任务（含迁移脚本、测试）。