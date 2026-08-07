// 元宝混元真调适配器
// 通过 POST /api/chat/:cid（SSE流式）提交 prompt，再轮询 /api/user/agent/conversation/v1/detail
// 提取 hunyuan COS 上的视频 URL。
// 配置：在项目 data/yuanbao-auth.json 放置以下字段（通过浏览器 DevTools 抓取）：
// {
//   "cookie": "从 DevTools > Application > Cookies 复制全部 cookie（或 Network 面板复制请求头里的 Cookie）",
//   "agentId": "URL 中 /chat/:agentId/:conversationId 的第一段，例如 naQivTmsDa",
//   "conversationId": "URL 中的第二段，例如 0PPry88dMzQ",
//   "xDeviceId": "X-device-id 头（可选，从 getYbCommonHeaders 里拿）",
//   "xHY92": "X-HY92 头（可选）",
//   "xHY93": "X-HY93 头（可选）"
// }
// 如果找不到配置文件或 cookie 为空，自动降级到 dry-run，避免阻塞调度。

import * as https from "node:https";
import * as fs from "node:fs";
import * as path from "node:path";
import type { GenerateOptions, GenerateResult, ProviderCapabilities } from "@quota-flow/core";
import { BaseProvider } from "@quota-flow/core";

const AUTH_PATH = path.resolve(__dirname, "..", "..", "data", "yuanbao-auth.json");
const BASE_HOST = "yuanbao.tencent.com";

export interface YuanbaoAuthConfig {
  cookie: string;
  agentId: string;
  conversationId: string;
  /** 从 window.$webApi.getYbCommonHeaders() 返回的完整对象，原样传入，避免头名/值写死不一致 */
  commonHeaders?: Record<string, unknown>;
  /** 兼容老配置（无 commonHeaders 时生效） */
  xDeviceId?: string;
  xHY92?: string;
  xHY93?: string;
}

interface PolledVideo {
  url: string;
  downloadUrl: string;
  durationSec: number;
  topic: string;
}

function loadAuth(): YuanbaoAuthConfig | null {
  try {
    if (!fs.existsSync(AUTH_PATH)) return null;
    const raw = fs.readFileSync(AUTH_PATH, "utf-8");
    const parsed = JSON.parse(raw) as Partial<YuanbaoAuthConfig>;
    if (!parsed.cookie || !parsed.agentId || !parsed.conversationId) return null;
    return parsed as YuanbaoAuthConfig;
  } catch {
    return null;
  }
}

function buildHeaders(auth: YuanbaoAuthConfig): Record<string, string> {
  const h: Record<string, string> = {};
  // 先展开 $webApi.getYbCommonHeaders() 拿到的头（原封不动，避免值/大小写不一致）
  if (auth.commonHeaders && typeof auth.commonHeaders === "object") {
    for (const [k, v] of Object.entries(auth.commonHeaders)) {
      if (v == null) continue;
      if (typeof v === "string" || typeof v === "number") h[k] = String(v);
    }
  }
  // 必传字段覆盖（优先级 > commonHeaders）
  h["content-type"] = "application/json";
  h["accept"] = "application/json, text/event-stream, text/plain, */*";
  h["origin"] = "https://yuanbao.tencent.com";
  h["referer"] = `https://yuanbao.tencent.com/chat/${auth.agentId}/${auth.conversationId}`;
  h["user-agent"] =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
  h["cookie"] = auth.cookie;
  // 兜底：无 commonHeaders 时补最少的兼容头
  const hasKey = (name: string) => Object.keys(h).some((k) => k.toLowerCase() === name.toLowerCase());
  if (!hasKey("x-source")) h["x-source"] = "web";
  if (!hasKey("x-language")) h["x-language"] = "zh-CN";
  if (!hasKey("x-webdriver")) h["x-webdriver"] = "0";
  if (!hasKey("x-ybuitest")) h["x-ybuitest"] = "0";
  if (!hasKey("x-device-id") && auth.xDeviceId) h["x-device-id"] = auth.xDeviceId;
  if (!hasKey("x-hy92") && auth.xHY92) h["x-hy92"] = auth.xHY92;
  if (!hasKey("x-hy93") && auth.xHY93) h["x-hy93"] = auth.xHY93;
  return h;
}

function postJson(
  pathname: string,
  auth: YuanbaoAuthConfig,
  body: unknown,
  timeoutMs = 60000,
): Promise<{ status: number; body: string; headers: Record<string, string | string[] | undefined> }> {
  const bodyStr = typeof body === "string" ? body : JSON.stringify(body);
  const headers = buildHeaders(auth);
  headers["content-length"] = Buffer.byteLength(bodyStr).toString();
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        host: BASE_HOST,
        port: 443,
        path: pathname,
        method: "POST",
        headers,
        timeout: timeoutMs,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
        res.on("end", () => {
          resolve({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf-8"),
            headers: res.headers as Record<string, string | string[] | undefined>,
          });
        });
      },
    );
    req.on("error", (e) => reject(e));
    req.on("timeout", () => {
      req.destroy(new Error("request timeout"));
    });
    req.write(bodyStr);
    req.end();
  });
}

