// 阿里云百炼（Model Studio）API Key 型厂商适配器
//
// API Key 型（apikey），会话捕获/真实免费额度（控制台 costing-balance 页）复用智谱/火山内核：
//   - 数据面为 Bearer Token 鉴权（Authorization: Bearer <sk-api-key> + X-DashScope-Async: enable），
//     与智谱/火山同为 API Key 型，见 docs/厂商与API平台接入/阿里云百炼接入方案.md §3.2。
//   - 真实免费额度在百炼控制台 costing-balance/free-quota 页（按阿里云账号维度，见方案 §3.3/§6.1），
//     API Key 无法携带控制台会话 sec_token，故不可由本文件直连，需走桌面端 captureBailianConsoleSession
//     捕获内核拿到 accountId + freeTierQuotas 快照，随加密 payload 落库。
//   - decodeBailianPayload 与智谱同构（兼容纯 key 旧格式）：{v:1,apiKey,consoleJwt?,accountId?,freeTiers?}。
//
// 日志埋点统一前缀 [qf-bailian]（含 test / fp / free-tier 子阶段，便于排障）。

import { createHash } from "node:crypto";

/**
 * 阿里云百炼「旧版 DashScope 通用任务查询域名」，用于 API Key 只读校验（见 testBailianApiKey）。
 * 新版视频生成 endpoint 带业务空间前缀（https://{WorkspaceId}.cn-beijing.maas.aliyuncs.com/...），
 * 本轮仅做 key 校验、不生成，故用通用域名发起只读探测即可（无需 WorkspaceId）。
 */
export const BAILIAN_TASK_BASE_URL = "https://dashscope.aliyuncs.com/api/v1/tasks";

/** 阿里云百炼控制台模型广场（绑定「获取 API Key」可打开此页；本轮提供为常量备用）。 */
export const BAILIAN_CONSOLE_URL = "https://bailian.console.aliyun.com/cn-beijing?tab=api#/api-key";

/**
 * 阿里云百炼免费额度单模型条目（捕获快照，供聚合展示）。
 * 字段与 control console 实测响应对齐（见方案 §6.1）：
 *   quotaTotal            剩余额度         （×quotaTotalPercentage%）
 *   quotaInitTotal        初始免费额度
 *   quotaTotalPercentage  剩余百分比（100=满）
 *   quotaValidityPeriod   过期时间戳 ms
 *   quotaStatus           VALID / UNKNOWN（无免费额度，或带日期版才有）
 */
export interface BailianFreeTierSlim {
  /** 模型名，如 wan2.7-t2v-2026-06-12 */
  model: string;
  /** 初始免费额度 */
  total: number;
  /** 剩余额度 */
  remaining: number;
  /** 是否已过期 */
  expired: boolean;
  /** 过期时间戳 ms，无则 null */
  expiredAtMs: number | null;
  /** 原始状态：VALID / UNKNOWN */
  status: string;
}

/** 账号级聚合免费额度（账号维度展示口径，见方案 §6.1）。 */
export interface BailianFreeQuota {
  /** 是否抓到至少一条有效视频额度 */
  available: boolean;
  /** 聚合剩余 */
  remaining: number;
  /** 聚合初始总量 */
  total: number;
  /** 是否有任一条已过期（提示用户） */
  expired: boolean;
}

/** 百炼控制台登录 cookie（随加密负载持久化，供「进入官网」在 persist 分区丢失会话后重新注入以重建登录态）。 */
export interface BailianStoredCookie {
  name: string;
  value: string;
  domain?: string;
  path?: string;
  httpOnly?: boolean;
  secure?: boolean;
  /** 过期时间戳 ms；0 表示会话 cookie */
  expires?: number;
}

/**
 * 解阿里云百炼加密负载（兼容多种格式）：
 * - 新版：{ v:1; apiKey:string; consoleJwt?; accountId?; freeTiers?; cookies? } JSON 字符串
 * - 旧版：纯 API Key 字符串（非 `{` 开头）
 */
