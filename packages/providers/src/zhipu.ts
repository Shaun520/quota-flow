// 智谱（bigmodel.cn）清影视频生成适配器
//
// 基于 2026-08-17 实测确认的接口结构（见 docs/厂商与API平台接入/API开放平台接入方案.md §4.2.1）：
//   提交：POST https://open.bigmodel.cn/api/paas/v4/videos/generations
//         请求头 Authorization: Bearer <api_key>
//         请求体 { model: "cogvideox-flash", prompt?, image_url? }
//         响应 task_id 即顶层 id（与 request_id 相同）
//   轮询：GET  https://open.bigmodel.cn/api/paas/v4/async-result/{task_id}
//         task_status ∈ PROCESSING / SUCCESS / FAIL
//         成功终态视频在 video_result[0].url，封面在 video_result[0].cover_image_url
//   限流：高峰期会返回 {"error":{"code":"1305"}} (HTTP 429)，需指数退避重试
//   免费：cogvideox-flash 实测 usage token 全 0，不扣赠送额度
//
// 配置：在项目 data/zhipu-api-key 文件存放 API Key（明文，仅本地私有环境用）。
//       生产环境应改为读 provider_keys 表中解密后的值，见方案文档 §9。
//
// 本文件内置详细日志埋点（带时间戳/级别/环节前缀），便于排查：
//   [zhipu] submit       提交环节（含请求摘要、响应、限流重试计数）
//   [zhipu] poll         轮询环节（每轮状态、耗时、命中终态）
//   [zhipu] done         成功终态解析（video_url / cover / usage）
//   [zhipu] quota        额度扣减（估算、实际 usage、失败清零）
//   [zhipu] fail         失败路径（超时、限流耗尽、任务 FAIL）

import type { GenerateOptions, GenerateResult, ProviderCapabilities } from "@quota-flow/core";
import { BaseProvider } from "@quota-flow/core";
import * as fs from "node:fs";
import * as path from "node:path";

// 探测 key 文件：dist(__dirname=packages/providers/dist) 与 源码(src) 的 __dirname 深度不同，
// 统一向项目根 data/ 归位（与 qwen/yuanbao 鉴权 json 同目录），并兜底 cwd。
export const ZHIPU_API_KEY_CANDIDATES = [
  path.resolve(__dirname, "..", "..", "..", "data", "zhipu-api-key"), // src/dist → 项目根
  path.resolve(__dirname, "..", "..", "data", "zhipu-api-key"),       // 兼容 dist 少一层
  path.resolve(process.cwd(), "data", "zhipu-api-key"),               // 兜底 cwd/data
];
const BASE_URL = "https://open.bigmodel.cn/api/paas/v4";
const FREE_MODEL = "cogvideox-flash";

// 视频模型定价（2026-08 实测，来源 open.bigmodel.cn/pricing）：
//   cogvideox-flash: 免费（usage=0，公测不扣费），cost=0
//   cogvideox-2: 付费 ¥0.5/次，cost=1（计 1 次额度）
//   cogvideox-3: 付费 ¥1/次，cost=1
const MODEL_COSTS: Record<string, number> = {
  "cogvideox-flash": 0,
  "cogvideox-2": 1,
  "cogvideox-3": 1,
  "viduq1-text": 1,
  "viduq1-image": 1,
  "viduq1-start-end": 1,
  "vidu2-image": 1,
  "vidu2-start-end": 1,
  "vidu2-reference": 1,
};
const PAID_MODELS = new Set(["cogvideox-2", "cogvideox-3", "viduq1-text", "viduq1-image", "viduq1-start-end", "vidu2-image", "vidu2-start-end", "vidu2-reference"]);

