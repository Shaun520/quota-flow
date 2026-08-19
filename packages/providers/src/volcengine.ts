// 火山方舟（火山引擎 ARK）API Key 型厂商适配器
//
// 本轮只实现「绑定」所需的能力（API Key 校验、账号级指纹、会话工具、额度占位）：
//   - 数据面为 Bearer Token 鉴权（Authorization: Bearer <ARK_API_KEY>），与智谱同为 API Key 型。
//   - 火山方舟 API Key 无法直接读取资源包/免费额度（需火山控制台登录会话 + 内部接口，接口待探测，见
//     docs/厂商与API平台接入/火山方舟API Key绑定.md §6）。因此真实额度展示「接口待探测」时以本地账本为准。
//   - decodeVolcenginePayload 与智谱同构（兼容纯 key 旧格式）：{v:1,apiKey,consoleJwt}。
//
// 日志埋点统一前缀 [volc]（enabled 同 zhipu，受 QUOTA_DEBUG 控制）。

import { createHash } from "node:crypto";

export const VOLC_BASE_URL = "https://ark.cn-beijing.volces.com/api/v3";
/** 火山方舟控制台（API Key 管理页），用于绑定「获取 API Key」打开会话窗口捕获 consoleJwt */
export const VOLC_CONSOLE_URL = "https://console.volcengine.com/ark/region:cn-beijing/apikey";

/** 与智谱一致的支付/额度结构（字段为探测预留，运行时确认后固化字段映射） */
export interface VolcengineQuota {
  available: boolean
  total: number
  remaining: number
  expiresAt?: string | null
  packageName?: string | null
  expired?: boolean
  accountId?: unknown
}

/**
 * 解火山方舟加密负载（兼容多种格式）：
 * - 新版：{ v: 1; apiKey: string; consoleJwt?: string | null; accountId?: string | null; models?: VolcengineFreeVideoModel[] } JSON 字符串
 * - 旧版：纯 API Key 字符串（非 `{` 开头）
 */
export function decodeVolcenginePayload(decrypted: string): {
  apiKey: string
  consoleJwt?: string | null
  accountId?: string | null
  models?: VolcengineFreeVideoModel[]
} {
  const trimmed = decrypted.trim()
  if (!trimmed.startsWith("{")) return { apiKey: trimmed }
  try {
    const parsed = JSON.parse(trimmed) as {
      v?: number
      apiKey?: string
      consoleJwt?: string | null
      accountId?: string | null
      models?: VolcengineFreeVideoModel[]
    }
    const apiKey = parsed.apiKey?.trim() ?? ""
    let consoleJwt = parsed.consoleJwt ?? null
    let accountId = parsed.accountId ?? null
    if (typeof consoleJwt === "string" && consoleJwt) {
      try {
        consoleJwt = decodeURIComponent(consoleJwt)
      } catch {}
    }
    if (typeof accountId === "string") {
      accountId = accountId.trim() || null
    } else {
      accountId = null
    }
    const models = Array.isArray(parsed.models) ? parsed.models.filter((m) => m && typeof m.id === "string") : undefined
    return { apiKey, consoleJwt, accountId, models }
  } catch {
    return { apiKey: trimmed }
  }
}