export function decodeBailianPayload(decrypted: string): {
  apiKey: string;
  consoleJwt?: string | null;
  accountId?: string | null;
  freeTiers?: BailianFreeTierSlim[] | null;
  cookies?: BailianStoredCookie[] | null;
} {
  const trimmed = (decrypted ?? "").trim();
  if (!trimmed.startsWith("{")) return { apiKey: trimmed };
  try {
    const parsed = JSON.parse(trimmed) as {
      v?: number;
      apiKey?: string;
      consoleJwt?: string | null;
      accountId?: string | null;
      freeTiers?: BailianFreeTierSlim[] | null;
      cookies?: BailianStoredCookie[] | null;
    };
    const apiKey = parsed.apiKey?.trim() ?? "";
    let consoleJwt = parsed.consoleJwt ?? null;
    if (typeof consoleJwt === "string" && consoleJwt) {
      try {
        consoleJwt = decodeURIComponent(consoleJwt);
      } catch {}
    }
    return {
      apiKey,
      consoleJwt,
      accountId: typeof parsed.accountId === "string" ? parsed.accountId : null,
      freeTiers: Array.isArray(parsed.freeTiers) ? parsed.freeTiers : null,
      cookies: Array.isArray(parsed.cookies) ? parsed.cookies : null,
    };
  } catch {
    return { apiKey: trimmed };
  }
}

function fingerprintFor(providerId: string, raw: string): string {
  const norm = raw.trim();
  return createHash("sha256")
    .update(`${providerId}|${norm}`)
    .digest("hex");
}

/**
 * 阿里云百炼账号级指纹。
 * 免费额度按「阿里云账号」维度共享（主账号与 RAM 子账号、全国业务空间共享），权威去重键为账号 PK；
 * payload 携带 accountId（捕获内核从控制台取得）时按账号指纹，否则回退 API Key 明文哈希（同智谱 customerId 兜底）。
 * payload 为「加密前明文」，可能是 `{v:1,apiKey,accountId,...}` 或纯 API Key。
 */
export async function bailianAccountFingerprint(payload: string): Promise<string | null> {
  const { apiKey, accountId } = decodeBailianPayload(payload);
  if (!apiKey) return null;
  if (accountId) return fingerprintFor("bailian", "bailian-account:" + accountId);
  return fingerprintFor("bailian", apiKey);
}

/** 深度遍历 JSON，返回第一个「自由命名」的模型额度和数组（宽松找 freeTierQuotas，兼容字段命名差异）。 */
function deepFindFreeTierQuotas(node: unknown): Array<Record<string, unknown>> | null {
  if (node && typeof node === "object") {
    if (Array.isArray(node)) {
      for (const it of node) {
        const hit = deepFindFreeTierQuotas(it);
        if (hit) return hit;
      }
      return null;
    }
    const obj = node as Record<string, unknown>;
    // 命中「数组且元素含模型标识字段」即视为 freeTierQuotas 容器
    for (const k of Object.keys(obj)) {
      const v = obj[k];
      if (Array.isArray(v)) {
        const first = v[0];
        if (
          first &&
          typeof first === "object" &&
          !Array.isArray(first) &&
          (typeof (first as Record<string, unknown>).model === "string" ||
            typeof (first as Record<string, unknown>).quotaTotal !== "undefined")
        ) {
          return v as Array<Record<string, unknown>>;
        }
      }
      const hit = deepFindFreeTierQuotas(v);
      if (hit) return hit;
    }
  }
  return null;
}

/**
 * 解析百炼控制台真实免费额度响应文本 → 归一化条目列表。
 * 来自 captureBailianConsoleSession 捕获的 queryFreeTierQuotaAsyn 响应（或页面 localStorage 缓存整表）。
 * 采用「宽松多字段」容错读取：任意字段缺失时以 0/未知兜底，避免抓到的响应字段与文档有出入就整条丢弃。
 */
