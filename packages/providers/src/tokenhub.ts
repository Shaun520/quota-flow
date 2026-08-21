// 腾讯云 TokenHub 大模型服务平台 API Key 型厂商适配器
//
// 本轮实现「绑定 + 去重 + 模型额度查看 + 调度台视频生成」所需能力。
// 数据面（已实测，官方调用指南 1823/135716，2026-08-21）：
//   - 四个视频模型共用同一对 OpenAI 兼容端点：
//       提交  POST https://tokenhub.tencentmaas.com/v1/api/video/submit
//       查询  POST https://tokenhub.tencentmaas.com/v1/api/video/query
//     `Authorization: Bearer <TokenHub API Key>` 鉴权，参数一律小写下划线。
//   - 四模型 body 差异仅在字段（HY 传 prompt；YT-2.0/HumanActor/FX 传 image:{url}/模板）。
// 免费额度实测（2026-08-21，控制台「启用管理 → 视觉模型」DescribeModelEndpointList）：
//   免费额度是「每模型独立」的（非 Uin 级共享），四视频模型各有 50 加入口免费积分，
//   字段来自响应 ModelEndpointSet[].ChargeDetail(JSON 字符串).FreeQuota{TotalQuota,UsedQuota,UsagePercent,ExpireTime}。

import { createHash } from "node:crypto";

export const TKH_BASE_URL = "https://tokenhub.tencentmaas.com";
/** 启用管理页（含免费生视频包/剩余积分的概览） */
export const TKH_CONSOLE_OPEN_URL = "https://console.cloud.tencent.com/tokenhub/open-management";
/** API Key 管理页（绑定「获取 API Key」） */
export const TKH_CONSOLE_APIKEY_URL = "https://console.cloud.tencent.com/tokenhub/apikey";
/** TokenHub 控制台持久化分区 */
export const TKH_CONSOLE_PARTITION = "persist:qf-tokenhub-console";

/** 数据面统一端点 */
export const TKH_VIDEO_SUBMIT_URL = `${TKH_BASE_URL}/v1/api/video/submit`;
export const TKH_VIDEO_QUERY_URL = `${TKH_BASE_URL}/v1/api/video/query`;

/** 单个模型免费额度（来自控制台 DescribeModelEndpointList 响应的 ChargeDetail.FreeQuota） */
export interface TokenhubModelQuota {
  /** 免费额度总数（积分/次） */
  total: number
  /** 已用额度 */
  used: number
  /** 剩余额度 = total - used */
  remaining: number
  /** 用量百分比 0-100 */
  percent: number
  /** 到期时间（ISO，控制台返回 UTC） */
  expiresAt?: string | null
  /** 已过期 */
  expired?: boolean
}

/**
 * 解析 DescribeModelEndpointList 的响应文本，抽出「免费视频模型 → 每模型免费额度」。
 * 实测结构（2026-08-21，服务端固定）：{
 *   code:0, data:{ code:0, cgwerrorCode:0, data:{ Response:{ ModelEndpointSet:[{ ModelId, ChargeType:'FREE',
 *     ChargeDetail:'{"FreeQuota":{"TotalQuota":50,"UsedQuota":0,"UsagePercent":0,"ExpireTime":"..."}}' }] } } }
 * }
 * 仅保留 ChargeType=FREE 且已领取(FreeTrialClaimed)且有 FreeQuota 的模型；ChargeDetail 是字符串，需二次 parse。
 */
export function parseTokenhubDescribeResponse(respText: string): Array<{ model: string; quota: TokenhubModelQuota }> {
  const out: Array<{ model: string; quota: TokenhubModelQuota }> = []
  if (!respText) return out
  try {
    const root = JSON.parse(respText)
    const set =
      root?.data?.data?.data?.Response?.ModelEndpointSet ??
      root?.data?.data?.Response?.ModelEndpointSet ??
      []
    if (!Array.isArray(set)) return out
    const now = Date.now()
    for (const ep of set) {
      const modelId = typeof ep?.ModelId === 'string' ? ep.ModelId : null
      if (!modelId) continue
      if (ep?.ChargeType !== 'FREE') continue
      if (ep?.FreeTrialClaimed !== true) continue
      let fq: { TotalQuota?: number; UsedQuota?: number; UsagePercent?: number; ExpireTime?: string } | null = null
      const cd = ep?.ChargeDetail
      if (typeof cd === 'string') {
        try {
          fq = JSON.parse(cd)?.FreeQuota ?? null
        } catch {}
      } else if (cd && typeof cd === 'object') {
        fq = cd?.FreeQuota ?? null
      }
      if (!fq) continue
      const total = typeof fq.TotalQuota === 'number' ? fq.TotalQuota : NaN
      const used = typeof fq.UsedQuota === 'number' ? fq.UsedQuota : NaN
      const percent = typeof fq.UsagePercent === 'number' ? fq.UsagePercent : NaN
      if (!Number.isFinite(total) || !Number.isFinite(used)) continue
      const expIso = typeof fq.ExpireTime === 'string' && fq.ExpireTime ? fq.ExpireTime : null
      const expired = expIso ? now > new Date(expIso).getTime() : undefined
      out.push({
        model: modelId,
        quota: {
          total,
          used,
          remaining: Math.max(0, total - used),
          percent: Number.isFinite(percent) ? percent : used === 0 ? 0 : Math.round((used / total) * 100),
          expiresAt: expIso,
          expired
        }
      })
    }
  } catch {
    return out
  }
  return out
}