// ---- 极简结构化日志（无第三方依赖；生产可替换为统一 logger）----
type LogLevel = "debug" | "info" | "warn" | "error";
const LOG_ENABLED: Record<LogLevel, boolean> = {
  debug: Boolean(process.env["QUOTA_DEBUG"]),
  info: true,
  warn: true,
  error: true,
};
function log(level: LogLevel, stage: string, msg: string, extra?: unknown): void {
  if (!LOG_ENABLED[level]) return;
  const ts = new Date().toISOString();
  const line = `[zhipu][${level.toUpperCase()}][${ts}] [${stage}] ${msg}`;
  if (extra !== undefined) {
    let serialized: string;
    try {
      // 只序列化可安全展示的（不打印完整 key）
      serialized = JSON.stringify(redact(extra));
    } catch {
      serialized = String(extra);
    }
    if (level === "error") console.error(line, serialized);
    else console.log(line, serialized);
  } else {
    if (level === "error") console.error(line);
    else console.log(line);
  }
}
/** 递归抹掉敏感字段，避免把 api_key / cookie 泄漏进日志 */
function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const lower = k.toLowerCase();
      if (/key|token|cookie|secret|authorization|password|credential/i.test(lower)) {
        out[k] = typeof v === "string" && v ? `${v.slice(0, 6)}***` : "[redacted]";
      } else {
        out[k] = redact(v);
      }
    }
    return out;
  }
  return value;
}

function loadApiKey(): string | null {
  const file = ZHIPU_API_KEY_CANDIDATES.find((p) => {
    try {
      return fs.existsSync(p);
    } catch {
      return false;
    }
  });
  if (!file) {
    log("warn", "init", `未找到 zhipu-api-key（探测路径: ${ZHIPU_API_KEY_CANDIDATES.join(" | ")}）`);
    return null;
  }
  try {
    return fs.readFileSync(file, "utf-8").replace(/^\uFEFF/, "").trim() || null;
  } catch (err) {
    log("error", "init", "读取 API Key 失败", err instanceof Error ? err.message : err);
    return null;
  }
}

/** 统一的 JSON 请求封装：返回 { status, data }，data 为解析后的 object；请求失败抛错。 */
async function apiJson(
  method: "GET" | "POST",
  url: string,
  apiKey: string,
  body?: unknown,
  timeoutMs = 60000,
): Promise<{ status: number; data: Record<string, unknown> }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await res.text();
    let data: Record<string, unknown> = {};
    if (text) {
      try {
        data = JSON.parse(text) as Record<string, unknown>;
      } catch {
        log("warn", "http", `响应非 JSON（HTTP ${res.status}）`, text.slice(0, 200));
        data = { _raw: text };
      }
    }
    return { status: res.status, data };
  } finally {
    clearTimeout(timer);
  }
}

/** 解析智谱错误对象：错误码优先，其次 message，未知则返回 null。 */
function parseZhipuError(data: unknown): { code?: string; message: string } | null {
  const d = data as { error?: { code?: unknown; message?: unknown } } | null;
  const code = d?.error?.code;
  const msg = d?.error?.message;
  if (code === undefined && msg === undefined) return null;
  return { code: code === undefined || code === null ? undefined : String(code), message: String(msg ?? "未知错误") };
}

/** 限流重试：提交阶段对 1305 等限流码做指数退避重试。返回最终一次 { status, data }。 */
async function submitWithRetry(
  apiKey: string,
  body: Record<string, unknown>,
  policy: { maxRetries: number; baseDelayMs: number },
  onProgress?: (message: string) => void,
): Promise<{ status: number; data: Record<string, unknown> }> {
  let attempt = 0;
  for (;;) {
    attempt += 1;
    const r = await apiJson("POST", `${BASE_URL}/videos/generations`, apiKey, body);
    const err = parseZhipuError(r.data);
    // 1305 = 模型访问量过大（限流）；HTTP 429 也按可重试处理
    const isRateLimited = r.status === 429 || err?.code === "1305";
    if (!isRateLimited) {
      log("debug", "submit", `第 ${attempt} 次提交结束，无需重试`, { status: r.status });
      return r;
    }
    if (attempt >= policy.maxRetries) {
      log("warn", "submit", `限流重试达上限 ${policy.maxRetries} 次，放弃本次提交`, {
        attempt,
        status: r.status,
        code: err?.code,
      });
      onProgress?.(`限流重试已达上限（${policy.maxRetries} 次），提交失败`);
      return r;
    }
    const delay = policy.baseDelayMs * 2 ** (attempt - 1); // 指数退避
    log("warn", "submit", `限流（code=${err?.code ?? "-"}），${delay}ms 后重试 (${attempt}/${policy.maxRetries})`);
    // 面向桌面调度台的过程提示：让 UI 显示「限流，xxxxms 后重试」而非停留在「选中账号…」
    onProgress?.(`平台限流，${delay}ms 后自动重试（第 ${attempt}/${policy.maxRetries} 次）`);
    await new Promise((r) => setTimeout(r, delay));
  }
}

