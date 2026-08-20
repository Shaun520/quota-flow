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
 * 支持有声视频（generate_audio）的火山视频模型（官方仅标注有声能力的模型可下发）。
 * 1.0 Pro / Fast / Lite 不支持有声；当前免费目录与后续可能的 2.0 系列都在此登记。
 */
export const VOLC_AUDIO_MODELS = new Set([
  "doubao-seedance-1-5-pro-251215",
  "doubao-seedance-2-0-mini-260615",
])

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
  /**
   * 【每账号/平台】运行时由火山真实响应判定的「不可用」标记：
   * - 'decommissioned'：平台已下架/停用，无法生成；
   * - 'no_endpoint'：该账号无可用接入点或接入失败，无法生成。
   * 定义后随账号负载 models[] 持久化，生成成功自动清除（自愈）。
   */
  unavailable?: 'decommissioned' | 'no_endpoint'
}

/**
 * 火山平台侧明确下架的权威 Model ID 清单（兜底）。
 * 不可用标记主要靠运行时真实响应驱动（volcGenUnavailableKind），此处仅用于平台明确下架时的预置，
 * 需等有确凿下架的 Model ID 再补充，避免误标可用模型。
 */
export const VOLC_DECOMMISSIONED_MODELS: string[] = []

export function volcengineFreeVideoModels(): VolcengineFreeVideoModel[] {
  // 本目录只声明免费视频模型「元数据」（id/名称/能力/开通状态），不写死任何额度（total/remaining）。
  // 额度是账号级动态数据，一律由实测接口 ListModelTokenLimit 抓取后写入 freeQuota（见 capture*），
  // 抓不到即「额度未知」：前端显示 —、生成前保守拦截。切勿在目录里填静态余额，否则会随平台变化失真并放行误扣。
  const list: VolcengineFreeVideoModel[] = [
    { id: "doubao-seedance-1-0-pro-250528", name: "Doubao-Seedance-1.0-pro", modes: ["text2video", "img2video"], free: true, price: "免费", quotaHint: "免费推理额度（开通管理页）", activated: true },
    { id: "doubao-seedance-1-5-pro-251215", name: "Doubao-Seedance-1.5-pro", modes: ["text2video", "img2video"], free: true, price: "免费", quotaHint: "免费推理额度（开通管理页）", activated: true },
    { id: "doubao-seedance-1-0-pro-fast-251015", name: "Doubao-Seedance-1.0-pro-fast", modes: ["text2video", "img2video"], free: true, price: "免费", quotaHint: "免费推理额度（未开通模型，需到控制台开通后使用）", activated: false },
    { id: "doubao-seedance-1-0-lite-t2v-250428", name: "Doubao-Seedance-1.0-lite-t2v", modes: ["text2video", "img2video"], free: true, price: "免费", quotaHint: "免费推理额度（未开通模型，需到控制台开通后使用）", activated: false },
    { id: "doubao-seedance-1-0-lite-i2v-250428", name: "Doubao-Seedance-1.0-lite-i2v", modes: ["text2video", "img2video"], free: true, price: "免费", quotaHint: "免费推理额度（未开通模型，需到控制台开通后使用）", activated: false },
    // Wan 家族：文生/图生走不同 Model ID，真实端点带日期版本（wan2-1-14b-t2v-250225 / -i2v-250225），存基名 wan2-1-14b，由 resolveVolcengineModel 按 mode 拼接
    { id: "wan2-1-14b", name: "Wan2.1-14B", modes: ["text2video", "img2video"], free: true, price: "免费", quotaHint: "免费推理额度（开通管理页）", activated: false }
  ]
  return list.map((m) =>
    VOLC_DECOMMISSIONED_MODELS.includes(m.id) ? { ...m, unavailable: 'decommissioned' as const } : m
  )
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
 * 把「权威接口 ListModelTokenLimit 返回的 FoundationModelName」归一到目录 Model ID 集合。
 * 该接口只返回有免费额度的已开通模型；对「已开通但额度耗尽」等不在列表的模型不返回。
 * 上层用它作为「额度可信集合」：只有命中该集合的目录模型的 freeQuota 才是接口权威值，
 * 未命中模型的 freeQuota 一律不可信（DOM/旧缓存值会误导展示），应置空并按「— 未知」保守展示。
 */
export function volcengineAuthoritativeIds(authorizedTokenNames: Array<string | undefined>): Set<string> {
  const set = new Set<string>()
  for (const raw of authorizedTokenNames || []) {
    const id = resolveVolcScrapedId((raw || "").trim())
    if (id) set.add(id)
  }
  return set
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
/**
 * @param opts.markAbsentInactivated 仅当上层判定抓取已覆盖全量已开通模型（分页耗尽 + 模型列表接口已见）时置 true，
 * 把「未被抓到的目录免费视频模型」强制置为未开通(false)，覆盖目录默认的 activated:true。
 * 未开通模型因无免费额度文案不会被收录进 src，若不覆盖将沿用目录默认值导致误显示「已开通」。
 */
export function captureVolcengineFreeVideoModels(
  scraped: VolcengineScrapedFreeModel[] | null | undefined,
  carryUnavailable?: VolcengineFreeVideoModel[],
  opts?: { markAbsentInactivated?: boolean },
): { models: VolcengineFreeVideoModel[]; source: "console" | "fallback" } {
  const src = Array.isArray(scraped) ? scraped : []
  const catalog = FREE_CATALOG.map((m) => ({ ...m }))
  // 预置平台明确下架标记：命中清单的模型直接标 decommissioned（目录/catalog 已含该标记，这里对来自目录的项再兜底一遍）
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
  const seenIds = new Set<string>()
  for (const s of src) {
    const name = s.name?.trim() || ""
    if (!name) continue
    // 门禁：只收视频家族模型（剔除非视频的图像 Seedream / 3D Seed3D 等空闲免费模型）
    if (!isVolcengineVideoFamilyName(name)) continue
    // 归一化到权威 Model ID；畸形/无效名返回 null → 跳过，不引入重复或垃圾条目
    const id = resolveVolcScrapedId(name)
    if (!id) continue
    seenIds.add(id)
    // 实抓额度只在是「有限正数」时才覆盖目录默认值；NaN/undefined 会弄脏展示，回退目录默认
    const hasQuota =
      Number.isFinite(s.remaining) && Number.isFinite(s.total) && (s.total as number) > 0
    const existing = byId.get(id)
    if (existing) {
      // 已收录于目录：保留目录权威 id/name/modes，仅覆盖实时额度与开通状态。
    // 以控制台实时抓取为准（双向）：开通则升为 true，明确「未开通」则降为 false。
    // 同一快照内已开通模型必由 ListModelTokenLimit 接口置 activated:true（见注入脚本 upsert 逻辑），
    // 故「未开通(false)」只会来自确实未开通的模型，不会误覆盖接口后续的 true。
    if (hasQuota) existing.freeQuota = { remaining: s.remaining as number, total: s.total as number }
    if (s.activated === true) existing.activated = true
    else if (s.activated === false) existing.activated = false
    continue
    }
    // 目录未收录的新免费模型：仅在「带真实额度」时才建占位。新 UI 表格行不再显示「剩/共 token」，
    // DOM 只上报名称+开通状态、无额度（hasQuota=false）；这类条目只能用于纠正目录已有模型的开通状态，
    // 不能挤进免费列表充当新模型（否则无免费额度的 2.x 系列会被当成免费视频模型混入调度台）。
    if (!hasQuota) continue
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
  // 权威覆盖「未开通」：仅在抓取已覆盖全量已开通模型（分页耗尽 + 模型列表接口已见，由上层判定）时启用。
  // 只对「目录默认 activated:false」的模型执行覆盖（fast/lite/wan），把它们保持为 未开通；
  // 绝不覆盖目录默认 activated:true 的平台默认可开免费模型（如 seedance-1.0-pro）——
  // 接口 ListModelTokenLimit 对「已开通但额度耗尽」的模型不返回，与「未开通」无法靠接口区分，
  // 若也强制标 false 会诱发「已开通却显示待开通」的间歇性误判。这些模型真实开通与否
  // 由实抓 DOM 状态列覆盖：s.activated 显式 true/false 已在上面按实抓覆盖 existing.activated。
  if (opts?.markAbsentInactivated) {
    for (const m of catalog) {
      if (!seenIds.has(m.id) && m.activated === false) (m as VolcengineFreeVideoModel).activated = false
    }
  }
  // 携带上层（历史账号负载 payload.models）的「不可用」标记按 id 覆盖，保证标签跨「查看模型」重建目录时不回退
  if (Array.isArray(carryUnavailable) && carryUnavailable.length > 0) {
    const carryMap = new Map<string, 'decommissioned' | 'no_endpoint'>()
    for (const c of carryUnavailable) {
      if (c?.id && (c.unavailable === 'decommissioned' || c.unavailable === 'no_endpoint')) carryMap.set(c.id, c.unavailable)
    }
    for (const it of byId.values()) {
      const kind = carryMap.get(it.id)
      if (kind) it.unavailable = kind
    }
  }
  const models = Array.from(byId.values())
  if (models.length === 0) {
    return { models: catalog, source: "fallback" }
  }
  return { models, source: "console" }
}

/**
 * 火山方舟 Model ID 的 Mode 解析：Seedance 家族单 Model ID 同时覆盖文生/图生；
 * Wan2.1 家族（wan2-1-14b 等）文生/图生走不同 Model ID 且真实端点带日期版本（如
 * wan2-1-14b-t2v-250225 / wan2-1-14b-i2v-250225），按 mode 拼出带版本的端点；
 * lite 系列（doubao-seedance-1-0-lite，官方 Model ID 带 -250428 日期后缀）同样是 t2v/i2v 两个独立 ID，
 * 按 mode 归一：剥离已有的 -(t2v|i2v)-\d{6}$ 后缀后重建，确保用户切换文生/图生时模型与模式一致。
 */
export function resolveVolcengineModel(model: string, mode: "text2video" | "img2video"): string {
  const m = (model || "").trim()
  if (/^wan\b/i.test(m) || /^wan[-.\d]/i.test(m)) {
    // Wan2.1 真实端点带日期版本（已核实 i2v 为 wan2-1-14b-i2v-250225），文生/图生对应 t2v/i2v
    return mode === "img2video" ? `${m}-i2v-250225` : `${m}-t2v-250225`
  }
  if (/doubao-seedance-1-0-lite/i.test(m)) {
    // 已有的模式后缀与日期后缀剥掉，按 mode 重建为 -t2v-250428 / -i2v-250428
    const base = m.replace(/-(t2v|i2v)-(?:\d{6})?$/i, "")
    return mode === "img2video" ? `${base}-i2v-250428` : `${base}-t2v-250428`
  }
  return m
}

/**
 * 把火山提交/查询失败的响应码与文案归类为「模型不可用」标记：
 * - 'decommissioned'：平台下架/停用类（关键词：下架/下线/decommission/discontinued/offline/end of service/not for sale）
 * - 'no_endpoint'：无接入点/未开通/不存在/无权访问（InvalidEndpointOrModel.NotFound、ModelNotOpen 及「不存在/not found/no access」等）
 * - undefined：其它错误，不标记为不可用（可能只是限流/参数等瞬时问题）
 */
export function volcGenUnavailableKind(code?: string, msg?: string): 'decommissioned' | 'no_endpoint' | undefined {
  const codeText = String(code ?? "")
  const msgText = String(msg ?? "")
  const text = `${codeText} ${msgText}`
  if (/下架|下线|decommission|discontinued|offline|end of service|not for sale/i.test(text)) {
    return 'decommissioned'
  }
  if (
    /not found|does not exist|do not have access|no access|not accessible|not activated|not enabled|invalidendpointormodel|modelnotopen|不存在|无权访问|未开通|未激活/i.test(text)
  ) {
    return 'no_endpoint'
  }
  return undefined
}

/**
 * 火山方舟所选模型的「能否生成」状态（调取账号加密负载里绑定时抓到的模型目录）：
 * 用于调度前预检/多账号优选。账本对火山不做原子扣减，故仅作「能否生成」判据，不代表扣减额度。
 * - known：负载是否含所选模型信息（旧格式/抓取不全 → false，由上层「未知即放行」）
 * - activated：activated===true/false；未知 null
 * - remaining：freeQuota?.remaining；未知 null
 * - unavailable：不可用标记（decommissioned 平台下架 / no_endpoint 无接入点）；未知 null
 */
export interface VolcengineModelFreeStatus {
  known: boolean
  activated: boolean | null
  remaining: number | null
  unavailable?: 'decommissioned' | 'no_endpoint' | null
}

export function volcengineModelFreeStatus(plain: string, model: string): VolcengineModelFreeStatus {
  const { models } = decodeVolcenginePayload(plain)
  const match = Array.isArray(models) ? models.find((m) => m?.id === model) : undefined
  // 平台明确下架清单兜底；账号负载里的标记优先（运行时写入），清单命中同样置 decommissioned
  const decommUnavailable = VOLC_DECOMMISSIONED_MODELS.includes(model) ? ('decommissioned' as const) : null
  const unavailable = match?.unavailable === 'decommissioned' || match?.unavailable === 'no_endpoint'
    ? match.unavailable
    : decommUnavailable
  const remaining = typeof match?.freeQuota?.remaining === "number" ? match.freeQuota.remaining : null
  return {
    known: !!match,
    activated: match ? (match.activated === true ? true : match.activated === false ? false : null) : null,
    remaining,
    unavailable
  }
}

/** 火山视频模型单次生成的预估 token 耗量（按秒估算，取保守上修为防误扣）：seedance-1.0-pro 实测 10s≈20.6w，按 2.5w/s 上修 */
export const VOLC_GEN_TOKENS_PER_SEC = 25_000
/** 未知时长时按 10s 预估（对应默认时长档） */
export const VOLC_GEN_DEFAULT_DURATION = 10
export function volcGenTokenEstimate(durationSec?: number): number {
  const sec = Number.isFinite(durationSec) && (durationSec as number) > 0 ? (durationSec as number) : VOLC_GEN_DEFAULT_DURATION
  return sec * VOLC_GEN_TOKENS_PER_SEC
}

/** 火山提交前防误扣拦截：额度不足 / 未开通 / 额度不可确认 / 无接入点 / 已下架 一律拦截 */
export interface VolcengineGenBlocker { ok: boolean; reason?: string }
export function volcengineGenBlocker(plain: string, model: string, estimateTokens?: number): VolcengineGenBlocker {
  const st = volcengineModelFreeStatus(plain, model)
  if (st.unavailable === 'decommissioned') return { ok: false, reason: `模型「${model}」已被火山平台下架/停用，无法生成` }
  if (st.unavailable === 'no_endpoint') return { ok: false, reason: `该账号「${model}」无可用接入点（未在开通管理页开通或调用失败），无法生成。请先在火山方舟开通管理页开通该模型或更换模型` }
  if (st.activated === false) return { ok: false, reason: `模型「${model}」在该账号未开通，请先在开通管理页开通后再生成` }
  if (st.remaining == null) return { ok: false, reason: `该账号「${model}」免费额度信息不可确认（可能未抓取或登录态失效）。为避免误扣账号余额已拦截，请先在厂商页「查看模型」刷新额度后重试` }
  const need = estimateTokens ?? volcGenTokenEstimate()
  if (st.remaining < need) return { ok: false, reason: `该账号「${model}」免费额度剩余 ${st.remaining.toLocaleString()} token，不足以完成本次生成（约需 ${need.toLocaleString()} token）。继续将扣取账号余额，已为您拦截。请开通/充值该模型或更换模型` }
  return { ok: true }
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
  /** 提交失败且火山判定该模型「无接入点 / 已下架」时返回，供上层持久化标记并拦截后续生成 */
  unavailable?: 'decommissioned' | 'no_endpoint'
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
  // 图片 role 必须按模型家族区分：Seedance 图生视频用 first_frame/last_frame（首帧/首尾帧），
  // 否则 ARK 会把 reference_image 当 task_type=r2v 而 seedance 不支持直接拒绝；Wan 系才用 reference_image。
  const isSeedance = /^doubao-seedance/i.test((opts.model || "").trim())
  if (opts.mode === "img2video" && imgs.length > 0) {
    imgs.forEach((url, idx) => {
      const role = isSeedance ? (idx === 0 ? "first_frame" : "last_frame") : "reference_image"
      content.push({ type: "image_url", image_url: { url }, role })
    })
  } else if (opts.mode === "img2video") {
    return { ok: false, model: opts.model, error: "火山图生视频需要至少上传 1 张首帧图（需公网 https 地址）" }
  }

  // Wan 家族（wan2-1-14b 等）文生/图生走不同 Model ID，按 mode 解析；Seedance 单 ID 通用
  const bodyModel = resolveVolcengineModel(opts.model, opts.mode)
  const body: Record<string, unknown> = {
    model: bodyModel,
    content,
    watermark: false,
    output_format: "mp4",
  }
  // 有声（generate_audio）仅官方支持有声的模型可下发；无声模型（1.0 Pro/Fast/Lite）不发以免被拒
  if (VOLC_AUDIO_MODELS.has(bodyModel)) body["generate_audio"] = opts.audio !== "off"
  const dur = Number(opts.durationSec)
  if (Number.isFinite(dur) && dur > 0) body["duration"] = dur
  if (opts.ratio) body["ratio"] = opts.ratio
  // 分辨率不能作为顶层参数传给火山（会报 InvalidParameter「resolution ... not valid」），需按模型家族写成文本控制令牌：
  //   Seedance 系：--rs <720p|1080p>；Wan 系：--resolution <720p|1080p>。追加到首条文本提示词末尾。
  if (opts.resolution) {
    const resVal = `${opts.resolution}p`
    const textItem = content.find((c) => c.type === "text") as { type: string; text?: string } | undefined
    if (textItem) {
      const token = bodyModel.startsWith("wan") ? `--resolution ${resVal}` : `--rs ${resVal}`
      textItem.text = `${textItem.text ?? ""} ${token}`.trim()
    }
  }

  const genLog = (msg: string, extra?: unknown): void => {
    console.log(`[volc-gen][${new Date().toISOString()}] ${msg}`, extra === undefined ? "" : JSON.stringify(extra))
  }

  try {
    onProgress?.(`正在提交到火山方舟（${opts.model}）…`)
    // 明确日志当前实际发出的 Model ID 与端点区域：便于核对「模型名/地域」是否与账号开通的一致
    genLog(`提交 model=${bodyModel} url=${VOLC_BASE_URL}/contents/generations/tasks`, {
      mode: opts.mode,
      imgs: imgs.length,
    })
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
      const code = typeof errObj?.code === "string" ? errObj.code : ""
      const msg = typeof errObj?.message === "string" ? errObj.message : `HTTP ${submit.status}`
      genLog(`提交失败 status=${submit.status} code=${code} msg=${msg}`)
      // 判定该模型是否因「无接入点 / 平台下架」失败：是则一并返回，供上层持久化标记并拦截后续生成
      const unavail = volcGenUnavailableKind(code, msg)
      const unavailableSpread = unavail ? { unavailable: unavail } : {}
      // 方舟官方错误码区分两类，给出精准提示而非笼统报「未开通」：
      //   ModelNotOpen                     = 该账号确实没开通模型；请在开通管理页开通
      //   InvalidEndpointOrModel.NotFound  = 模型/端点不存在或无权访问；多为「调用地域≠开通地域」或「API Key 账号≠开通模型的主账号」
      if (code === "ModelNotOpen") {
        return { ok: false, model: opts.model, error: `「${opts.model}」当前账号未开通该模型服务，请在开通管理页开通后再试`, ...unavailableSpread }
      }
      if (code === "InvalidEndpointOrModel.NotFound") {
        return {
          ok: false,
          model: opts.model,
          error: `「${opts.model}」模型/端点不存在或无权访问（多为开通地域不是 cn-beijing，或 API Key 与开通模型的不是同一主账号）。请核对开通管理页该模型的地域与账号`,
          ...unavailableSpread,
        }
      }
      const notOpened =
        /does not exist|do not have access|no access|not accessible|model not (found|activated|enabled)|not enabled|invalid model|未开通|无访问权限/i.test(
          msg
        )
      if (notOpened) {
        const modeLabel = opts.mode === "img2video" ? "图生" : "文生"
        return {
          ok: false,
          model: opts.model,
          error: `「${opts.model}」的${modeLabel}模型服务未开通或无访问权限，请到开通管理页确认该模型已开通后再试`,
          ...unavailableSpread,
        }
      }
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
        // 响应里 content 既可能是「对象」{video_url, poster_url}（seedance 用），也可能是旧版「数组」[{…}]：统一归一成数组再取
        const contentRaw = data["content"]
        const cList: Array<unknown> = Array.isArray(contentRaw)
          ? (contentRaw as unknown[])
          : contentRaw && typeof contentRaw === "object"
            ? [contentRaw]
            : []
        const safe = (it: unknown): Record<string, unknown> => (it && typeof it === "object" ? (it as Record<string, unknown>) : {})
        const video = cList.find((it) => typeof safe(it)["video_url"] === "string")
        const poster = cList.find((it) => typeof safe(it)["poster_url"] === "string")
        if (!video) {
          genLog("终态 succeeded 但 content 缺少 video_url", data)
          return { ok: false, model: opts.model, error: "火山方舟任务 SUCCESS 但缺少视频地址" }
        }
        genLog(`生成成功 video_url=${safe(video)["video_url"]} polls=${polls}`)
        return {
          ok: true,
          videoUrl: String(safe(video)["video_url"]),
          coverImageUrl: poster ? String(safe(poster)["poster_url"]) : undefined,
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