export function parseBailianFreeTierPayload(
  text: string,
  nowMs: number = Date.now(),
): BailianFreeTierSlim[] | null {
  if (typeof text !== "string" || !text) return null;
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return null;
  }
  const arr = deepFindFreeTierQuotas(json);
  if (!arr || arr.length === 0) return null;
  const out: BailianFreeTierSlim[] = [];
  for (const it of arr) {
    const model = String(it.model ?? it.Model ?? "");
    if (!model) continue;
    const total = Number(it.quotaInitTotal ?? it.initQuota ?? it.total ?? 0) || 0;
    const remaining = Number(it.quotaTotal ?? it.remaining ?? it.balance ?? total) || 0;
    const expiredAtMsRaw = Number(it.quotaValidityPeriod ?? it.expiry ?? 0) || 0;
    const expiredAtMs = expiredAtMsRaw > 0 ? expiredAtMsRaw : null;
    const status = String(it.quotaStatus ?? it.status ?? (remaining > 0 ? "VALID" : "UNKNOWN"));
    const expired = expiredAtMs !== null ? expiredAtMs <= nowMs : remaining <= 0;
    out.push({
      model,
      total,
      remaining,
      expired,
      expiredAtMs,
      status,
    });
  }
  return out.length > 0 ? out : null;
}

/** 账号级聚合：把多模型免费额度汇总为单一「剩余/总量」，供账号明细口径展示。 */
export function aggregateBailianFreeQuota(
  tiers: BailianFreeTierSlim[] | null | undefined,
): BailianFreeQuota {
  if (!tiers || tiers.length === 0) {
    return { available: false, remaining: 0, total: 0, expired: false };
  }
  let total = 0;
  let remaining = 0;
  let expired = false;
  for (const t of tiers) {
    total += t.total;
    remaining += Math.max(0, t.remaining);
    if (t.expired) expired = true;
  }
  return { available: true, remaining, total, expired };
}

/** 视频生成模型判定：阿里云百炼 Vision 缓存里含大量图片/嵌入/检测类模型，展示时需只保留视频生成模型。
 * 2026-08-20 实测 Vision free_quota 缓存命名规范：视频模型含 t2v/i2v/r2v/kf2v/it2v/2video/video/
 * videoretalk/liveportrait/animate-anyone/start-end 等特征；图片类（qwen-image、*t2i、*2image 等）均不含这些特征。
 */
const BAILIAN_VIDEO_MODEL_PATTERN =
  /(t2v|i2v|r2v|kf2v|it2v|a2v|2video|videoretalk|liveportrait|animate-anyone|start-end)/i;
export function isBailianVideoFreeModel(model: string): boolean {
  return BAILIAN_VIDEO_MODEL_PATTERN.test(model || "");
}

/** 校验阿里云百炼 API Key 是否有效（不产生任何生成费用）：
 * 请求一个不存在的只读任务查询端点，用状态码区分鉴权——无效 key 返回 401，有效 key 返回业务错误(404 等)。
 * 仅把 401 视为"无效"，其余 HTTP 响应视为鉴权已通过（Key 有效）。
 */
export async function testBailianApiKey(
  apiKey: string,
): Promise<{ ok: boolean; error?: string }> {
  const key = (apiKey ?? "").trim();
  if (!key) return { ok: false, error: "请先输入 API Key" };
  try {
    const res = await fetch(`${BAILIAN_TASK_BASE_URL}/qf-invalid-key-check-nonexistent`, {
      method: "GET",
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(15000),
    });
    if (res.status === 401) return { ok: false, error: "API Key 无效或已失效（身份验证失败）" };
    if (res.status >= 200 && res.status < 600) return { ok: true };
    return { ok: false, error: `校验失败（HTTP ${res.status}）` };
  } catch {
    return { ok: false, error: "校验失败（网络错误或超时）" };
  }
}