/** 轮询任务直到终态，逐轮打日志。返回终态数据；超时返回 null 并标记。 */
async function pollTask(
  apiKey: string,
  taskId: string,
  policy: { maxPolls: number; intervalMs: number },
): Promise<{ data: Record<string, unknown> | null; timedOut: boolean; polls: number }> {
  const startedAt = Date.now();
  for (let i = 0; i < policy.maxPolls; i++) {
    const pollNo = i + 1;
    try {
      const r = await apiJson("GET", `${BASE_URL}/async-result/${taskId}`, apiKey, undefined, 20000);
      const status = String(r.data["task_status"] ?? "UNKNOWN");
      log(
        "debug",
        "poll",
        `第 ${pollNo}/${policy.maxPolls} 轮 → task_status=${status} 耗时=${Date.now() - startedAt}ms`,
      );
      if (status !== "PROCESSING") {
        // PROCESSING 之外都算终态（SUCCESS / FAIL / 其它），即使 FAIL 也交由上层判定
        log("info", "poll", `第 ${pollNo} 轮到达终态 task_status=${status}`);
        return { data: r.data, timedOut: false, polls: pollNo };
      }
      // 限流时 task_status 可能是 PROCESSING 但带 error；继续按正常轮询间隔走
    } catch (err) {
      log("warn", "poll", `第 ${pollNo} 轮请求异常`, err instanceof Error ? err.message : err);
    }
    if (i < policy.maxPolls - 1) {
      await new Promise((r) => setTimeout(r, policy.intervalMs));
    }
  }
  log("warn", "poll", `轮询超时（${policy.maxPolls} 次），任务仍未知或未完成`);
  return { data: null, timedOut: true, polls: policy.maxPolls };
}

/** 从成功终态数据中解析视频 URL 与封面。 */
function parseVideoResult(data: Record<string, unknown>): {
  videoUrl?: string;
  coverImageUrl?: string;
  usage?: Record<string, unknown>;
} {
  const videoResult = data["video_result"];
  if (Array.isArray(videoResult) && videoResult.length > 0) {
    const first = videoResult[0] as Record<string, unknown> | undefined;
    if (first && typeof first["url"] === "string") {
      return {
        videoUrl: first["url"],
        coverImageUrl: typeof first["cover_image_url"] === "string" ? first["cover_image_url"] : undefined,
        usage: (data["usage"] as Record<string, unknown>) ?? undefined,
      };
    }
  }
  return { usage: (data["usage"] as Record<string, unknown>) ?? undefined };
}

// ---- 真实免费额度查询（网页控制台 biz 域，API Key 亦可认证）----
// 终验接口：GET /api/biz/tokenAccounts/list/my（2026-08-18 实测）
//   Authorization: Bearer <api_key>
//   返回 rows[]，其中「图片/视频生成资源包」= 按次计费、可用于视频生成：
//     tokensMagnitude  原始赠送总量（如 20）
//     tokenBalance    当前剩余（随消耗实时减少，如 16）
//     consumeType     "TIMES"（按次）/"TOKENS"（按 token）
//  一次 cogvideox-2 视频生成扣 1 次资源包（20-4=16 与最近 4 次消耗吻合）。
export interface ZhipuQuota {
  /** 否查到可用的视频/按次资源包 */
  available: boolean
  /** 原始赠送总量（次），无可用包时为 0 */
  total: number
  /** 当前剩余（次），无可用包时为 0 */
  remaining: number
  /** 资源包过期时间（UTC ISO），无则为 null */
  expiresAt?: string | null
  /** 匹配到的资源包名（首个） */
  packageName?: string | null
  /** 仅有过期资源包、无有效额度时置为 true，UI 应显示「已过期」 */
  expired?: boolean
  /** 所属账号 customerId（用于账号级去重） */
  customerId?: unknown
}

