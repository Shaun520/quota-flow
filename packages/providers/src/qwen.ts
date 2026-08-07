// 通义千问（万相）真调适配器
// 千问视频生成涉及两个 API：
// 1. chat（提交 prompt）：POST https://chat2.qianwen.com/api/v2/chat（SSE 流式）
//    - 需要阿里风控签名头（bx-ua, bx_et, clt-acs-sign 等），每次动态变化，静态复制几小时后过期
// 2. detail（轮询结果）：GET https://chat2-api.qianwen.com/api/v1/session/req/detail
//    - 只需 cookie + x-xsrf-token + x-deviceid，可静态调用
// 视频 URL 在 detail 响应的 data.response_messages[] 中，
// mime_type == "multi_load/iframe" 的项的 meta_data.multi_load[0].html.sc_html 里，
// 通过正则提取 <video src="...mp4?auth_key=...">
//
// 配置：在项目 data/qwen-auth.json 放置以下字段（通过浏览器 DevTools 抓取）：
// {
//   "cookie": "从 DevTools Network 面板复制完整 Cookie（含 tongyi_sso_ticket）",
//   "deviceId": "x-deviceid 头的值",
//   "xXsrfToken": "x-xsrf-token 头的值",
//   "sessionId": "URL /chat/{sessionId} 中的 sessionId",
//   "topicId": "chat 请求 body 中的 topic_id 字段",
//   "reqId": "用户从浏览器 chat 请求中抓取的 req_id（用于轮询 detail）",
//   "chatHeaders": { ... }  // 风控头（可选，可能过期）
// }

import * as https from "node:https";
import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import type { GenerateOptions, GenerateResult, ProviderCapabilities } from "@quota-flow/core";
import { BaseProvider } from "@quota-flow/core";

const AUTH_PATH = path.resolve(__dirname, "..", "..", "data", "qwen-auth.json");
const CHAT_HOST = "chat2.qianwen.com";
const DETAIL_HOST = "chat2-api.qianwen.com";

export interface QwenAuthConfig {
  cookie: string;
  deviceId: string;
  xXsrfToken: string;
  sessionId: string;
  topicId: string;
  /** 用户从浏览器 chat 请求中抓取的 req_id（用于直接轮询 detail） */
  reqId?: string;
  /** 风控签名头（从 chat 请求头复制，每次动态变化，可能过期） */
  chatHeaders?: Record<string, string>;
}

interface QwenVideo {
  url: string;
  posterUrl: string;
  durationSec: number;
}

function loadAuth(): QwenAuthConfig | null {
  try {
    if (!fs.existsSync(AUTH_PATH)) return null;
    const raw = fs.readFileSync(AUTH_PATH, "utf-8").replace(/^\uFEFF/, "");
    const parsed = JSON.parse(raw) as Partial<QwenAuthConfig>;
    if (!parsed.cookie || !parsed.deviceId || !parsed.sessionId) return null;
    return parsed as QwenAuthConfig;
  } catch {
    return null;
  }
}

function buildCommonHeaders(auth: QwenAuthConfig): Record<string, string> {
  return {
    "accept": "*/*",
    "content-type": "application/json",
    "cookie": auth.cookie,
    "x-deviceid": auth.deviceId,
    "x-platform": "pc_tongyi",
    "x-xsrf-token": auth.xXsrfToken || "",
    "origin": "https://www.qianwen.com",
    "referer": "https://www.qianwen.com/chat/" + auth.sessionId,
    "user-agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36 Edg/151.0.0.0",
  };
}

