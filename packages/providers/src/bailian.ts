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
  // 同一模型可能因业务空间分区/缓存拼接出现多条快照；按 model 归一化去重，
  // 同模型只保留「有效额度（remaining 大者）」的一条，避免聚合时把同一模型重复累加（表现为额度翻倍）。
  const byModel = new Map<string, BailianFreeTierSlim>();
  for (const it of arr) {
    const model = String(it.model ?? it.Model ?? "");
    if (!model) continue;
    const total = Number(it.quotaInitTotal ?? it.initQuota ?? it.total ?? 0) || 0;
    const remaining = Number(it.quotaTotal ?? it.remaining ?? it.balance ?? total) || 0;
    const expiredAtMsRaw = Number(it.quotaValidityPeriod ?? it.expiry ?? 0) || 0;
    const expiredAtMs = expiredAtMsRaw > 0 ? expiredAtMsRaw : null;
    const status = String(it.quotaStatus ?? it.status ?? (remaining > 0 ? "VALID" : "UNKNOWN"));
    const expired = expiredAtMs !== null ? expiredAtMs <= nowMs : remaining <= 0;
    const slim: BailianFreeTierSlim = { model, total, remaining, expired, expiredAtMs, status };
    const prev = byModel.get(model);
    if (!prev) { byModel.set(model, slim); continue; }
    // 同模型多快照：优先取「未过期且有效额度」的一条，其次取剩余更多者
    const keep =
      slim.expired && !prev.expired ? prev
      : !slim.expired && prev.expired ? slim
      : slim.remaining > prev.remaining ? slim
      : prev;
    byModel.set(model, keep);
  }
  for (const slim of byModel.values()) out.push(slim);
  return out.length > 0 ? out : null;
}

/** 账号级聚合：把多模型免费额度汇总为单一「剩余/总量」，供账号明细口径展示。
 *  聚合前按 model 归一化去重（同一模型多快照只取价值最合适的一条），避免重复快照被累加导致额度翻倍。
 */