async function updateModel(auth: YuanbaoAuthConfig): Promise<void> {
  const body = {
    cid: auth.conversationId,
    chatModelId: "hunyuan_gpt_175B_0404",
    chatModelExtInfo:
      '{"modelId":"hunyuan_gpt_175B_0404","subModelId":"","supportFunctions":{}}',
  };
  await postJson("/api/user/agent/conversation/updateModel", auth, body, 10000);
}

/** 提交 prompt（SSE），返回 SSE 的 XHR 响应尾部文本（或空），通常立即 resolve，不等待整个 SSE 结束。 */
async function sendPrompt(auth: YuanbaoAuthConfig, prompt: string, imageUrl?: string): Promise<string> {
  const multimedia = imageUrl
    ? [
        {
          url: imageUrl,
          type: "image",
        },
      ]
    : [];
  const chatModelExtInfo = JSON.stringify({
    modelId: "hunyuan_gpt_175B_0404",
    subModelId: "",
    supportFunctions: { internetSearch: "" },
    internetSearch: "autoInternetSearch",
  });
  const body = {
    model: "gpt_175B_0404",
    prompt,
    plugin: "Adaptive",
    displayPrompt: prompt,
    displayPromptType: 1,
    agentId: auth.agentId,
    isTemporary: false,
    projectId: "",
    chatModelId: "hunyuan_gpt_175B_0404",
    supportFunctions: ["openAutoSearchSwitch", "autoInternetSearch"],
    docOpenid: "",
    options: {
      imageIntention: {
        needIntentionModel: true,
        backendUpdateFlag: 2,
        intentionStatus: true,
      },
    },
    multimedia,
    supportHint: 1,
    chatModelExtInfo,
    applicationIdList: [],
    chatSource: "prompt",
    version: "v2",
    extReportParams: null,
    isAtomInput: false,
    conversationId: auth.conversationId,
    offsetOfHour: 8,
    offsetOfMinute: 0,
  };
  const headers = buildHeaders(auth);
  const bodyStr = JSON.stringify(body);
  headers["content-length"] = Buffer.byteLength(bodyStr).toString();
  // 用 https.request，接受 text/event-stream；SSE 到达的阶段文本会被我们累积最多 2000 字
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        host: BASE_HOST,
        port: 443,
        path: `/api/chat/${auth.conversationId}`,
        method: "POST",
        headers,
        timeout: 180000,
      },
      (res) => {
        const chunks: Buffer[] = [];
        const tailChars: string[] = [];
        res.on("data", (c) => {
          const buf = Buffer.isBuffer(c) ? c : Buffer.from(c);
          chunks.push(buf);
          const s = buf.toString("utf-8");
          tailChars.push(s.slice(-600));
          // 当 sse 到达 success 阶段就提前 resolve（不等待 SSE 长连接关闭）
          if (s.includes("视频已生成") || s.includes("success")) {
            try { req.destroy(); } catch { /* noop */ }
            resolve(tailChars.join("").slice(-800));
          }
        });
        res.on("end", () => {
          resolve(tailChars.join("").slice(-800));
        });
      },
    );
    req.on("error", (e) => {
      // 如果我们提前 destroy()，会触发 error，忽略
      if ((e as Error).message.includes("destroyed") || (e as Error).message.includes("aborted")) {
        resolve("");
      } else {
        reject(e);
      }
    });
    req.on("timeout", () => req.destroy(new Error("send timeout")));
    req.write(bodyStr);
    req.end();
  });
}

/** 从 detail 响应 JSON 中提取最终视频 URL（跳过 loadingVideo 类型占位） */
function extractVideoFromDetail(data: unknown): PolledVideo | null {
  const d = data as { convs?: Array<Record<string, unknown>> };
  if (!d || !Array.isArray(d.convs)) return null;
  const latestAi = [...d.convs].reverse().find((c) => c.speaker === "ai");
  if (!latestAi) return null;
  const speeches = latestAi.speechesV2 as Array<Record<string, unknown>> | undefined;
  if (!Array.isArray(speeches)) return null;
  let best: PolledVideo | null = null;
  for (const sp of speeches) {
    const extra = (sp.extra ?? {}) as Record<string, unknown>;
    const replaces = (extra.replaces ?? []) as Array<Record<string, unknown>>;
    for (const rp of replaces) {
      const mms = (rp.multimedias ?? []) as Array<Record<string, unknown>>;
      for (const mm of mms) {
        const url = mm.url as string | undefined;
        if (!url || !url.includes("hunyuan-prod")) continue;
        const dur = ((mm.ext as Record<string, unknown>)?.videoDuration as number) ?? 0;
        const type = mm.type as string | undefined;
        const candidate: PolledVideo = {
          url,
          downloadUrl: (mm.downloadUrl as string) || url,
          durationSec: typeof dur === "number" ? dur : 0,
          topic: (rp.topic as string) || "",
        };
        // 非 loadingVideo 类型才算真正产出
        if (type !== "loadingVideo") return candidate;
        best = candidate;
      }
    }
  }
  return best;
}