/** 从自定义状态 JWT 中解析 `exp`（毫秒）；非标准 JWT / 无 exp / 解析失败返回 null（据此不自动续期）。 */
export function jwtExpiryMs(jwt?: string | null): number | null {
  if (!jwt) return null
  const m = /^([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/.exec(jwt.trim())
  if (!m) return null
  try {
    const b64 = m[2].replace(/-/g, "+").replace(/_/g, "/")
    const pad = b64.length % 4 ? "=".repeat(4 - (b64.length % 4)) : ""
    const data = JSON.parse(Buffer.from(b64 + pad, "base64").toString("utf8")) as { exp?: number }
    return typeof data.exp === "number" ? data.exp * 1000 : null
  } catch {
    return null
  }
}

function fingerprintFor(providerId: string, raw: string): string {
  const norm = raw.trim()
  return createHash("sha256")
    .update(`${providerId}|${norm}`)
    .digest("hex")
}

/**
 * 火山方舟账号级指纹：优先用控制台会话解析出的稳定账号标识 accountId（同一账号多个 API Key 共享）。
 * accountId 为空（未捕获会话 / 未抓到账号接口）时回退按 API Key 明文哈希。
 * payload 为「加密前明文」，可能是 `{v:1,apiKey,consoleJwt,accountId}` 或纯 API Key。
 */
export async function volcengineAccountFingerprint(payload: string): Promise<string | null> {
  const { apiKey, accountId } = decodeVolcenginePayload(payload)
  if (!apiKey) return null
  if (accountId) {
    return fingerprintFor("volcengine", "volc-account:" + accountId)
  }
  // TODO: 若后续实抓到能返回稳定账号标识的控制台接口，优先解析 accountId 生成账号级指纹，与智谱 customerId 策略对齐。
  return fingerprintFor("volcengine", apiKey)
}

/**
 * 校验火山方舟 API Key 是否有效（不产生任何生成费用）：
 * 请求一个不存在的只读任务查询端点，用状态码区分鉴权——无效 key 返回 401，有效 key 返回业务错误(404 等)。
 * 仅把 401 视为"无效"，其余 HTTP 响应视为鉴权已通过（Key 有效）。
 */
export async function testVolcengineApiKey(
  apiKey: string,
): Promise<{ ok: boolean; error?: string }> {
  const key = (apiKey ?? "").trim()
  if (!key) return { ok: false, error: "请先输入 API Key" }
  try {
    // 用一个不可能存在的任务 id 触发查询：有效 key 不会因此扣费，且能区分鉴权是否通过
    const res = await fetch(`${VOLC_BASE_URL}/contents/generations/tasks/qf-invalid-key-check-nonexistent`, {
      method: "GET",
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(15000),
    })
    if (res.status === 401) return { ok: false, error: "API Key 无效或已失效（身份验证失败）" }
    if (res.status >= 200 && res.status < 600) return { ok: true }
    return { ok: false, error: `校验失败（HTTP ${res.status}）` }
  } catch {
    return { ok: false, error: "校验失败（网络错误或超时）" }
  }
}

/**
 * 查询火山方舟真实额度（资源包/免费额度）。
 * 火山 API Key 无法经数据面读取额度；需控制台会话 + 内部接口，而该接口字段尚未探测确认（见方案 §6），
 * 故本轮先返回「待探测」结果，由上层回退到本地账本展示；待实抓确认后固化字段映射。
 */
export async function fetchVolcengineQuota(
  apiKey: string,
  consoleJwt?: string,
): Promise<{ ok: true; quota: VolcengineQuota } | { ok: false; error: string }> {
  if (!consoleJwt) {
    return { ok: false, error: "火山方舟额度接口待探测：暂以本地账本为准" }
  }
  // 控制台会话已捕获，但额度接口尚未确认（未探测到 URL/字段），本轮不盲目请求未知端点。
  return { ok: false, error: "火山方舟额度接口待探测：暂以本地账本为准" }
}

/**
 * 火山方舟「免费视频生成模型」目录（厂商级、账号无关）。
 * Model ID 为平台固定值（2026-08-19 实测，见 docs/厂商与API平台接入/火山方舟免费视频模型额度对接.md）。
 * 新账号绑定时由上层调用以标识可用免费模型；建模密钥值固定、无需运行时抓取控制台。
 * 说明：1.0-lite-t2v/i2v 官方文档未收录 Model ID，本轮不纳入。
 */
export interface VolcengineFreeVideoModel {
  id: string
  /** 控制台展示名（用于爬取归一化，与官方模型列表一致） */
  name: string
  modes: string[]
  free: true
  price: string
  /** 该平台预留的免费推理额度提示（供 UI 展示） */
  quotaHint: string
  /** 【每账号】是否已开通该模型（1.0-pro-fast 等默认未开通，需到控制台开通后使用）；未抓到时取内置默认值 */
  activated?: boolean
  /** 【每账号】绑定控制台抓到的免费 token 额度（剩余/总数）；未抓到为 undefined */
  freeQuota?: { remaining?: number; total?: number }
}

export function volcengineFreeVideoModels(): VolcengineFreeVideoModel[] {
  return [
    {
      id: "doubao-seedance-1-0-pro-250528",
      name: "Doubao-Seedance-1.0-pro",
      modes: ["text2video", "img2video"],
      free: true,
      price: "免费",
      quotaHint: "免费推理额度（开通管理页）",
      activated: true,
      freeQuota: { remaining: 272120, total: 2000000 }
    },
    {
      id: "doubao-seedance-1-5-pro-251215",
      name: "Doubao-Seedance-1.5-pro",
      modes: ["text2video", "img2video"],
      free: true,
      price: "免费",
      quotaHint: "免费推理额度（开通管理页）",
      activated: true,
      freeQuota: { remaining: 2000000, total: 2000000 }
    },
    {
      id: "doubao-seedance-1-0-pro-fast-251015",
      name: "Doubao-Seedance-1.0-pro-fast",
      modes: ["text2video", "img2video"],
      free: true,
      price: "免费",
      quotaHint: "免费推理额度（未开通模型，需到控制台开通后使用）",
      activated: false,
      freeQuota: { remaining: 2000000, total: 2000000 }
    },
    {
      id: "doubao-seedance-1-0-lite-t2v",
      name: "Doubao-Seedance-1.0-lite-t2v",
      modes: ["text2video", "img2video"],
      free: true,
      price: "免费",
      quotaHint: "免费推理额度（未开通模型，需到控制台开通后使用）",
      activated: false,
      freeQuota: { remaining: 2000000, total: 2000000 }
    },
    {
      id: "doubao-seedance-1-0-lite-i2v",
      name: "Doubao-Seedance-1.0-lite-i2v",
      modes: ["text2video", "img2video"],
      free: true,
      price: "免费",
      quotaHint: "免费推理额度（未开通模型，需到控制台开通后使用）",
      activated: false,
      freeQuota: { remaining: 2000000, total: 2000000 }
    },
    // Wan 家族：文生/图生走不同 Model ID（-t2v / -i2v），本目录存基名 wan2-1-14b，调用时由 resolveVolcengineModel 按 mode 追加
    {
      id: "wan2-1-14b",
      name: "Wan2.1-14B",
      modes: ["text2video", "img2video"],
      free: true,
      price: "免费",
      quotaHint: "免费推理额度（开通管理页）",
      activated: false,
      freeQuota: { remaining: 2000000, total: 2000000 }
    }
  ]
}

/** 控制台「开通管理→视觉模型」页抓到的免费 Seedance 条目（名 / Model ID / 剩余与总免费额度 / 是否已开通） */
export interface VolcengineScrapedFreeModel {
  name: string
  id?: string
  remaining?: number
  total?: number
  activated?: boolean
}

/** 展示名 → Model ID 固定映射（权威值，覆盖内置目录全部免费模型，含 lite 系列） */
export const VOLCENGINE_FREE_NAME_TO_ID: Record<string, string> = Object.fromEntries(
  volcengineFreeVideoModels().map((m) => [m.name, m.id]),
)

/** 展示名（带点号）→ 规范化 Model ID（小写 + `.`→`-`）；lite 系列名归一化即真实 Model ID，用于固定映射未收录的未知免费模型 */
function normalizeVolcModelId(name: string): string {
  return name.toLowerCase().replace(/\./g, "-")
}

/**
 * 削减模型名里的畸形拼接/重复段：表格行常把同一模型名连写多次（如
 * `wan2-1-14bwan2-1-14bwan2-1-14bwanai`），取最小重复周期去掉冗余重复，残余垃圾段留给后续解析丢弃。
 * 正常名不含相邻自重复时原样返回。
 */
function reduceRepeatedModelName(name: string): string {
  let cur = name || ""
  for (let i = 0; i < 5; i++) {
    const m = cur.match(/^(.+?)\1/)
    if (!m || !m[1]) break
    cur = m[1]
  }
  return cur
}

/**
 * 把实抓/接口的模型名解析到「权威目录」的 Model ID。
 * 三种命中路径，逐一尝试以自动归并重复与截断别名：
 *  - 精确：展示名固定映射；或规范化后恰等于某个目录 id；
 *  - 模糊：畸形拼接经去重归约后，与目录 id 存在包含/前缀关系（如
 *    `doubao-seedance-1-5-pro` 缺 `-251215` 后缀、`doubao-seedance-1-0-pro-fa` 截断 `fast`）→ 归一到唯一 id；
 *  - 未命中目录：规范化干净名作为「新免费模型」占位 id；畸形残留/含中文/超长一律返回 null 拒绝收录，
 *    避免 DOM 残片被当成独立新模型混入列表。
 */
function resolveVolcScrapedId(rawName: string): string | null {
  const raw = (rawName || "").trim()
  if (!raw) return null
  // 1) 展示名固定映射
  const exact = VOLCENGINE_FREE_NAME_TO_ID[raw]
  if (exact) return exact
  const norm = reduceRepeatedModelName(normalizeVolcModelId(raw))
  if (!norm) return null
  // 2) 规范化后恰等于某个目录 id
  for (const m of FREE_CATALOG) if (m.id === norm) return m.id
  // 3) 与目录 id 存在包含/前缀关系，归一到不重复的 id
  const hits = FREE_CATALOG.filter(
    (m) => m.id === norm || m.id.includes(norm) || norm.includes(m.id),
  ).map((m) => m.id)
  if (hits.length === 1) return hits[0]
  if (hits.length > 1) {
    // 多命中（如 `doubao-seedance-1-0-pro` 同时作 …pro-250528 / …pro-fast-251015 前缀）：取短版本，稳定不漂移
    return hits.slice().sort((a, b) => a.length - b.length)[0]
  }
  // 4) 未命中目录：仅收留「干净规范 id」作占位；畸形残留 / 中文 / 超长 / 带非法字符一律拒绝
  if (/[\u4e00-\u9fa5]/.test(norm)) return null
  if (norm.length > 64) return null
  if (!/^[a-z0-9][a-z0-9._-]*[a-z0-9]$/.test(norm)) return null
  return norm
}

/** 内置免费目录（作为爬取失败的权威兜底） */
const FREE_CATALOG: VolcengineFreeVideoModel[] = volcengineFreeVideoModels()

/**
 * 火山方舟「视频生成」模型家族判定（权威层，依据控制台开通管理页的分类，不依赖抓取层的 DOM 前缀）：
 *  - 视频生成家族：Seedance（doubao-seedance-*，如 1.0-pro / 1.5-pro / lite 系列）、Wan（Wan2.1-14B 等）；
 *  - 图像生成家族 Seedream（doubao-seedream-*）、3D 生成家族（Seed3D/Hyper3D/Hitem3D 等）同样带免费推理额度，
 *    但**不是视频模型**，须在权威层排除，以免混入视频调度台的模型下拉。
 * 抓取层只如实上报「有免费额度」的所有模型，是否「视频生成模型」由本函数按家族知识过滤。
 */
export function isVolcengineVideoFamilyName(name: string): boolean {
  const n = (name || "").toLowerCase()
  return n.includes("seedance") || n.includes("wan")
}

/**
 * 「绑定即抓模型」：把控制台实时抓到的免费模型规范化为目录（权威层）。
 * - 收录页面上**所有**「有免费推理额度且属于视频家族」的模型（含 lite、Wan 系列），按页面顺序给出；
 *   （页面同屏混有图像 Seedream、3D Seed3D/Hyper3D/Hitem3D 等免费模型，跑 videoFamily 过滤剔除）
 * - id 优先级：内置固定映射（官方权威值）> 由展示名规范化推导（供未收录未知免费视频模型占位）；
 *   （页面「开通管理」卡片只展示带点号的展示名，无可靠 Model ID，故不再信任页面抓到的 id）
 * - token（剩余/总）与是否已开通由页面实抓回填；
 * - 完全未抓到（无会话/未进开通页/CSP 阻断）时回退内置目录，由 caller 以 [volc-caps] 标记回退。
 */
export function captureVolcengineFreeVideoModels(
  scraped: VolcengineScrapedFreeModel[] | null | undefined,
): { models: VolcengineFreeVideoModel[]; source: "console" | "fallback" } {
  const src = Array.isArray(scraped) ? scraped : []
  const catalog = FREE_CATALOG.map((m) => ({ ...m }))
  if (src.length === 0) {
    return { models: catalog, source: "fallback" }
  }
  // 合并策略：目录（免费视频模型权威全集）+ 实抓模型，按「权威 Model ID」去重。
  // - 抓取只负责如实上报「有免费额度的所有模型」，并可能因虚拟列表/滚动漏掉列表末尾卡片（如 Wan 在最底部）；
  // - 因此以目录为权威骨架（保证 Wan、lite 等已知免费视频模型不因抓取漏卡而丢失），
  //   抓到的实时额度 / 是否已开通优先覆盖对应 id；目录未收录的新免费模型由抓取补充。
  // - 实抓名字先经 resolveVolcScrapedId 归一到目录 id：截断别名（缺版本后缀、fast 截断）与
  //   畸形拼接串（如 wan2-1-14b×3+wanai）都会被折叠到正确条目，杜绝同一模型以残片形式重复出现。
  const byId = new Map<string, VolcengineFreeVideoModel>()
  for (const m of catalog) byId.set(m.id, m)
  for (const s of src) {
    const name = s.name?.trim() || ""
    if (!name) continue
    // 门禁：只收视频家族模型（剔除非视频的图像 Seedream / 3D Seed3D 等空闲免费模型）
    if (!isVolcengineVideoFamilyName(name)) continue
    // 归一化到权威 Model ID；畸形/无效名返回 null → 跳过，不引入重复或垃圾条目
    const id = resolveVolcScrapedId(name)
    if (!id) continue
    // 实抓额度只在是「有限正数」时才覆盖目录默认值；NaN/undefined 会弄脏展示，回退目录默认
    const hasQuota =
      Number.isFinite(s.remaining) && Number.isFinite(s.total) && (s.total as number) > 0
    const existing = byId.get(id)
    if (existing) {
      // 已收录于目录：保留目录权威 id/name/modes，仅覆盖实时额度与开通状态。
      // activated 取「任一来源判为已开通」即开通（只升不降），避免先到的 DOM 误标覆盖接口后续抓到的 true。
      if (hasQuota) existing.freeQuota = { remaining: s.remaining as number, total: s.total as number }
      if (s.activated === true) existing.activated = true
      continue
    }
    // 目录未收录的新免费模型：以规范化干净 id 占位
    byId.set(id, {
      id,
      name,
      modes: ["text2video", "img2video"],
      free: true,
      price: "免费",
      quotaHint: "免费推理额度（开通管理页）",
      freeQuota: hasQuota ? { remaining: s.remaining as number, total: s.total as number } : undefined,
      activated: s.activated === true
    })
  }
  const models = Array.from(byId.values())
  if (models.length === 0) {
    return { models: catalog, source: "fallback" }
  }
  return { models, source: "console" }
}

/**
 * 火山方舟 Model ID 的 Mode 解析：Seedance 家族单 Model ID 同时覆盖文生/图生；
 * Wan 家族（wan2-1-14b 等）文生/图生走不同 Model ID（-t2v / -i2v），按 mode 追加后缀。
 */
export function resolveVolcengineModel(model: string, mode: "text2video" | "img2video"): string {
  const m = (model || "").trim()
  if (/^wan\b/i.test(m) || /^wan[-.\d]/i.test(m)) {
    return mode === "img2video" ? `${m}-i2v` : `${m}-t2v`
  }
  return m
}

export interface VolcengineGenerateOptions {
  mode: "text2video" | "img2video"
  model: string
  prompt?: string
  /** 单图：图生视频首帧（公网 https URL）；多图按需透传 */
  images?: string[]
  /** 视频时长（秒，整数）；免费模型固定 6s 时由调用方消化 */
  durationSec?: number
  /** 是否生成有声视频 */
  audio?: "on" | "off"
  ratio?: string
  resolution?: string
}

export interface VolcengineGenerateResult {
  ok: boolean
  videoUrl?: string
  coverImageUrl?: string
  traceId?: string
  model: string
  error?: string
}

/**
 * 火山方舟（数据面）视频生成：提交任务 → 轮询 → 解析视频 URL。
 *   提交 POST {base}/contents/generations/tasks，Bearer <ARK_API_KEY> 鉴权，返回 {id}。
 *   轮询 GET  {base}/contents/generations/tasks/{id}，status ∈ queued/running/cancelled/succeeded/failed/expired；
 *   成功终态视频地址在 content[].video_url，封面在 content[].poster_url。
 * onProgress 用于桌面调度台实时推送过程提示。
 */
export async function volcengineGenerateWithKey(
  apiKey: string,
  opts: VolcengineGenerateOptions,
  onProgress?: (message: string) => void,
): Promise<VolcengineGenerateResult> {
  const key = (apiKey ?? "").trim()
  if (!key) return { ok: false, model: opts.model, error: "火山方舟 API Key 缺失" }
  const content: Array<Record<string, unknown>> = [
    { type: "text", text: opts.prompt?.trim() || (opts.mode === "img2video" ? "让图片动起来" : "生成一段视频") },
  ]
  const imgs = (opts.images ?? []).filter((u) => /^https?:\/\//i.test(String(u).trim()))
  if (opts.mode === "img2video" && imgs.length > 0) {
    for (const url of imgs) {
      content.push({ type: "image_url", image_url: { url }, role: "reference_image" })
    }
  } else if (opts.mode === "img2video") {
    return { ok: false, model: opts.model, error: "火山图生视频需要至少上传 1 张首帧图（需公网 https 地址）" }
  }

  // Wan 家族（wan2-1-14b 等）文生/图生走不同 Model ID，按 mode 解析；Seedance 单 ID 通用
  const bodyModel = resolveVolcengineModel(opts.model, opts.mode)
  const body: Record<string, unknown> = {
    model: bodyModel,
    content,
    generate_audio: opts.audio !== "off",
    watermark: false,
    output_format: "mp4",
  }
  const dur = Number(opts.durationSec)
  if (Number.isFinite(dur) && dur > 0) body["duration"] = dur
  if (opts.ratio) body["ratio"] = opts.ratio
  if (opts.resolution) body["resolution"] = opts.resolution

  const genLog = (msg: string, extra?: unknown): void => {
    console.log(`[volc-gen][${new Date().toISOString()}] ${msg}`, extra === undefined ? "" : JSON.stringify(extra))
  }

  try {
    onProgress?.(`正在提交到火山方舟（${opts.model}）…`)
    const submit = await fetch(`${VOLC_BASE_URL}/contents/generations/tasks`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20000),
    })
    const submitRaw: unknown = await submit.json().catch(() => null)
    const submitData = (submitRaw && typeof submitRaw === "object" ? submitRaw : {}) as Record<string, unknown>
    if (!submit.ok) {
      const errObj = (submitData["error"] ?? {}) as Record<string, unknown> | null
      const msg = typeof errObj?.message === "string" ? errObj.message : `HTTP ${submit.status}`
      genLog(`提交失败 status=${submit.status} msg=${msg}`)
      return { ok: false, model: opts.model, error: `火山方舟提交失败: ${msg}${submit.status === 429 ? "（限流，请稍后再试）" : ""}` }
    }
    const rawTaskId = submitData["id"]
    const taskId = typeof rawTaskId === "string" ? rawTaskId : undefined
    if (!taskId) {
      genLog("提交成功但响应缺少 id", submitData)
      return { ok: false, model: opts.model, error: "火山方舟提交响应缺少任务 id" }
    }

    onProgress?.("提交成功，正在生成视频…")
    const startedAt = Date.now()
    const INTERVAL_MS = 5000
    const MAX_POLLS = 90 // 约 7.5 分钟上限
    let polls = 0
    for (;;) {
      await new Promise((r) => setTimeout(r, INTERVAL_MS))
      polls++
      let data: Record<string, unknown>
      try {
        const res = await fetch(`${VOLC_BASE_URL}/contents/generations/tasks/${taskId}`, {
          method: "GET",
          headers: { Authorization: `Bearer ${key}` },
          signal: AbortSignal.timeout(15000),
        })
        const rawPoll: unknown = await res.json().catch(() => null)
        data = (rawPoll && typeof rawPoll === "object" ? rawPoll : {}) as Record<string, unknown>
      } catch {
        if (polls >= MAX_POLLS) {
          return { ok: false, model: opts.model, error: `火山方舟任务轮询超时（约 ${Math.round((Date.now() - startedAt) / 1000)} 秒），可能仍在生成或已失败` }
        }
        continue
      }
      const status = String(data["status"] ?? "UNKNOWN")
      if (status === "succeeded" || status === "success") {
        const items = Array.isArray(data["content"]) ? (data["content"] as Array<Record<string, unknown>>) : []
        const video = items.find((it) => typeof it["video_url"] === "string")
        const poster = items.find((it) => typeof it["poster_url"] === "string")
        if (!video) {
          genLog("终态 succeeded 但 content 缺少 video_url", data)
          return { ok: false, model: opts.model, error: "火山方舟任务 SUCCESS 但缺少视频地址" }
        }
        genLog(`生成成功 video_url=${video["video_url"]} polls=${polls}`)
        return {
          ok: true,
          videoUrl: String(video["video_url"]),
          coverImageUrl: typeof poster?.["poster_url"] === "string" ? String(poster["poster_url"]) : undefined,
          traceId: taskId,
          model: opts.model,
        }
      }
      if (status === "failed" || status === "cancelled" || status === "expired") {
        const reason = data["error"] ? String(data["error"]) : status
        genLog(`任务终态非成功: ${status}`, data)
        return { ok: false, model: opts.model, error: `火山方舟任务${status}${reason === status ? "" : `：${reason}`}` }
      }
      if (polls >= MAX_POLLS) {
        return { ok: false, model: opts.model, error: `火山方舟任务轮询超时（约 ${Math.round((Date.now() - startedAt) / 1000)} 秒）` }
      }
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    genLog(`未捕获异常: ${msg}`)
    return { ok: false, model: opts.model, error: msg }
  }
}