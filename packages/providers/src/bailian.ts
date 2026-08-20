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
  if (need > 0 && imgs.length < need) {
    return {
      ok: false,
      model,
      error:
        need === 2
          ? "首尾帧生成需要上传首帧和尾帧共 2 张图片"
          : mode === "multi_ref"
            ? "参考生视频需要至少上传 1 张参考图"
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
  if (mode === "multi_ref" && imgs.length >= 1) input["img_url"] = imgs[0];

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
      const reasonRaw = output["message"] ?? data["message"] ?? output["error"] ?? data["error"] ?? uuidStatus;
      genLog(`terminal fail status=${uuidStatus}`, data);
      return { ok: false, model, error: `阿里云百炼任务${String(reasonRaw)}` };
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