async function pollDetail(
  auth: YuanbaoAuthConfig,
  opts: { maxPolls: number; intervalMs: number },
): Promise<PolledVideo | null> {
  for (let i = 0; i < opts.maxPolls; i++) {
    const r = await postJson(
      "/api/user/agent/conversation/v1/detail",
      auth,
      { conversationId: auth.conversationId },
      15000,
    );
    if (r.status === 200 && r.body) {
      try {
        const parsed = JSON.parse(r.body);
        const v = extractVideoFromDetail(parsed);
        if (v) return v;
      } catch {
        // continue polling
      }
    }
    if (i < opts.maxPolls - 1) {
      await new Promise((r) => setTimeout(r, opts.intervalMs));
    }
  }
  return null;
}

export class YuanbaoProvider extends BaseProvider {
  readonly id = "yuanbao";
  readonly displayName = "元宝混元";

  get capabilities(): ProviderCapabilities {
    return {
      // 元宝基于 HunyuanVideo 1.5：支持一句话生视频 + 一张图生视频
      text2video: true,
      img2video: true,
      video2video: false,
      imgs2video: false,
      typicalCostPerCall: 1,
      qualityScore: 3.0,
      limits: {
        text2video: "5-10s 高清视频",
        img2video: "一张图生视频",
      },
    };
  }

  async generate(options: GenerateOptions): Promise<GenerateResult> {
    const startedAt = Date.now();
    const auth = loadAuth();
    const quotaUsed = this.estimateCost(options);

    // 没有配置则降级到 dry-run
    if (!auth) {
      return this.dryRunOk(options.mode, {
        warning: "data/yuanbao-auth.json 未配置，已降级为 dry-run。",
        prompt: options.prompt,
        imageUrl: options.imageUrl,
      }, startedAt, quotaUsed);
    }

    try {
      const { mode } = options;
      if (mode !== "text2video" && mode !== "img2video") {
        return fail(this.id, `mode '${mode}' is not supported by ${this.displayName}`, Date.now() - startedAt);
      }
      if (mode === "text2video" && !options.prompt) {
        return fail(this.id, "text2video requires prompt", Date.now() - startedAt);
      }
      if (mode === "img2video" && !options.imageUrl) {
        return fail(this.id, "img2video requires imageUrl", Date.now() - startedAt);
      }
      const prompt = options.prompt ?? (mode === "img2video" ? "让图片动起来" : "生成视频");

      try { await updateModel(auth); } catch { /* 不阻塞 */ }
      const sseTail = await sendPrompt(auth, prompt, mode === "img2video" ? options.imageUrl : undefined);

      // 轮询详情拿视频 URL：最多 36 次 * 5 秒 = 3 分钟
      const video = await pollDetail(auth, { maxPolls: 36, intervalMs: 5000 });

      if (!video || !video.url) {
        return {
          ok: false,
          providerId: this.id,
          quotaUsed: 0,
          errorMessage: "元宝轮询 3 分钟未拿到最终视频 URL（可能还在生成）",
          durationMs: Date.now() - startedAt,
          raw: { sseTail, note: "可稍后在元宝网站或 detail API 查看" },
        };
      }

      return {
        ok: true,
        providerId: this.id,
        traceId: `yuanbao-${auth.conversationId}-${Date.now()}`,
        videoUrl: video.url,
        downloadUrl: video.downloadUrl,
        quotaUsed,
        qualityScore: this.capabilities.qualityScore,
        durationMs: Date.now() - startedAt,
        raw: {
          mode,
          prompt,
          durationSec: video.durationSec,
          topic: video.topic,
          sseTail: sseTail.slice(0, 300),
        },
      };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      // 401 / cookie 过期场景：自动降级 dry-run，记录报错
      if (msg.includes("401") || msg.includes("Unauthorized") || msg.includes("登录")) {
        return this.dryRunOk(
          options.mode,
          { warning: "cookie 可能已过期，降级 dry-run。原错误：" + msg, prompt: options.prompt },
          startedAt,
          0,
        );
      }
      return fail(this.id, msg, Date.now() - startedAt);
    }
  }

  private dryRunOk(
    mode: string,
    payload: Record<string, unknown>,
    startedAt: number,
    quotaUsed = 1,
  ): GenerateResult {
    return {
      ok: true,
      providerId: this.id,
      traceId: `yuanbao-dryrun-${Date.now()}`,
      videoUrl: `https://example.com/yuanbao-dryrun/${mode}.mp4`,
      downloadUrl: `https://example.com/yuanbao-dryrun/${mode}.mp4`,
      quotaUsed,
      qualityScore: this.capabilities.qualityScore,
      durationMs: Date.now() - startedAt,
      raw: payload,
    };
  }
}

function fail(providerId: string, message: string, durationMs = 0): GenerateResult {
  return {
    ok: false,
    providerId,
    quotaUsed: 0,
    errorMessage: message,
    durationMs,
  };
}