const BIZ_QUOTA_URL =
  "https://open.bigmodel.cn/api/biz/tokenAccounts/list/my?pageNum=1&pageSize=50&filterEnabled=false"

/**
 * 查询智谱平台的控制台资源包（免费额度）
 * @param apiKey  PaaS 平台 API Key（用于生成视频）
 * @param consoleJwt  可选：控制台登录会话 JWT（用于调 api/biz 接口查真实额度）。
 *                     不传时仍用 API Key 尝试（但 biz 接口会因身份验证失败而返回失败）。
 */
/** 反复 URL 解码直到不再含 %XX 编码序列；安全失败则返回原文 */
function fullyDecode(value: string): string {
  let d = value
  for (let i = 0; i < 3; i++) {
    try {
      const n = decodeURIComponent(d)
      if (!/%[0-9A-Fa-f]{2}/.test(n)) break
      d = n
    } catch {
      break
    }
  }
  return d
}

/** 从任意值中提取标准 JWT（eyJ 开头）；无法提取时返回空串 */
const ZHIPU_JWT_RE = /(?:eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,})/
/** 深度遍历任意 JSON，返回第一个字符串里匹配到的 JWT */
function findJwtInObject(node: unknown): string {
  const stack: unknown[] = [node]
  while (stack.length) {
    const it = stack.pop()
    if (typeof it === "string") {
      const m = it.match(ZHIPU_JWT_RE)
      if (m) return m[0]
    } else if (it && typeof it === "object") {
      for (const k of Object.keys(it as Record<string, unknown>)) {
        stack.push((it as Record<string, unknown>)[k])
      }
    }
  }
  return ""
}

function extractJwt(value?: string | null): string {
  if (!value) return ""
  // 兜底：捕获到的 consoleJwt 可能是 {"session_id":...} 等 JSON 结构，且内部令牌可能被 URL 编码
  // （JWT 的 '.' 变成 %2E 等），导致正则/普通扫描匹配不到。策略：彻底解码 → 直接扫 → JSON 深度扫。
  const decoded = fullyDecode(value)
  const m = decoded.match(ZHIPU_JWT_RE)
  if (m) return m[0]
  try {
    const parsed = JSON.parse(decoded) as unknown
    const hit = findJwtInObject(parsed)
    if (hit) return hit
  } catch {
    // 非 JSON，跳过
  }
  return ""
}