/**
 * 把实抓的每模型额度挂到目录模型上（与火山 volcengine 的 models[].freeQuota 同构），
 * 配额源缺失的模型保持 freeQuota 为空 → 上层按「额度未知」展示 ——/未知。
 */
export function attachTokenhubFreeQuota<T extends { id: string }>(
  models: T[],
  quotaByModel: Record<string, TokenhubModelQuota> | null | undefined,
): Array<T & { freeQuota?: TokenhubModelQuota }> {
  return (models ?? []).map((m) => {
    const q = quotaByModel?.[m.id]
    return q ? { ...m, freeQuota: q } : { ...m }
  })
}

/** 与智谱/火山一致的旧额度结构说明（历史保留；实际已改为每模型独立额度，见 TokenhubModelQuota） */
export interface TokenhubQuota {
  available: boolean
  /** 积分总数 */
  total: number
  /** 剩余积分 */
  remaining: number
  expiresAt?: string | null
  packageName?: string | null
  expired?: boolean
  uin?: unknown
}

/** TokenHub 控制台登录 cookie（进入官网时需跨重启重注入的会话标识，如 uin/skey/token 等） */
export interface TokenhubStoredCookie {
  name: string
  value: string
  domain?: string
  path?: string
  httpOnly?: boolean
  secure?: boolean
  expires?: number
}

/**
 * 解腾讯云 TokenHub 加密负载：
 * 新版：{ v:1; apiKey: string; uin?: string|null; models?: TokenhubFreeVideoModel[]; points?: {remaining?:number; total?:number}; cookies? }
 * 旧版：纯 API Key 字符串（非 `{` 开头）
 */
export function decodeTokenhubPayload(decrypted: string): {
  apiKey: string
  uin?: string | null
  models?: TokenhubFreeVideoModel[]
  points?: { remaining?: number; total?: number }
  cookies?: TokenhubStoredCookie[]
} {
  const trimmed = (decrypted ?? "").trim()
  if (!trimmed.startsWith("{")) return { apiKey: trimmed }
  try {
    const parsed = JSON.parse(trimmed) as {
      v?: number
      apiKey?: string
      uin?: string | null
      models?: TokenhubFreeVideoModel[]
      points?: { remaining?: number; total?: number }
      cookies?: TokenhubStoredCookie[]
    }
    const apiKey = parsed.apiKey?.trim() ?? ""
    let uin = parsed.uin ?? null
    if (typeof uin === "string") {
      uin = uin.trim() || null
    } else {
      uin = null
    }
    const models = Array.isArray(parsed.models) ? parsed.models.filter((m) => m && typeof m.id === "string") : undefined
    const points =
      parsed.points && (typeof parsed.points.remaining === "number" || typeof parsed.points.total === "number")
        ? parsed.points
        : undefined
    const cookies = Array.isArray(parsed.cookies)
      ? parsed.cookies.filter((c) => c && typeof c.name === "string" && typeof c.value === "string")
      : undefined
    return { apiKey, uin, models, points, cookies }
  } catch {
    return { apiKey: trimmed }
  }
}

function fingerprintFor(providerId: string, raw: string): string {
  const norm = raw.trim()
  return createHash("sha256")
    .update(`${providerId}|${norm}`)
    .digest("hex")
}

/**
 * TokenHub 账号级指纹：优先用控制台会话解析出的主账号标识 uin（同一 Uin 下多 API Key 共享免费积分，正确去重维度）。
 * uin 为空（未捕获会话 / 未抓到账号接口）时回退按 API Key 明文哈希。
 * payload 为「加密前明文」，可能是 {v:1,apiKey,uin,models,points} 或纯 API Key。
 */