/** 从 detail 响应中提取视频 URL */
function extractVideoFromDetail(data: unknown): QwenVideo | null {
  const d = data as { data?: { response_messages?: Array<Record<string, unknown>> } };
  if (!d?.data?.response_messages) return null;
  for (const msg of d.data.response_messages) {
    if (msg.mime_type !== "multi_load/iframe") continue;
    const metaData = msg.meta_data as Record<string, unknown> | undefined;
    if (!metaData) continue;
    const multiLoad = metaData.multi_load as Array<Record<string, unknown>> | undefined;
    if (!Array.isArray(multiLoad)) continue;
    for (const item of multiLoad) {
      const html = item.html as Record<string, unknown> | undefined;
      if (!html) continue;
      const scHtml = html.sc_html as string | undefined;
      if (!scHtml) continue;
      // 从 sc_html 中提取 <video src="...mp4?auth_key=...">
      const videoMatch = scHtml.match(/src="(https?:\/\/[^"]+\.mp4[^"]*)"/);
      if (videoMatch) {
        const url = videoMatch[1];
        const posterMatch = scHtml.match(/poster="(https?:\/\/[^"]+\.jpg[^"]*)"/);
        const posterUrl = posterMatch ? posterMatch[1] : "";
        // 提取时长（从 "00:05" 格式）
        let durationSec = 5;
        const durMatch = scHtml.match(/"time-[^"]*"[^>]*>(\d+):(\d+)</);
        if (durMatch) {
          durationSec = parseInt(durMatch[1], 10) * 60 + parseInt(durMatch[2], 10);
        }
        return { url, posterUrl, durationSec };
      }
    }
  }
  return null;
}