export async function fetchZhipuQuota(
  apiKey: string,
  consoleJwt?: string,
): Promise<{ ok: true; quota: ZhipuQuota } | { ok: false; error: string }> {
  try {
    const jwt = extractJwt(consoleJwt)
    // 仅当 consoleJwt 内确能提取到标准 JWT 时才用它；否则回退 API Key，避免贴脏值导致 401
    const authHeader = jwt ? `Bearer ${jwt}` : `Bearer ${apiKey}`
    const res = await fetch(BIZ_QUOTA_URL, {
      method: "GET",
      headers: { Authorization: authHeader },
      signal: AbortSignal.timeout(15000),
    })
    const text = await res.text()
    let data: { rows?: unknown } | null = null
    try {
      data = JSON.parse(text) as { rows?: unknown } | null
    } catch {
      // 非法 JSON（如 HTML 报错页）→ 归为失败
    }
    if (!res.ok || !data || typeof data.rows !== "object" || data.rows === null) {
      return { ok: false, error: `额度查询失败（HTTP ${res.status}）` }
    }
    const rows = data.rows as Array<Record<string, unknown>>
    // 账号标识：同一智谱账号（同一 customerId）下可有多个 API Key，用于账号级去重
    const ownerCust = rows[0]?.customerId
    const isExpired = (r: Record<string, unknown>): boolean => r.status === "EXPIRED"
    const isVideo = (r: Record<string, unknown>): boolean =>
      /视频生成|图片\/视频生成|文生视频|图生视频/i.test(String(r.resourcePackageName ?? "") + String(r.suitableScene ?? ""))
    // 只统计未过期资源包，避免把已过期包误当有效额度展示
    const active = rows.filter((r) => !isExpired(r))
    // 优先「图片/视频生成资源包」等视频相关按次包；兜底所有 TIMES 资源包
    const video = active.filter(isVideo)
    const candidates = video.length > 0 ? video : active.filter((r) => r.consumeType === "TIMES")
    if (candidates.length === 0) {
      // 没有任何有效候选：若确实存在视频/TIMES 资源包但均已过期，则标「已过期」，否则视为无额度
      const anyRelevant = rows.some((r) => isVideo(r) || r.consumeType === "TIMES")
      return {
        ok: true,
        quota: {
          available: false,
          total: 0,
          remaining: 0,
          expired: anyRelevant || undefined,
          customerId: ownerCust
        }
      }
    }
    const first = candidates[0]
    const verboseRemaining = Number(first.availableBalance ?? first.tokenBalance ?? first.tokensMagnitude ?? 0)
    return {
      ok: true,
      quota: {
        available: true,
        total: Number(first.tokensMagnitude ?? first.tokenBalance ?? 0),
        // 剩余优先取「可用余额」availableBalance（未用数量）；只有拿不到时才回退 tokenBalance / tokensMagnitude
        remaining: verboseRemaining,
        expiresAt: typeof first.expirationTime === "string" ? first.expirationTime : null,
        packageName: typeof first.resourcePackageName === "string" ? first.resourcePackageName : null,
        customerId: ownerCust,
      }
    }
  } catch {
    return { ok: false, error: "额度查询失败（网络错误或超时）" }
  }
}

/**
 * 校验智谱开放平台 API Key 是否有效（不产生任何生成费用）：
 * 调用 PaaS 只读模型列表端点，无效 key 会返回 HTTP 401 身份验证失败。
 */
export async function testZhipuApiKey(
  apiKey: string,
): Promise<{ ok: boolean; error?: string }> {
  const key = (apiKey ?? "").trim();
  if (!key) return { ok: false, error: "请先输入 API Key" };
  try {
    const { status, data } = await apiJson("GET", `${BASE_URL}/models`, key, undefined, 15000);
    if (status === 200) return { ok: true };
    const err = parseZhipuError(data);
    if (status === 401) return { ok: false, error: `API Key 无效或已失效（${err?.message ?? "身份验证失败"}）` };
    return { ok: false, error: `校验失败（HTTP ${status}${err?.message ? `：${err.message}` : ""}）` };
  } catch {
    return { ok: false, error: "校验失败（网络错误或超时）" };
  }
}

// ---- key 可注入的生成入口（桌面端多账号场景）----
// 复用上面的 submit/poll/parse 内部逻辑，但 apiKey 由调用方显式传入（而非读 data/zhipu-api-key 文件），
// model 也由调用方指定（而非依赖 ZHIPU_MODEL 环境变量），便于桌面调度台按账号解密后逐个调用。
export interface ZhipuGenerateOptions {
  mode: "text2video" | "img2video" | "first_last" | "multi_ref";
  model: string;
  prompt?: string;
  /** 单图：图生视频首帧；当给出数组时代表首尾帧(2)/参考生(N) */
  imageUrl?: string | string[];
  /** 附加参数透传：size/fps/with_audio/quality，以及 Vidu 的 duration/aspect_ratio/movement_amplitude/style */
  extra?: Record<string, unknown>;
}

export interface ZhipuGenerateResult {
  ok: boolean;
  videoUrl?: string;
  coverImageUrl?: string;
  traceId?: string;
  polls?: number;
  model: string;
  error?: string;
}