export async function tokenhubAccountFingerprint(payload: string): Promise<string | null> {
  const { apiKey, uin } = decodeTokenhubPayload(payload)
  if (!apiKey) return null
  if (uin) return fingerprintFor("tokenhub", "tkh-account:" + uin)
  return fingerprintFor("tokenhub", apiKey)
}

/**
 * 校验 TokenHub API Key 是否有效（不产生任何生成费用）：
 * 用一个不可能存在的任务 id 触发查询，用状态码区分鉴权——无效 key 返回 401，有效 key 返回业务错误(非 401)。
 * 仅把 401 视为「无效」，其余 HTTP 响应视为鉴权已通过。
 */
export async function testTokenhubApiKey(apiKey: string): Promise<{ ok: boolean; error?: string }> {
  const key = (apiKey ?? "").trim()
  if (!key) return { ok: false, error: "请先输入 API Key" }
  try {
    const res = await fetch(TKH_VIDEO_QUERY_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: "hy-video-1.5", id: "qf-invalid-key-check-nonexistent" }),
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
 * 查询 TokenHub 真实额度（Uin 级共享积分）。
 * TokenHub 免费额度是控制台侧的「启用管理」积分，数据面公开 API 无法读取；
 * Uin 级积分接口尚未探测确认（见计划 §4.2/§4.5），本轮先返回「待探测」结果，由上层回退本地账本展示。
 */
export async function fetchTokenhubQuota(
  apiKey: string,
  uin?: string | null,
): Promise<{ ok: true; quota: TokenhubQuota } | { ok: false; error: string }> {
  if (!apiKey) return { ok: false, error: "缺少 API Key" }
  // 控制台会话已捕获，但 Uin 级积分接口尚未确认，本轮不盲目请求未知端点。
  return { ok: false, error: "腾讯云TokenHub 额度接口待探测：暂以本地账本为准" }
}

/**
 * TokenHub 「免费视频生成」模型元数据（账号无关的稳定目录；不写死任何积分余额）。
 * 积分费率/任务类型来源（2026-08-21 实测官方）：产品计费 1823/130055 + 模型列表 1823/130051 + 调用指南 1823/135716。
 * 1 积分 = 1.0 元（官方模型价格 doc；个别社区文曾写视频 1 积分=1.2 元，以官方为准）。
 */
export interface TokenhubFreeVideoModel {
  id: string
  /** 控制台展示名（用于爬取归一化） */
  name: string
  modes: string[]
  free: true
  price: string
  /** 计费方式：per_call 按次扣积分；per_second 按生成秒数扣积分 */
  costType: 'per_call' | 'per_second'
  /** per_call 单次消耗积分（仅 costType=per_call） */
  pointsPerCall?: number
  /** per_second 每秒消耗积分（仅 costType=per_second） */
  pointsPerSecond?: number
  /** 支持时长档（秒，官方 OpenAI 兼容示例未给出准确档位，未实测前保守置空，见计划 §4.3） */
  durations?: number[]
  /** 支持分辨率档（官方示例未给出，未实测前置空，见计划 §4.3） */
  resolutions?: string[]
  quotaHint: string
  /** 每模型免费额度（绑定/静默刷新时随控制台 DescribeModelEndpointList 实抓写入；抓不到则缺省 → 展示未知） */
  freeQuota?: TokenhubModelQuota
}

/**
 * TokenHub 「免费视频生成模型」目录（厂商级、账号无关）。
 * 仅声明元数据（id/名称/能力/费率），不写死任何积分余额——免费额度是每模型动态数据，由控制台
 * DescribeModelEndpointList 实抓后随 `freeQuota` 写入（见 attachTokenhubFreeQuota）；抓不到即「额度未知」：前端显示 —、生成前保守拦截。
 */
export function tokenhubFreeVideoModels(): TokenhubFreeVideoModel[] {
  return [
    {
      id: "hy-video-1.5",
      name: "HY-Video-1.5",
      modes: ["text2video", "img2video"],
      free: true,
      price: "1.5 积分/次",
      costType: "per_call",
      pointsPerCall: 1.5,
      quotaHint: "免费生视频包（启用管理页领取）",
    },
    {
      id: "yt-video-2.0",
      name: "YT-Video-2.0",
      modes: ["img2video"],
      free: true,
      price: "2 积分/次起（480p）",
      costType: "per_call",
      pointsPerCall: 2,
      quotaHint: "免费生视频包（启用管理页领取）",
    },
    {
      id: "yt-video-humanactor",
      name: "YT-Video-HumanActor",
      modes: ["img2video"],
      free: true,
      price: "1 积分/秒（720p）",
      costType: "per_second",
      pointsPerSecond: 1,
      quotaHint: "免费生视频包（启用管理页领取）",
    },
    {
      id: "yt-video-fx",
      name: "YT-Video-FX",
      modes: ["img2video"],
      free: true,
      price: "按模板积分",
      costType: "per_call",
      quotaHint: "免费生视频包（启用管理页领取）",
    },
  ]
}

/** 控制台「启用管理 → 视频生成」页抓到的条目（名 / 剩余与总积分）——结构待 §4.2/4.5 实测固化 */
export interface TokenhubScrapedFreeModel {
  name: string
  id?: string
  remaining?: number
  total?: number
}

/** 展示名 → Model ID 固定映射（权威值） */
export const TOKENHUB_FREE_NAME_TO_ID: Record<string, string> = Object.fromEntries(
  tokenhubFreeVideoModels().map((m) => [m.name, m.id]),
)

/**
 * 把实抓的模型名归一到「权威目录」的 Model ID：
 * 精确命中固定映射 / 规范化后等于目录 id；含中文/超长/非法字符拒绝。
 */
function resolveTokenhubScrapedId(rawName: string): string | null {
  const raw = (rawName || "").trim()
  if (!raw) return null
  const exact = TOKENHUB_FREE_NAME_TO_ID[raw]
  if (exact) return exact
  const norm = raw.toLowerCase().replace(/\s+/g, "-")
  for (const m of FREE_CATALOG) if (m.id === norm) return m.id
  if (/[\u4e00-\u9fa5]/.test(norm)) return null
  if (norm.length > 64) return null
  if (!/^[a-z0-9][a-z0-9._-]*[a-z0-9]$/.test(norm)) return null
  return norm
}

/** 内置免费目录（作为爬取失败的权威兜底） */
const FREE_CATALOG: TokenhubFreeVideoModel[] = tokenhubFreeVideoModels()

/**
 * 「绑定即抓模型」：把控制台实时抓到的免费生视频模型归一到目录。
 * 当前确认的四个免费视频模型都在内置目录；「启用管理」页的视频模型/积分结构（§4.2/4.5）尚未实测确认，
 * 故以目录为骨架，实抓失败/未知结构回退内置目录（source=fallback）。
 */
export function captureTokenhubFreeModels(
  scraped: TokenhubScrapedFreeModel[] | null | undefined,
): { models: TokenhubFreeVideoModel[]; source: "console" | "fallback" } {
  const src = Array.isArray(scraped) ? scraped : []
  if (src.length === 0) return { models: FREE_CATALOG.map((m) => ({ ...m })), source: "fallback" }
  const byId = new Map<string, TokenhubFreeVideoModel>()
  for (const m of FREE_CATALOG) byId.set(m.id, { ...m })
  for (const s of src) {
    const name = s.name?.trim() || ""
    if (!name) continue
    const id = resolveTokenhubScrapedId(name)
    if (!id) continue
    if (!byId.has(id)) continue
  }
  return { models: Array.from(byId.values()), source: "console" }
}

/** TokenHub 提交/查询失败的响应归类为「不可用」标记（镜像火山）；本轮端点简单，保留扩展 */
export function tokenhubGenUnavailableKind(_code?: string, _msg?: string): 'decommissioned' | 'no_endpoint' | undefined {
  const msgText = String(_msg ?? "")
  if (/下架|下线|decommission|discontinued|end of service|not for sale/i.test(msgText)) return 'decommissioned'
  if (/not found|does not exist|not activated|not enabled|未开通|无访问权限/i.test(msgText)) return 'no_endpoint'
  return undefined
}

/** TokenHub 视频生成入参（mode 仅文生/图生；图生用公网 HTTPS 图片 URL） */
export interface TokenhubGenerateOptions {
  mode: "text2video" | "img2video"
  model: string
  prompt: string
  /** 公网 HTTPS 图片 URL 数组（图生取首张） */
  images?: string[]
  onProgress?: (message: string) => void
}

export interface TokenhubGenerateOutcome {
  ok: boolean
  videoUrl?: string
  coverImageUrl?: string
  traceId?: string
  error?: string
  unavailable?: "decommissioned" | "no_endpoint"
}

/**
 * TokenHub 视频生成（统一 OpenAI 兼容端点，submit→poll query→解析 URL）。
 * 数据面已实测（官方调用指南 1823/135716，2026-08-21）：
 *   submit 返回 {id,status:'queued',...}；query 入参 {model,id}，返回 {status:'queued|in_progress|completed|failed', data:{url}}。
 * 四模型 body 差异见下方 SUBMIT_BODY。防御式解析：字段缺失按失败处理，绝不虚构 URL。
 */
export async function tokenhubGenerateWithKey(
  apiKey: string,
  opts: TokenhubGenerateOptions,
): Promise<TokenhubGenerateOutcome> {
  const key = (apiKey ?? "").trim()
  if (!key) return { ok: false, error: "缺少 TokenHub API Key" }

  const model = (opts.model ?? "").trim()
  const imageUrl = ((opts.images ?? []).filter((u) => /^https?:\/\//i.test(u))[0] ?? "").trim()

  const submitBody: Record<string, unknown> = { model }
  if (model === "hy-video-1.5") {
    // HY：文生传 prompt；图生随附 image:{url}
    submitBody["prompt"] = opts.prompt
    if (opts.mode === "img2video" && imageUrl) submitBody["image"] = { url: imageUrl }
  } else if (model === "yt-video-2.0" || model === "yt-video-humanactor") {
    if (!imageUrl) return { ok: false, error: "该模型为图生视频，需要至少 1 张公网 HTTPS 图片" }
    submitBody["image"] = { url: imageUrl }
  } else if (model === "yt-video-fx") {
    // FX 需要「特效模板」参数，现调度台无模板选择器，先不虚构模板代入生成。
    return { ok: false, error: "YT-Video-FX 需特效模板参数，暂不支持在调度台生成" }
  } else {
    return { ok: false, error: `TokenHub 未知模型 ${model}` }
  }

  opts.onProgress?.("提交生成任务…")
  let traceId: string | undefined
  try {
    const submitRes = await fetch(TKH_VIDEO_SUBMIT_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify(submitBody),
      signal: AbortSignal.timeout(20000),
    })
    if (submitRes.status === 401) return { ok: false, error: "API Key 无效或已失效（身份验证失败）" }
    if (submitRes.status === 403) return { ok: false, error: "无权限或未开通（免费额度需先在启用管理页领取）", unavailable: "no_endpoint" }
    if (!submitRes.ok) {
      const kind = tokenhubGenUnavailableKind(String(submitRes.status), await safeText(submitRes))
      return { ok: false, error: `提交失败（HTTP ${submitRes.status}）`, unavailable: kind }
    }
    const submitData = (await submitRes.json().catch(() => null)) as { id?: string; status?: string } | null
    traceId = typeof submitData?.id === "string" && submitData.id ? submitData.id : undefined
    if (!traceId) return { ok: false, error: "提交响应缺少任务 id" }
  } catch {
    return { ok: false, error: "提交失败（网络错误或超时）" }
  }

  // 轮询查询直到 completed/failed，超时兜底
  const QUERY_MS = 3000
  const MAX_WAIT_MS = 10 * 60 * 1000
  const deadline = Date.now() + MAX_WAIT_MS
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, QUERY_MS))
    let state: { status?: string; progress?: number; data?: { url?: string } } | null = null
    try {
      const qRes = await fetch(TKH_VIDEO_QUERY_URL, {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify({ model, id: traceId }),
        signal: AbortSignal.timeout(20000),
      })
      if (qRes.status === 401) return { ok: false, error: "API Key 失效（查询被拒绝）" }
      if (!qRes.ok) {
        const kind = tokenhubGenUnavailableKind(String(qRes.status), await safeText(qRes))
        return { ok: false, error: `查询失败（HTTP ${qRes.status}）`, unavailable: kind }
      }
      state = (await qRes.json().catch(() => null)) as { status?: string; progress?: number; data?: { url?: string } } | null
    } catch {
      continue
    }
    const status = state?.status ?? ""
    if (status === "completed") {
      const url = typeof state?.data?.url === "string" && state.data.url ? state.data.url : undefined
      if (!url) return { ok: false, error: "生成完成但响应缺少视频 URL", traceId }
      return { ok: true, videoUrl: url, coverImageUrl: undefined, traceId }
    }
    if (status === "failed") {
      return { ok: false, error: "生成失败", traceId }
    }
    const progress = typeof state?.progress === "number" ? Math.round(state.progress) : undefined
    opts.onProgress?.(progress !== undefined ? `生成中 ${progress}%` : "生成中…")
  }
  return { ok: false, error: "生成超时（请稍后到历史记录查询）", traceId }
}

async function safeText(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 300)
  } catch {
    return ""
  }
}