export function aggregateBailianFreeQuota(
  tiers: BailianFreeTierSlim[] | null | undefined,
): BailianFreeQuota {
  if (!tiers || tiers.length === 0) {
    return { available: false, remaining: 0, total: 0, expired: false };
  }
  // 同模型取「未过期优先、其次剩余更大」的一条
  const dedup = new Map<string, BailianFreeTierSlim>();
  for (const t of tiers) {
    const prev = dedup.get(t.model);
    if (!prev) { dedup.set(t.model, t); continue; }
    const keep =
      t.expired && !prev.expired ? prev
      : !t.expired && prev.expired ? t
      : t.remaining > prev.remaining ? t
      : prev;
    dedup.set(t.model, keep);
  }
  let total = 0;
  let remaining = 0;
  let expired = false;
  for (const t of dedup.values()) {
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

// ===========================================================================
// 视频生成数据面（DashScope 异步协议）
// 依据：阿里云百炼官方文档 + 控制台 API case 页（见 docs/厂商与API平台接入/阿里云百炼视频生成接入方案.md §3）。
// 注意：字段名以官方权威 case 页实测为准，若 404/400 需在其上核对 input/parameters 结构后再收敛。
// ===========================================================================

/** 视频生成提交端点（DashScope 异步视频合成）。 */
export const BAILIAN_VIDEO_SYNTH_BASE_URL =
  "https://dashscope.aliyuncs.com/api/v1/services/aigc/video-generation/video-synthesis";

/** 视频生成模型类型枚举。 */
export type BailianVideoMode = "text2video" | "img2video" | "first_last" | "multi_ref";

/**
 * 单一模型的能力元数据（按官方视频生成文档 + 控制台实测命名归纳，属稳定元数据，可入常量）。
 * kind：t2v 文生 / i2v 图生(首帧含首尾帧) / r2v 参考生 / kf2v 关键帧生 / detect 检测 / special 专用。
 * direct=false 表示该模型是检测/专用模型（需要专属输入或前置），不能复用现有 4 模式直接生成，仅做展示标注。
 */
export interface BailianModelCap {
  kind: "t2v" | "i2v" | "r2v" | "kf2v" | "detect" | "special";
  /** 能力展示名 */
  label: string;
  /** 官方能力卡声明的输入模态（Text/Image/Video/Audio） */
  input: string[];
  /** 官方能力卡声明的输出模态（Video/Audio 等） */
  output: string[];
  /** 可选的生成模式（按需取子集；detect/special 可能为空，仅展示） */
  modes: Array<{ value: BailianVideoMode; label: string }>;
  /** 支持时长档位（秒） */
  durations: number[];
  /** 分辨率（API 写法，720P/1080P） */
  resolutions: string[];
  /** 是否可直接复用现有生成链路。false 时不做生成入口，仅展示能力 */
  direct: boolean;
}

/** 单个模型的模式标签（用于模式下拉选项）。 */
export const BAILIAN_MODE_T2V = { value: "text2video" as BailianVideoMode, label: "文生视频" };
export const BAILIAN_MODE_I2V = { value: "img2video" as BailianVideoMode, label: "图生视频(首帧)" };
export const BAILIAN_MODE_FIRST_LAST = {
  value: "first_last" as BailianVideoMode,
  label: "首尾帧生成"
};
export const BAILIAN_MODE_REF = { value: "multi_ref" as BailianVideoMode, label: "参考生视频" };

const BAILIAN_CAP_RES = ['720P', '1080P'];
const BAILIAN_CAP_DEFAULT_DUR = [5, 10];

/**
 * 按模型名逐一核实的能力卡（来源：阿里云百炼官网 help.aliyun.com/zh/model-studio/<模型> 的「模型能力/输入模态」表，
 * 更新时间 2026-07~08，属稳定元数据，可入常量）。
 *
 * 关键：同名家族的不同快照版本，输入模态会因快照而异（如 wan2.7-t2v=Audio+Text，而其 2026-06-12 快照=Text+Image），
 * 因此不能仅凭 t2v/i2v 命名段猜能力，必须逐模型对照官方「输入模态/输出模态」。
 */
const BAILIAN_VERIFIED_CAP: Record<string, Omit<BailianModelCap, 'resolutions'>> = {
  // ---- wan2.7 ----
  // 注：wan2.7-t2v-2026-06-12 官方能力卡标注 Text+Image，但其文生视频 SDK 示例同样使用 input.audio_url（官方文档确认），
  // 故 Audio 一并纳入。Image 为能力卡声明但 HTTP 文生视频 API 无图片传参字段，实际下发仅走 audio_url，图片不误发。
  'wan2.7-t2v': { kind: 't2v', label: '文生视频', input: ['Audio', 'Text'], output: ['Video'], modes: [BAILIAN_MODE_T2V], durations: BAILIAN_CAP_DEFAULT_DUR, direct: true },
  'wan2.7-t2v-2026-04-25': { kind: 't2v', label: '文生视频', input: ['Audio', 'Text'], output: ['Video'], modes: [BAILIAN_MODE_T2V], durations: BAILIAN_CAP_DEFAULT_DUR, direct: true },
  'wan2.7-t2v-2026-06-12': { kind: 't2v', label: '文生视频（支持音频参考）', input: ['Audio', 'Text', 'Image'], output: ['Video'], modes: [BAILIAN_MODE_T2V], durations: BAILIAN_CAP_DEFAULT_DUR, direct: true },
  'wan2.7-i2v': { kind: 'i2v', label: '图生视频', input: ['Audio', 'Image', 'Text'], output: ['Video'], modes: [BAILIAN_MODE_I2V, BAILIAN_MODE_FIRST_LAST], durations: BAILIAN_CAP_DEFAULT_DUR, direct: true },
  'wan2.7-i2v-2026-04-25': { kind: 'i2v', label: '图生视频', input: ['Audio', 'Image', 'Text'], output: ['Video'], modes: [BAILIAN_MODE_I2V, BAILIAN_MODE_FIRST_LAST], durations: BAILIAN_CAP_DEFAULT_DUR, direct: true },
  'wan2.7-r2v': { kind: 'r2v', label: '参考生视频', input: ['Audio', 'Image', 'Text', 'Video'], output: ['Video'], modes: [BAILIAN_MODE_REF], durations: BAILIAN_CAP_DEFAULT_DUR, direct: true },
  'wan2.7-r2v-2026-06-12': { kind: 'r2v', label: '参考生视频', input: ['Text', 'Image', 'Video', 'Audio'], output: ['Video'], modes: [BAILIAN_MODE_REF], durations: BAILIAN_CAP_DEFAULT_DUR, direct: true },
  // ---- wan2.6 ----
  'wan2.6-t2v': { kind: 't2v', label: '文生视频', input: ['Text', 'Audio'], output: ['Video', 'Audio'], modes: [BAILIAN_MODE_T2V], durations: [5, 10, 15], direct: true },
  // wan2.6 图生视频官方归属「图生视频-基于首帧」（仅首帧，不做首尾帧），故只暴露 i2v 模式
  'wan2.6-i2v': { kind: 'i2v', label: '图生视频(首帧)', input: ['Text', 'Image', 'Audio'], output: ['Video', 'Audio'], modes: [BAILIAN_MODE_I2V], durations: [5, 10, 15], direct: true },
  'wan2.6-i2v-flash': { kind: 'i2v', label: '图生视频(首帧)', input: ['Text', 'Image', 'Audio'], output: ['Video', 'Audio'], modes: [BAILIAN_MODE_I2V], durations: [5, 10, 15], direct: true },
  'wan2.6-r2v': { kind: 'r2v', label: '参考生视频', input: ['Image', 'Video', 'Text'], output: ['Video', 'Audio'], modes: [BAILIAN_MODE_REF], durations: BAILIAN_CAP_DEFAULT_DUR, direct: true },
  'wan2.6-r2v-flash': { kind: 'r2v', label: '参考生视频', input: ['Image', 'Video', 'Text'], output: ['Video', 'Audio'], modes: [BAILIAN_MODE_REF], durations: BAILIAN_CAP_DEFAULT_DUR, direct: true },
  // ---- wan2.5 ----
  'wan2.5-t2v-preview': { kind: 't2v', label: '文生视频', input: ['Text', 'Audio'], output: ['Video', 'Audio'], modes: [BAILIAN_MODE_T2V], durations: [5, 10], direct: true },
  'wan2.5-i2v-preview': { kind: 'i2v', label: '图生视频(首帧)', input: ['Text', 'Image', 'Audio'], output: ['Video', 'Audio'], modes: [BAILIAN_MODE_I2V], durations: [5, 10], direct: true },
  // ---- wan2.2（官方固定 5s；图生仅首帧，kf2v 为首尾帧）----
  'wan2.2-t2v-plus': { kind: 't2v', label: '文生视频', input: ['Text'], output: ['Video'], modes: [BAILIAN_MODE_T2V], durations: [5], direct: true },
  'wan2.2-i2v-plus': { kind: 'i2v', label: '图生视频(首帧)', input: ['Image', 'Text'], output: ['Video'], modes: [BAILIAN_MODE_I2V], durations: [5], direct: true },
  'wan2.2-i2v-flash': { kind: 'i2v', label: '图生视频(首帧)', input: ['Image', 'Text'], output: ['Video'], modes: [BAILIAN_MODE_I2V], durations: [5], direct: true },
  'wan2.2-kf2v-flash': { kind: 'kf2v', label: '首尾帧生成', input: ['Image', 'Text'], output: ['Video'], modes: [BAILIAN_MODE_FIRST_LAST], durations: [5], direct: true },
  // ---- wanx2.1（官方固定 5s；i2v-turbo 为 3/4/5s，因 UI 长档仅 5/10/15 与 5s 档，统一按 5s 可选）----
  'wanx2.1-t2v-plus': { kind: 't2v', label: '文生视频', input: ['Text'], output: ['Video'], modes: [BAILIAN_MODE_T2V], durations: [5], direct: true },
  'wanx2.1-t2v-turbo': { kind: 't2v', label: '文生视频', input: ['Text'], output: ['Video'], modes: [BAILIAN_MODE_T2V], durations: [5], direct: true },
  'wanx2.1-i2v-plus': { kind: 'i2v', label: '图生视频(首帧)', input: ['Image', 'Text'], output: ['Video'], modes: [BAILIAN_MODE_I2V], durations: [5], direct: true },
  'wanx2.1-i2v-turbo': { kind: 'i2v', label: '图生视频(首帧)', input: ['Image', 'Text'], output: ['Video'], modes: [BAILIAN_MODE_I2V], durations: [5], direct: true },
  'wanx2.1-kf2v-plus': { kind: 'kf2v', label: '首尾帧生成', input: ['Image', 'Text'], output: ['Video'], modes: [BAILIAN_MODE_FIRST_LAST], durations: [5], direct: true },
  // ---- happyhorse ----
  'happyhorse-1.0-t2v': { kind: 't2v', label: '文生视频', input: ['Text'], output: ['Video'], modes: [BAILIAN_MODE_T2V], durations: BAILIAN_CAP_DEFAULT_DUR, direct: true },
  'happyhorse-1.1-t2v': { kind: 't2v', label: '文生视频', input: ['Text'], output: ['Video'], modes: [BAILIAN_MODE_T2V], durations: BAILIAN_CAP_DEFAULT_DUR, direct: true },
  'happyhorse-1.0-i2v': { kind: 'i2v', label: '图生视频', input: ['Image', 'Text'], output: ['Video'], modes: [BAILIAN_MODE_I2V], durations: BAILIAN_CAP_DEFAULT_DUR, direct: true },
  'happyhorse-1.1-i2v': { kind: 'i2v', label: '图生视频', input: ['Image', 'Text'], output: ['Video'], modes: [BAILIAN_MODE_I2V], durations: BAILIAN_CAP_DEFAULT_DUR, direct: true },
  'happyhorse-1.0-r2v': { kind: 'r2v', label: '参考生视频', input: ['Image', 'Video', 'Text', 'Audio'], output: ['Video'], modes: [BAILIAN_MODE_REF], durations: BAILIAN_CAP_DEFAULT_DUR, direct: true },
  'happyhorse-1.1-r2v': { kind: 'r2v', label: '参考生视频', input: ['Image', 'Video', 'Text', 'Audio'], output: ['Video'], modes: [BAILIAN_MODE_REF], durations: BAILIAN_CAP_DEFAULT_DUR, direct: true },
  // ---- 对口型 / 数字人 / 动作驱动 / 检测（专用，不可直接生成）----
  'videoretalk': { kind: 'special', label: '视频口型替换·声动人像（人物视频+人声音频）', input: ['Video', 'Audio'], output: ['Video'], modes: [], durations: [5, 10], direct: false },
  'liveportrait': { kind: 'special', label: '图生播报·灵动人像（肖像图片+人声音频）', input: ['Image', 'Audio'], output: ['Video'], modes: [], durations: [5, 10], direct: false },
  'liveportrait-detect': { kind: 'detect', label: '灵动人像·图片合规检测（前置检测）', input: ['Image'], output: ['判定结果'], modes: [], durations: [5], direct: false },
  'animate-anyone-gen2': { kind: 'special', label: '舞动人像动作视频(人物图片+动作模板ID)', input: ['Image'], output: ['Video'], modes: [], durations: [5], direct: false },
  'animate-anyone-template-gen2': { kind: 'special', label: '舞动人像·动作模板提取（从其成视频）', input: ['Video'], output: ['模板ID'], modes: [], durations: [5], direct: false },
  'animate-anyone-detect-gen2': { kind: 'detect', label: '舞动人像·图片合规检测（前置检测）', input: ['Image'], output: ['判定结果'], modes: [], durations: [5], direct: false }
};

/**
 * 按模型名归纳能力（官方能力卡实测 + 命名段兜底）。
 * 先精确匹配 BAILIAN_VERIFIED_CAP（逐模型对照官方输入/输出模态，准确）；未收录的模型再按 t2v/i2v/r2v/kf2v 命名段回溯。
 */
export function bailianModelCap(model: string): BailianModelCap {
  const m = (model || '').trim();
  const lower = m.toLowerCase();

  const verified = BAILIAN_VERIFIED_CAP[m];
  if (verified) {
    return { ...verified, resolutions: BAILIAN_CAP_RES };
  }

  // ---- 命名段兜底（未收录模型；能力可能随版本演进，尽可能走上面精确表）----
  if (/(^|[_-])detect([_-]|$)/.test(lower) || /-detect\b|detection/i.test(lower)) {
    return { kind: 'detect', label: '检测/预处理模型（不可直接生成，需配套主模型）', input: ['Image'], output: ['判定结果'], modes: [], durations: [5], resolutions: BAILIAN_CAP_RES, direct: false };
  }
  if (/videoretalk/i.test(lower)) {
    return { kind: 'special', label: '视频口型替换·声动人像（人物视频+人声音频）', input: ['Video', 'Audio'], output: ['Video'], modes: [], durations: [5, 10], resolutions: BAILIAN_CAP_RES, direct: false };
  }
  if (/liveportrait/i.test(lower)) {
    return { kind: 'special', label: '图生播报·灵动人像（肖像图片+人声音频）', input: ['Image', 'Audio'], output: ['Video'], modes: [], durations: [5, 10], resolutions: BAILIAN_CAP_RES, direct: false };
  }
  if (/animate-anyone|^animate-/i.test(lower)) {
    return { kind: 'special', label: '舞动人像 AnimateAnyone（需配套 detect/template 前置）', input: ['Image', 'Video'], output: ['Video'], modes: [], durations: [5], resolutions: BAILIAN_CAP_RES, direct: false };
  }

  // 标准视频生成模型（未逐个核实，按官方命名段回溯）
  if (/(^|[_-])r2v([_-]|$)/i.test(lower)) {
    return { kind: 'r2v', label: '参考生视频', input: ['Image', 'Video', 'Text', 'Audio'], output: ['Video'], modes: [BAILIAN_MODE_REF], durations: BAILIAN_CAP_DEFAULT_DUR, resolutions: BAILIAN_CAP_RES, direct: true };
  }
  if (/(^|[_-])kf2v([_-]|$)/i.test(lower)) {
    return { kind: 'kf2v', label: '首尾帧生成', input: ['Image', 'Text'], output: ['Video'], modes: [BAILIAN_MODE_FIRST_LAST], durations: BAILIAN_CAP_DEFAULT_DUR, resolutions: BAILIAN_CAP_RES, direct: true };
  }
  if (/(^|[_-])i2v([_-]|$)/i.test(lower)) {
    return { kind: 'i2v', label: '图生视频', input: ['Image', 'Text', 'Audio'], output: ['Video'], modes: [BAILIAN_MODE_I2V, BAILIAN_MODE_FIRST_LAST], durations: BAILIAN_CAP_DEFAULT_DUR, resolutions: BAILIAN_CAP_RES, direct: true };
  }
  if (/(^|[_-])t2v([_-]|$)/i.test(lower)) {
    return { kind: 't2v', label: '文生视频', input: ['Text', 'Audio'], output: ['Video'], modes: [BAILIAN_MODE_T2V], durations: BAILIAN_CAP_DEFAULT_DUR, resolutions: BAILIAN_CAP_RES, direct: true };
  }

  // 兜底：未识别类型的视频模型，仅展示、不可直接生成
  return { kind: 'special', label: '视频模型（模式未识别）', input: ['Text'], output: ['Video'], modes: [], durations: [5], resolutions: BAILIAN_CAP_RES, direct: false };
}

/** 生成模式 → 单元统一值（0=文生, 1=图生首帧, 2=首尾帧；参考映射到图生/参考语义） */
export function bailianVideoImageCount(mode: BailianVideoMode): number {
  switch (mode) {
    case "first_last":
      return 2;
    case "img2video":
    case "multi_ref":
      return 1;
    default:
      return 0;
  }
}

/** 百炼视频生成静态模型目录（兜底目录；优先用账号捕获的 freeTiers 实时目录）。 */
export interface BailianVideoModelMeta {
  /** 模型名：wan2.7-t2v-2026-06-12 等 */
  model: string;
  /** 类型：文生 / 首帧图生 / 参考生 */
  type: "t2v" | "i2v" | "r2v";
  /** 是否免费（官方实测：t2v/r2v 有免费，i2v 无免费按量付费） */
  free: boolean;
  /** 支持时长档位（秒） */
  durations: number[];
  /** 分辨率取值（720P/1080P） */
  resolutions: string[];
  /** 支持的生成模式 */
  modes: Array<{ value: BailianVideoMode; label: string }>;
}

/** 视频生成可选参数（补充 prompt 之外的结构化字段）。 */
export interface BailianGenerateOptions {
  mode: BailianVideoMode;
  model: string;
  prompt?: string;
  /** 图生/首尾/参考：公网 https 图片 URL 数组（首帧 1 / 首尾 2 / 参考 1+） */
  images?: string[];
  /** 参考生（r2v）：公网 https 视频 URL 数组，与 images 合入 input.media[]（reference_video） */
  videos?: string[];
  /** 视频时长（秒，整数） */
  durationSec?: number;
  /** 分辨率：'720' | '1080'（调度台写法），落 API 时映射为 '720P' / '1080P' */
  resolution?: string;
  /** 画幅比例：16:9 / 9:16 / 1:1 / 4:3 / 3:4 */
  ratio?: string;
  /** 是否生成有声视频：'on'（默认）/ 'off' */
  audio?: "on" | "off";
  /** 附加音频 URL（备用字段，暂不启用） */
  promptAudioUrl?: string;
}

export interface BailianGenerateResult {
  ok: boolean;
  videoUrl?: string;
  coverImageUrl?: string;
  /** 异步任务 task_id */
  traceId?: string;
  model: string;
  error?: string;
  /** 免费额度用尽（403 AllocationQuota.FreeTierOnly） */
  freeTierExhausted?: boolean;
}

/** DashScope 异步视频生成：提交 → 轮询 → 解析视频 URL。
 *  onProgress 用于桌面调度台实时推送过程提示（提交/轮询阶段）。
 *  轮询遵守高频轮询约束：固定间隔 ≥10s、带超时上限，不做无痕高频刷。 */
export async function bailianGenerateWithKey(
  apiKey: string,
  opts: BailianGenerateOptions,
  onProgress?: (message: string) => void,
): Promise<BailianGenerateResult> {
  const key = (apiKey ?? "").trim();
  if (!key) return { ok: false, model: opts.model, error: "阿里云百炼 API Key 缺失" };
  const startedAt = Date.now();
  const { mode, model } = opts;
  const imgs = (opts.images ?? []).filter((u) => /^https?:\/\//i.test(String(u).trim()));
  const need = bailianVideoImageCount(mode);
  // 参考生（multi_ref）：实测当前 r2v 快照 media[] 仅收图片、不收 mp4，故按图片数校验（至少 1 张）；其余模式按图片数校验
  const needOk =
    mode === "multi_ref" ? imgs.length >= 1 : need > 0 ? imgs.length >= need : true;
  if (!needOk) {
    return {
      ok: false,
      model,
      error:
        need === 2
          ? "首尾帧生成需要上传首帧和尾帧共 2 张图片"
          : mode === "multi_ref"
            ? "参考生视频需要至少上传 1 张参考图或参考视频"
            : "图生视频需要至少上传 1 张首帧图片",
    };
  }

  // 构建请求体：input + parameters（协议骨架见方案 §3.2，字段名以实测为准）
  const input: Record<string, unknown> = { prompt: (opts.prompt ?? "").trim() || "生成一段视频" };
  if (mode === "img2video" && imgs.length >= 1) input["img_url"] = imgs[0];
  if (mode === "first_last" && imgs.length >= 2) {
    input["img_url"] = imgs[0];
    input["img2_url"] = imgs[1];
  }
  // 参考生（r2v）：官方「参考生视频 API 参考」确认使用 input.media[]（公网 http/https）。
  // 实测（2026-08-21）：当前账号/地域的 r2v 快照，其 media[].type 只接受 "reference_image"，
  // 且媒体内容仅支持图片格式（jpeg/jpg/png/bmp/webp），不接受 mp4 视频
  // （传视频/标 reference_video 均报错，见 bailianModelInputs 注释）。故此处仅按图片组装。
  // 图片合计 ≤5；与图片类 img_url（仅 i2v 首帧字段）不同，r2v 不得沿用 img_url。
  if (mode === "multi_ref" && imgs.length > 0) {
    const media = imgs
      .slice(0, 5)
      .map((url) => ({ type: "reference_image" as const, url }));
    if (media.length > 0) input["media"] = media;
  }

  // 文生视频支持音频参考：官方「万相2.7-文生视频 API 参考」确认 input.audio_url（公网 http/https）。
  // 仅当模型能力含 Audio 且传入合法 https URL 时才下发，避免对不支持音频的模型发出无效传参。
  if (mode === "text2video" && bailianModelCap(model).input.includes("Audio")) {
    const audioUrl = (opts.promptAudioUrl ?? "").trim();
    if (/^https?:\/\//i.test(audioUrl)) input["audio_url"] = audioUrl;
  }

  const parameters: Record<string, unknown> = {};
  const resMap: Record<string, string> = { "720": "720P", "1080": "1080P" };
  if (opts.resolution && resMap[opts.resolution]) parameters["resolution"] = resMap[opts.resolution];
  if (opts.ratio) parameters["ratio"] = opts.ratio;
  const dur = Number(opts.durationSec);
  if (Number.isFinite(dur) && dur > 0) parameters["duration"] = dur;
  // 配音：默认有声；audio='off' 时关配音
  if ((opts.audio ?? "on") === "off") parameters["with_audio"] = false;
  parameters["prompt_extend"] = true;
  parameters["watermark"] = false;

  const body: Record<string, unknown> = { model, input, parameters };
  const genLog = (msg: string, extra?: unknown): void => {
    console.log(`[qf-bailian] GEN ${msg}`, extra === undefined ? "" : JSON.stringify(extra));
  };

  try {
    onProgress?.(`正在提交到阿里云百炼（${model}）…`);
    genLog(`submit mode=${mode} model=${model}`, { imgs: imgs.length, resolution: parameters["resolution"], duration: parameters["duration"] });
    const submit = await fetch(BAILIAN_VIDEO_SYNTH_BASE_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
        "X-DashScope-Async": "enable",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20000),
    });
    const submitRaw: unknown = await submit.json().catch(() => null);
    const submitData = (submitRaw && typeof submitRaw === "object" ? submitRaw : {}) as Record<string, unknown>;
    if (!submit.ok) {
      // 权威区分：免费额度用尽返回 403；其余再透出错误信息
      const errObj = (submitData["code"] ? submitData : submitData["error"] || submitData["message"]) as
        | Record<string, unknown>
        | string
        | undefined;
      const code = typeof submitData["code"] === "string" ? submitData["code"] : "";
      const fullErr = String(
        typeof errObj === "string"
          ? errObj
          : (errObj && typeof errObj === "object" && typeof (errObj as Record<string, unknown>)["message"] === "string"
              ? (errObj as Record<string, unknown>)["message"]
              : submitData["message"] ?? `HTTP ${submit.status}`),
      );
      const msgText = String(submitData["message"] ?? fullErr);
      genLog(`submit fail status=${submit.status} code=${code} msg=${msgText}`);
      if (submit.status === 403 || /AllocationQuota|FreeTier|免费额度.*用完|额度不足|quota.*exhaust/i.test(msgText)) {
        return {
          ok: false,
          model,
          freeTierExhausted: true,
          error: "该模型免费额度已用完（是否开启『免费额度用完即停』），请核对账号免费额度后重试",
        };
      }
      return { ok: false, model, error: `阿里云百炼提交失败: ${msgText}${submit.status === 429 ? "（限流，请稍后再试）" : ""}` };
    }
    const rawTaskId = submitData["output"] && typeof submitData["output"] === "object"
      ? (submitData["output"] as Record<string, unknown>)["task_id"]
      : undefined;
    const taskId = typeof rawTaskId === "string" && rawTaskId ? rawTaskId : undefined;
    if (!taskId) {
      genLog("submit ok but no task_id", submitData);
      return { ok: false, model, error: "阿里云百炼提交响应缺少 task_id" };
    }

    onProgress?.("提交成功，正在生成视频…");
    const poll = await pollBailianTask(key, taskId, { startedAt, model, onProgress });
    return poll;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    genLog(`uncaught ${msg}`);
    return { ok: false, model, error: msg };
  }
}

/** 轮询配置：固定 ≥10s 间隔 + 超时上限（避免高频轮询） */
const BAILIAN_POLL_INTERVAL_MS = 10_000;
const BAILIAN_POLL_MAX = 60; // ≈10 分钟上限

export async function pollBailianTask(
  apiKey: string,
  taskId: string,
  ctx?: { startedAt?: number; model?: string; onProgress?: (msg: string) => void },
): Promise<BailianGenerateResult> {
  const model = ctx?.model ?? "";
  const key = (apiKey ?? "").trim();
  const startedAt = ctx?.startedAt ?? Date.now();
  const genLog = (msg: string, extra?: unknown): void => {
    console.log(`[qf-bailian] GEN ${msg}`, extra === undefined ? "" : JSON.stringify(extra));
  };
  let polls = 0;
  for (;;) {
    await new Promise((r) => setTimeout(r, BAILIAN_POLL_INTERVAL_MS));
    polls++;
    let data: Record<string, unknown>;
    try {
      const res = await fetch(`${BAILIAN_TASK_BASE_URL}/${taskId}`, {
        method: "GET",
        headers: { Authorization: `Bearer ${key}` },
        signal: AbortSignal.timeout(15000),
      });
      const rawPoll: unknown = await res.json().catch(() => null);
      data = (rawPoll && typeof rawPoll === "object" ? rawPoll : {}) as Record<string, unknown>;
    } catch {
      if (polls >= BAILIAN_POLL_MAX) {
        return { ok: false, model, error: `阿里云百炼任务轮询超时（约 ${Math.round((Date.now() - startedAt) / 1000)} 秒）` };
      }
      continue;
    }
    // 归一：优先取 output 内字段（新版），否则顶层（旧式/通用任务查询）
    const output = (data["output"] && typeof data["output"] === "object")
      ? (data["output"] as Record<string, unknown>)
      : (data as Record<string, unknown>);
    const uuidStatus = String(
      output["task_status"] ?? output["status"] ?? data["task_status"] ?? data["status"] ?? "UNKNOWN",
    );

    const isDone = (s: string): boolean => /SUCCEEDED|SUCCESS|COMPLETED/i.test(s);
    const isFail = (s: string): boolean => /FAILED|FAIL|CANCELLED|CANCEL|TERMINATED|REJECT/i.test(s);

    if (isDone(uuidStatus)) {
      // 成功视频地址两种结构：新版直接 output.video_url / output.cover_url；旧版 output.results[].url / [].cover_url。
      const safe = (v: unknown): Record<string, unknown> =>
        v && typeof v === "object" ? (v as Record<string, unknown>) : {};
      const directUrl = typeof output["video_url"] === "string" ? String(output["video_url"]) : "";
      const directCover =
        typeof output["cover_url"] === "string"
          ? String(output["cover_url"])
          : typeof output["cover_image_url"] === "string"
            ? String(output["cover_image_url"])
            : "";
      const resultsRaw = output["results"];
      const list: Array<unknown> = Array.isArray(resultsRaw)
        ? (resultsRaw as unknown[])
        : resultsRaw && typeof resultsRaw === "object"
          ? [resultsRaw]
          : [];
      const listVideo = list.find((it) => typeof safe(it)["url"] === "string");
      const listCover = list.find((it) => typeof safe(it)["cover_url"] === "string");
      const video = directUrl || (listVideo ? String(safe(listVideo)["url"]) : "");
      const cover = directCover || (listCover ? String(safe(listCover)["cover_url"]) : "");
      if (!video) {
        genLog(`done but no url status=${uuidStatus}`, data);
        return { ok: false, model, error: "阿里云百炼任务完成但响应缺少视频 url" };
      }
      genLog(`done video_url=${video} polls=${polls}`);
      return {
        ok: true,
        videoUrl: video,
        coverImageUrl: cover || undefined,
        traceId: taskId,
        model,
      };
    }
    if (isFail(uuidStatus)) {
      const rawMsg = String(output["message"] ?? data["message"] ?? output["error"] ?? data["error"] ?? "");
      const userMsg = translateBailianFailMessage(rawMsg);
      genLog(`terminal fail status=${uuidStatus}`, data);
      return { ok: false, model, error: userMsg };
    }
    if (polls >= BAILIAN_POLL_MAX) {
      return { ok: false, model, error: `阿里云百炼任务轮询超时（约 ${Math.round((Date.now() - startedAt) / 1000)} 秒）` };
    }
    ctx?.onProgress?.(`视频生成中（${Math.round((Date.now() - startedAt) / 1000)}s）…`);
  }
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

/** 将阿里云百炼任务失败消息翻译为用户可读的中文提示。
 *  仅覆盖常见/高频业务错误，其余回退为精简版原始信息。
 */
function translateBailianFailMessage(raw: string): string {
  if (!raw) return "阿里云百炼任务失败（未知原因）";
  const msg = raw.trim();

  // 参考音频时长超限（t2v 场景最常见）
  if (/duration.*at most 30s|duration.*should be at most 30|audio.*duration.*30/i.test(msg)) {
    const m = msg.match(/got ([\d.]+)s?/i);
    const got = m ? `（当前 ${m[1]}s）` : "";
    return `参考音频时长需 ≤ 30 秒${got}，请裁剪后重试`;
  }
  // 图片格式/尺寸不支持
  if (/format.*not supported|image.*format/i.test(msg)) {
    return "图片格式或尺寸不符合要求（支持 jpg/png/bmp/webp，单边 ≤ 8000px）";
  }
  if (/image.*resolution|resolution.*invalid|image.*size.*exceed/i.test(msg)) {
    return "图片分辨率或大小不符合要求（单边 240–8000px，≤20MB）";
  }
  // 视频格式/时长问题
  if (/video.*duration|video.*format|mp4.*not supported/i.test(msg)) {
    return "视频文件格式或时长不符合要求（支持 mp4/mov，时长 1–30s）";
  }
  // 图片数量/总数超限
  if (/at most \d+.*images|exceed.*\d+.*images|total.*exceed/i.test(msg)) {
    return "参考图片数量超出限制（最多 5 张）";
  }
  // 角色/主体超限
  if (/at most \d+.*characters|exceed.*character|too many.*character/i.test(msg)) {
    return "参考主体数量超出限制（每个参考素材建议只包含单一主体）";
  }
  // 免费额度用尽
  if (/quota|allocation|free.*tier|exhaust/i.test(msg)) {
    return "免费额度已用完，请更换账号或等待次日额度刷新";
  }
  // Prompt 问题
  if (/prompt.*length|prompt.*exceed|prompt.*too long/i.test(msg)) {
    return "提示词过长（上限 5000 字符），请精简后重试";
  }
  // URL 无法访问
  if (/url.*invalid|url.*not.*accessible|url.*error|cannot.*download/i.test(msg)) {
    return "素材 URL 无法被厂商访问（需为公网 https 链接，建议使用 CDN）";
  }
  // 回退：去掉 URL 等干扰信息，保留核心
  const clean = msg.replace(/https?:\/\/\S+/gi, "[URL]");
  return `阿里云百炼任务失败：${clean}`;
}