/** 单次生成：提交 → 轮询 → 解析视频 URL。失败返回 ok=false + error。
 *  onProgress 用于桌面调度台实时推送过程提示（限流重试等）。 */
export async function zhipuGenerateWithKey(
  apiKey: string,
  opts: ZhipuGenerateOptions,
  onProgress?: (message: string) => void,
): Promise<ZhipuGenerateResult> {
  if (apiKey === undefined || apiKey === null || !apiKey.trim()) {
    return { ok: false, model: opts.model, error: "智谱 API Key 缺失" };
  }
  const startedAt = Date.now();
  const { mode, model } = opts;
  const body: Record<string, unknown> = {
    model,
    prompt: opts.prompt ?? (mode === "img2video" ? "让图片动起来" : "生成一段视频"),
  };
  // 图片透传：单图 → 字符串；首尾帧/参考生 → 数组
  if (opts.imageUrl && mode !== "text2video") {
    body["image_url"] = opts.imageUrl;
  }
  // 附加参数（size/duration/fps/with_audio/quality/aspect_ratio/movement_amplitude/style）仅在传入时透传
  if (opts.extra && typeof opts.extra === "object") {
    for (const key of ["size", "duration", "fps", "with_audio", "quality", "aspect_ratio", "movement_amplitude", "style"]) {
      const v = (opts.extra as Record<string, unknown>)[key];
      if (v !== undefined && v !== null && v !== "") body[key] = v;
    }
  }

  try {
    log("info", "submit", `[api-branch] 提交 ${mode} model=${model}`);
    onProgress?.(`正在提交到智谱清影（${model}）…`);
    const submit = await submitWithRetry(apiKey, body, { maxRetries: 6, baseDelayMs: 1000 }, onProgress);
    const submitErr = parseZhipuError(submit.data);
    if (submitErr) {
      const code = submitErr.code ?? "-";
      log("warn", "fail", `提交失败 status=${submit.status} code=${code} msg=${submitErr.message}`);
      return {
        ok: false,
        model,
        error: `智谱提交失败: ${submitErr.message}${submit.status === 429 || code === "1305" ? "（限流，请稍后再试）" : ""}`,
      };
    }
    const taskId = submit.data["id"];
    if (typeof taskId !== "string" || !taskId) {
      log("warn", "fail", "提交成功但响应中无顶层 id（task_id）", redact(submit.data));
      return { ok: false, model, error: "智谱提交响应缺少顶层 id（task_id）" };
    }

    log("info", "poll", `[api-branch] 开始轮询 task_id=${taskId}`);
    onProgress?.("提交成功，正在生成视频…");
    const { data: finalData, timedOut, polls } = await pollTask(apiKey, taskId, { maxPolls: 80, intervalMs: 6000 });
    if (timedOut || !finalData) {
      return {
        ok: false,
        model,
        error: timedOut ? "智谱任务轮询超时（约 8 分钟），可能仍在生成或已失败" : "智谱轮询无有效结果",
      };
    }

    const finalStatus = String(finalData["task_status"] ?? "UNKNOWN");
    if (finalStatus !== "SUCCESS") {
      log("warn", "fail", `任务终态非 SUCCESS: ${finalStatus}`, redact(finalData));
      return { ok: false, model, error: `智谱任务${finalStatus === "FAIL" ? "失败" : `状态异常 ${finalStatus}`}` };
    }

    const { videoUrl, coverImageUrl } = parseVideoResult(finalData);
    if (!videoUrl) {
      log("warn", "fail", "SUCCESS 但未解析到 video_result[0].url", redact(finalData));
      return { ok: false, model, error: "智谱任务 SUCCESS 但缺少 video_result[0].url" };
    }
    log("info", "done", `[api-branch] 生成成功 video_url=${videoUrl} polls=${polls}`, { model });
    return { ok: true, videoUrl, coverImageUrl, traceId: taskId, polls, model };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    log("error", "fail", `[api-branch] 未捕获异常: ${msg}`);
    return { ok: false, model, error: msg };
  }
}