/** GET detail API 轮询视频结果 */
async function pollDetail(
  auth: QwenAuthConfig,
  reqId: string,
  opts: { maxPolls: number; intervalMs: number },
): Promise<QwenVideo | null> {
  const params = new URLSearchParams({
    biz_id: "ai_qwen",
    chat_client: "h5",
    device: "pc",
    fr: "pc",
    pr: "qwen",
    ut: auth.deviceId,
    la: "zh-CN",
    tz: "Asia/Shanghai",
    wv: "4.1.4",
    ve: "4.1.4",
    session_id: auth.sessionId,
    req_id: reqId + "_complete",
  });
  const headers = buildCommonHeaders(auth);

  for (let i = 0; i < opts.maxPolls; i++) {
    const result = await new Promise<{ status: number; body: string }>((resolve) => {
      const req = https.request(
        {
          hostname: DETAIL_HOST,
          port: 443,
          path: "/api/v1/session/req/detail?" + params.toString(),
          method: "GET",
          headers,
          timeout: 15000,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
          res.on("end", () => {
            resolve({
              status: res.statusCode ?? 0,
              body: Buffer.concat(chunks).toString("utf-8"),
            });
          });
        },
      );
      req.on("error", () => resolve({ status: 0, body: "" }));
      req.on("timeout", () => { req.destroy(); resolve({ status: 0, body: "" }); });
      req.end();
    });

    if (result.status === 200 && result.body) {
      try {
        const parsed = JSON.parse(result.body);
        if (parsed.code === 0 && parsed.data) {
          const video = extractVideoFromDetail(parsed);
          if (video) return video;
        }
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

/** POST chat API 提交 prompt（SSE 流式），返回 req_id */
async function sendPrompt(
  auth: QwenAuthConfig,
  prompt: string,
  mode: string,
  imageUrl?: string,
): Promise<{ reqId: string; sseTail: string } | null> {
  const reqId = crypto.randomUUID();
  const parentReqId = crypto.randomUUID();
  const nonce = Math.random().toString(36).slice(2, 13);
  const timestamp = Date.now().toString();

  const params = new URLSearchParams({
    biz_id: "ai_qwen",
    fe_version: "1.0.0",
    chat_client: "h5",
    device: "pc",
    fr: "pc",
    pr: "qwen",
    ut: auth.deviceId,
    la: "zh-CN",
    tz: "Asia/Shanghai",
    wv: "4.1.4",
    ve: "4.1.4",
    nonce,
    timestamp,
  });

  const attachments = imageUrl ? [{ type: "image", materialId: "placeholder" }] : [];
  const bizData = JSON.stringify({
    req: {
      rootModel: "wan27",
      prompt,
      originPrompt: prompt,
      genMode: imageUrl ? "multi_ref" : "t2v",
      params: {
        gen_mode: imageUrl ? "multi_ref" : "t2v",
        duration: 5,
        audio: true,
        resolution: "720P",
        size: "9:16",
        attachments,
      },
    },
    bizScene: "genVideo",
    videoReportParams: {
      scene_agent: "ai_video",
      quota_use: "1",
      video_duration: "5s",
      model: "wan2.7",
      video_ratio: "9:16",
      video_resolution: "720P",
    },
  });

  const messages = imageUrl
    ? [
        { mime_type: "resource/url", content: "", meta_data: { resource_infos: [{ id: "placeholder", file_name: "input.png", file_format: "png", url: imageUrl, width: 1024, height: 1024, index: 0, mime_type: "image/url" }] }, status: "complete" },
        { mime_type: "text/plain", content: prompt, meta_data: { ori_query: prompt }, status: "complete" },
      ]
    : [{ mime_type: "text/plain", content: prompt, meta_data: { ori_query: prompt }, status: "complete" }];

  const bodyObj = {
    req_id: reqId,
    parent_req_id: parentReqId,
    messages,
    scene: "chat",
    sub_scene: "",
    scene_param: "continue_chat",
    session_id: auth.sessionId,
    biz_id: "ai_qwen",
    topic_id: auth.topicId || "",
    model: "Qwen",
    from: "default",
    protocol_version: "v2",
    messages_merge: false,
    chat_client: "h5",
    deep_search: null,
    ai_tool_scene: "zaodian_generate_video",
    temporary: false,
    biz_data: bizData,
    chat_mode: "quick",
    cms_test_data_ids: "",
    bucket: {},
  };
  const bodyStr = JSON.stringify(bodyObj);

  const headers: Record<string, string> = {
    accept: "application/json, text/event-stream, text/plain, */*",
    "content-type": "application/json",
    cookie: auth.cookie,
    origin: "https://www.qianwen.com",
    referer: "https://www.qianwen.com/chat/" + auth.sessionId,
    "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36 Edg/151.0.0.0",
    "x-device-id": auth.deviceId,
    "x-platform": "pc_tongyi",
    prod_id: "tongyi",
    "x-chat-id": reqId,
    "x-chat-biz": JSON.stringify({ chatId: reqId, agentId: "", enableWebp: "", runtimeEnabled: false, debugEnabled: false, htmlRenderV2Allow: false, htmlRenderV3Allow: false, ssrCardV1: false, csrCardV1: false }),
  };
  // 加风控头
  if (auth.chatHeaders) {
    for (const [k, v] of Object.entries(auth.chatHeaders)) {
      if (v) headers[k] = v;
    }
  }
  headers["content-length"] = Buffer.byteLength(bodyStr).toString();

  return new Promise((resolve) => {
    const req = https.request(
      {
        hostname: CHAT_HOST,
        port: 443,
        path: "/api/v2/chat?" + params.toString(),
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
        });
        res.on("end", () => {
          const tail = tailChars.join("").slice(-800);
          // 如果 403 签名错误，返回 null
          if (tail.includes("EX015") || tail.includes("签名错误")) {
            resolve(null);
          } else {
            resolve({ reqId, sseTail: tail });
          }
        });
      },
    );
    req.on("error", (e) => {
      if ((e as Error).message.includes("destroyed") || (e as Error).message.includes("aborted")) {
        resolve({ reqId, sseTail: "" });
      } else {
        resolve(null);
      }
    });
    req.on("timeout", () => { req.destroy(); resolve({ reqId, sseTail: "timeout" }); });
    req.write(bodyStr);
    req.end();
  });
}

export class QwenWanProvider extends BaseProvider {
  readonly id = "qwenwan";
  readonly displayName = "通义万相";

  get capabilities(): ProviderCapabilities {
    return {
      text2video: true,
      img2video: true,
      video2video: false,
      imgs2video: false,
      typicalCostPerCall: 1,
      qualityScore: 3.5,
      limits: {
        text2video: "5s 720P 视频",
        img2video: "图片+描述生视频",
      },
    };
  }

  async generate(options: GenerateOptions): Promise<GenerateResult> {
    const startedAt = Date.now();
    const auth = loadAuth();
    const quotaUsed = this.estimateCost(options);

    if (!auth) {
      return this.dryRunOk(options.mode, {
        warning: "data/qwen-auth.json 未配置，已降级为 dry-run。",
        prompt: options.prompt,
        imageUrl: options.imageUrl,
      }, startedAt, quotaUsed);
    }

    try {
      const { mode } = options;
      if (mode !== "text2video" && mode !== "img2video") {
        return fail(this.id, "mode '" + mode + "' is not supported by " + this.displayName, Date.now() - startedAt);
      }
      if (mode === "text2video" && !options.prompt) {
        return fail(this.id, "text2video requires prompt", Date.now() - startedAt);
      }
      if (mode === "img2video" && !options.imageUrl) {
        return fail(this.id, "img2video requires imageUrl", Date.now() - startedAt);
      }
      const prompt = options.prompt ?? (mode === "img2video" ? "让图片动起来" : "生成5秒视频");

      // 两种模式：
      // A. 有 chatHeaders -> 尝试 CLI 提交 chat（风控头可能过期）
      // B. 有 reqId -> 直接轮询 detail（用户在浏览器提交后提供 req_id）
      let reqId = auth.reqId || "";

      if (!reqId && auth.chatHeaders) {
        // 尝试 CLI 提交
        const chatResult = await sendPrompt(
          auth,
          prompt,
          mode,
          mode === "img2video" ? options.imageUrl : undefined,
        );
        if (chatResult) {
          reqId = chatResult.reqId;
        } else {
          // 风控签名过期
          return {
            ok: false,
            providerId: this.id,
            quotaUsed: 0,
            errorMessage: "千问风控签名已过期（403 签名错误）。请在浏览器中提交视频生成，然后从 Network 面板抓取 req_id 填入 data/qwen-auth.json 的 reqId 字段。",
            durationMs: Date.now() - startedAt,
            raw: { hint: "配置 reqId 后 CLI 可直接轮询 detail 拿视频 URL" },
          };
        }
      }

      if (!reqId) {
        return {
          ok: false,
          providerId: this.id,
          quotaUsed: 0,
          errorMessage: "未配置 reqId 且无法提交 chat（无风控头或已过期）。请在浏览器提交视频生成后，从 chat 请求中复制 req_id 填入 data/qwen-auth.json。",
          durationMs: Date.now() - startedAt,
        };
      }

      // 轮询 detail 拿视频 URL：最多 36 次 * 5 秒 = 3 分钟
      const video = await pollDetail(auth, reqId, { maxPolls: 36, intervalMs: 5000 });

      if (!video || !video.url) {
        return {
          ok: false,
          providerId: this.id,
          quotaUsed: 0,
          errorMessage: "千问轮询 3 分钟未拿到视频 URL（可能还在生成或 req_id 无效）",
          durationMs: Date.now() - startedAt,
          raw: { reqId },
        };
      }

      return {
        ok: true,
        providerId: this.id,
        traceId: "qwen-" + reqId + "-" + Date.now(),
        videoUrl: video.url,
        downloadUrl: video.url,
        quotaUsed,
        qualityScore: this.capabilities.qualityScore,
        durationMs: Date.now() - startedAt,
        raw: {
          mode,
          prompt,
          durationSec: video.durationSec,
          posterUrl: video.posterUrl,
          reqId,
        },
      };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
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
      traceId: "qwen-dryrun-" + Date.now(),
      videoUrl: "https://example.com/qwen-dryrun/" + mode + ".mp4",
      downloadUrl: "https://example.com/qwen-dryrun/" + mode + ".mp4",
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