export class ZhipuProvider extends BaseProvider {
  readonly id = "zhipu";
  readonly displayName = "智谱清影";

  get capabilities(): ProviderCapabilities {
    return {
      // 智谱视频模型能力：
      //   cogvideox-flash: 免费，文生视频 + 图生视频，6s
      //   cogvideox-2: 付费 ¥0.5/次，多分辨率
      //   cogvideox-3: 付费 ¥1/次，多分辨率
      text2video: true,
      img2video: true,
      video2video: false,
      imgs2video: false,
      typicalCostPerCall: 0, // 默认免费模型；付费模型在 estimateCost 中按实际模型判定
      qualityScore: 3.5,
      limits: {
        text2video: "cogvideox-flash 免费 / cogvideox-2 ¥0.5/次 / cogvideox-3 ¥1/次",
        img2video: "同上",
      },
    };
  }

  /** 按实际使用的模型估算额度：免费模型 0 次，付费模型 1 次。 */
  override estimateCost(options: GenerateOptions): number {
    const model = process.env["ZHIPU_MODEL"] || FREE_MODEL;
    return MODEL_COSTS[model] ?? this.capabilities.typicalCostPerCall;
  }

  async generate(options: GenerateOptions): Promise<GenerateResult> {
    const startedAt = Date.now();
    log("info", "gen", "开始生成", {
      mode: options.mode,
      hasPrompt: Boolean(options.prompt),
      hasImageUrl: Boolean(options.imageUrl),
    });

    const apiKey = loadApiKey();
    const quotaUsed = this.estimateCost(options);
    log("debug", "quota", "估算额度", { quotaUsed });

    if (!apiKey) {
      log("warn", "gen", "data/zhipu-api-key 未配置，降级 dry-run");
      // 无 key 时降级 dry-run（与其它 provider 一致，避免阻塞调度）；额度记 0
      return {
        ok: true,
        providerId: this.id,
        traceId: `zhipu-dryrun-${Date.now()}`,
        videoUrl: `https://example.com/zhipu-dryrun/${options.mode}.mp4`,
        downloadUrl: `https://example.com/zhipu-dryrun/${options.mode}.mp4`,
        quotaUsed: 0,
        qualityScore: this.capabilities.qualityScore,
        durationMs: Date.now() - startedAt,
        raw: { warning: "data/zhipu-api-key 未配置，已降级为 dry-run", mode: options.mode },
      };
    }

    const { mode } = options;
    if (mode !== "text2video" && mode !== "img2video") {
      log("warn", "gen", `不支持 mode=${mode}`);
      return fail(this.id, `mode '${mode}' is not supported by ${this.displayName}`, Date.now() - startedAt);
    }
    if (mode === "text2video" && !options.prompt) {
      log("warn", "gen", "text2video 缺少 prompt");
      return fail(this.id, "text2video requires prompt", Date.now() - startedAt);
    }
    if (mode === "img2video" && !options.imageUrl) {
      log("warn", "gen", "img2video 缺少 imageUrl");
      return fail(this.id, "img2video requires imageUrl", Date.now() - startedAt);
    }

    const prompt =
      options.prompt ?? (mode === "img2video" ? "让图片动起来" : "生成一段视频");
    // 默认免费模型；可用 ZHIPU_MODEL 环境变量临时切换付费模型排障（正常勿用）
    const model = process.env["ZHIPU_MODEL"] || FREE_MODEL;
    const body: Record<string, unknown> = {
      model,
      prompt,
    };
    if (mode === "img2video" && options.imageUrl) body["image_url"] = options.imageUrl;

    try {
      // 1) 提交（内置限流重试）
      log("info", "submit", `提交 ${mode} 请求`);
      const submit = await submitWithRetry(apiKey, body, { maxRetries: 6, baseDelayMs: 1000 });
      const submitErr = parseZhipuError(submit.data);
      if (submitErr) {
        const limitExhausted = submit.status === 429 || submitErr.code === "1305";
        // 已走满重试仍限流 → 计失败，额度回 0
        log("error", "fail", `提交失败 status=${submit.status} code=${submitErr.code ?? "-"} msg=${submitErr.message}`, {
          limitExhausted,
        });
        return fail(
          this.id,
          `智谱提交失败: ${submitErr.message}${limitExhausted ? "（限流，请稍后再试）" : ""}`,
          Date.now() - startedAt,
        );
      }
      const taskId = submit.data["id"];
      const requestId = submit.data["request_id"];
      const submitStatus = String(submit.data["task_status"] ?? "UNKNOWN");
      log("info", "submit", `提交成功 task_id=${String(taskId)} request_id=${String(requestId)}`, {
        submitStatus,
        model: submit.data["model"],
      });
      if (typeof taskId !== "string" || !taskId) {
        log("error", "fail", "提交成功但响应中无顶层 id（task_id）", redact(submit.data));
        return fail(this.id, "智谱提交响应缺少顶层 id（task_id）", Date.now() - startedAt);
      }

      // 2) 轮询（对 PROCESSING 限流容忍，逐轮打日志）
      log("info", "poll", `开始轮询 task_id=${taskId}（间隔 ${6}s，最多 ${80} 次）`);
      const { data: finalData, timedOut, polls } = await pollTask(apiKey, taskId, {
        maxPolls: 80,
        intervalMs: 6000,
      });
      if (timedOut || !finalData) {
        log("error", "fail", `轮询超时（${polls} 次）未拿到终态，可能存在任务未完成或失败`);

        return fail(
          this.id,
          timedOut ? "智谱任务轮询超时（约 8 分钟），可能仍在生成或已失败" : "智谱轮询无有效结果",
          Date.now() - startedAt,
        );
      }

      // 3) 终态判定
      const finalStatus = String(finalData["task_status"] ?? "UNKNOWN");
      if (finalStatus !== "SUCCESS") {
        log("error", "fail", `任务终态非 SUCCESS: ${finalStatus}`, redact(finalData));
        return fail(
          this.id,
          `智谱任务${finalStatus === "FAIL" ? "失败" : `状态异常 ${finalStatus}`}`,
          Date.now() - startedAt,
          redact(finalData) as Record<string, unknown>,
        );
      }

      // 4) 解析视频
      const { videoUrl, coverImageUrl, usage } = parseVideoResult(finalData);
      if (!videoUrl) {
        log("error", "fail", "SUCCESS 但未解析到 video_result[0].url", redact(finalData));
        return fail(
          this.id,
          "智谱任务 SUCCESS 但缺少 video_result[0].url",
          Date.now() - startedAt,
          redact(finalData) as Record<string, unknown>,
        );
      }

      const usageTokens = (usage?.["total_tokens"] as number) ?? 0;
      const isPaidModel = PAID_MODELS.has(model);
      log("info", "done", `生成成功 video_url=${videoUrl} cover=${Boolean(coverImageUrl)}`, {
        polls,
        usageTokens,
        usage: usage ?? {},
        model,
        isPaid: isPaidModel,
      });
      log("info", "quota", `额度扣减：模型=${model} 估算 ${quotaUsed}（${isPaidModel ? "付费按次计费" : "免费模型 usage=0"}）`);

      return {
        ok: true,
        providerId: this.id,
        traceId: taskId,
        videoUrl,
        downloadUrl: videoUrl,
        quotaUsed,
        qualityScore: this.capabilities.qualityScore,
        durationMs: Date.now() - startedAt,
        raw: {
          mode,
          model: FREE_MODEL,
          taskId,
          coverImageUrl,
          polls,
          usage,
        },
      };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      log("error", "fail", `未捕获异常: ${msg}`);
      return fail(this.id, msg, Date.now() - startedAt);
    }
  }
}

function fail(
  providerId: string,
  message: string,
  durationMs = 0,
  extra?: Record<string, unknown>,
): GenerateResult {
  log("debug", "quota", "失败路径额度记 0");
  return {
    ok: false,
    providerId,
    quotaUsed: 0,
    errorMessage: message,
    durationMs,
    raw: extra,
  };
}