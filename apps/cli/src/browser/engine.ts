// CLI 浏览器引擎：用 Playwright(复用系统 Edge) 拉起真实浏览器，在厂商页面内完成
// 登录 → 填 prompt → 发送 → 拦截请求头 → 轮询视频，返回标准 GenerateResult。
// 相比静态 cookie fetch：cookie/reqId/conversationId 这类动态 token 都在真实会话里产生，不易失效。
// 首个版本支持 yuanbao；其余提供商返回明确错误。复用系统 Edge，不额外下载浏览器。

import { chromium, type BrowserContext } from "playwright-core";
import * as fs from "node:fs";
import { dataDir, dataFile } from "@quota-flow/core";
import type { GenerateOptions, GenerateResult } from "@quota-flow/core";

const YUANBAO_CHAT_URL = "https://yuanbao.tencent.com/chat/naQivTmsDa";
const YUANBAO_DETAIL_URL = "https://yuanbao.tencent.com/api/user/agent/conversation/v1/detail";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36";
// 元宝每次视频生成估算扣 1 次（对应核心 ledger 默认每日额度 5）
const YUANBAO_QUOTA = 1;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** 解析系统 Edge 可执行路径：显式覆盖 > 常见安装位置 */
function resolveEdgeChannelOrPath(): { channel?: string; executablePath?: string } {
  const env = process.env.QUOTA_FLOW_EDGE_PATH;
  if (env && fs.existsSync(env)) return { executablePath: env };
  const candidates = [
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return { executablePath: p };
  }
  return { channel: "msedge" };
}

/** 用系统 Edge 启动持久上下文（userDataDir 保存登录态，避免每次重登） */
async function launchEdge(userDataDir: string): Promise<BrowserContext> {
  try {
    return await chromium.launchPersistentContext(userDataDir, {
      headless: false,
      ...resolveEdgeChannelOrPath(),
      viewport: { width: 1280, height: 900 },
      args: ["--auto-open-devtools-for-tabs"],
    });
  } catch (e) {
    throw new Error(`启动 Edge 浏览器失败：${e instanceof Error ? e.message : String(e)}`);
  }
}

export interface BrowserGenerateResultLike {
  result: GenerateResult | null;
  attempts: Array<{ providerId: string; ok: boolean; errorMessage?: string }>;
}

/** 用浏览器引擎执行一次生成（仅 cookie 型厂商）。providerId 暂支持 yuanbao。 */
export async function runBrowserGenerate(
  opts: GenerateOptions,
  providerId: string,
): Promise<BrowserGenerateResultLike> {
  if (providerId !== "yuanbao") {
    return {
      result: {
        ok: false,
        providerId,
        quotaUsed: 0,
        errorMessage: `浏览器模式暂未支持 ${providerId}（当前支持 yuanbao），请使用 --engine fetch`,
        durationMs: 0,
      },
      attempts: [{ providerId, ok: false, errorMessage: "browser engine not implemented" }],
    };
  }
  const result = await runYuanbaoGenerate(opts);
  return { result, attempts: result ? [{ providerId: "yuanbao", ok: result.ok, errorMessage: result.errorMessage }] : [] };
}

/** ---- 元宝浏览器生成 ---- */
interface CapturedRequest {
  conversationId?: string;
  cookie?: string;
  headers?: Record<string, string>;
}

async function runYuanbaoGenerate(opts: GenerateOptions): Promise<GenerateResult> {
  const startedAt = Date.now();
  const userDataDir = dataFile("profiles/yuanbao");
  fs.mkdirSync(userDataDir, { recursive: true });

  let context: BrowserContext | null = null;
  try {
    context = await launchEdge(userDataDir);
    const page = context.pages()[0] ?? (await context.newPage());

    // 拦截元宝 chat / detail 请求，抓 conversationId + 完整请求头（含 cookie）
    const captured: { current: CapturedRequest | null } = { current: null };
    context.on("request", (req) => {
      const url = req.url();
      if (!url.includes(YUANBAO_CHAT_URL) && !url.includes("/api/user/agent/conversation/v1/detail")) return;
      const next: CapturedRequest = { ...captured.current };
      const m = url.match(/\/api\/chat\/([^/?#]+)/);
      if (m) next.conversationId = m[1];
      if (!next.conversationId && url.includes("/api/user/agent/conversation/v1/detail")) {
        try {
          const body = req.postData();
          if (body) {
            const parsed = JSON.parse(body) as Record<string, unknown>;
            if (typeof parsed.conversationId === "string") next.conversationId = parsed.conversationId;
          }
        } catch {
          /* ignore */
        }
      }
      void req.allHeaders().then((h) => {
        next.cookie = h.cookie;
        next.headers = h as Record<string, string>;
        captured.current = next;
      });
      captured.current = next;
    });

    await page.goto(YUANBAO_CHAT_URL, { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => {});

    // 等待登录态：能看到输入框即认为可用；否则提示用户扫码/登录
    process.stdout.write("[browser] 等待元宝页面就绪（如需登录请在弹出的浏览器里完成）…\n");
    const loggedIn = await waitForInput(page, 120000);
    if (!loggedIn) {
      return failYuanbao("未能检测到元宝输入框，可能未登录或在登录页停留过久，请重试（保持弹窗登录后）", startedAt);
    }

    // 填 prompt
    const promptOk = await fillYuanbaoPrompt(page, opts.prompt ?? "");
    if (!promptOk) return failYuanbao("填写元宝输入框失败（页面结构可能已变化）", startedAt);

    // 点发送，等待 chat 请求被捕获
    await clickYuanbaoSend(page);
    const chat = await waitForCaptured(captured, 20000);
    if (!chat?.conversationId) return failYuanbao("未捕获到元宝生成请求（conversationId），请重试", startedAt);

    // 轮询 detail 拿视频 URL
    const video = await pollYuanbaoVideo(chat, 360 * 1000);
    if (!video) return failYuanbao("等待超时未取到元宝视频 URL", startedAt);
    if ("error" in video) {
      return { ok: false, providerId: "yuanbao", quotaUsed: 0, errorMessage: video.error, durationMs: Date.now() - startedAt };
    }
    return {
      ok: true,
      providerId: "yuanbao",
      traceId: chat.conversationId,
      videoUrl: video.downloadUrl || video.url,
      downloadUrl: video.downloadUrl || video.url,
      quotaUsed: YUANBAO_QUOTA,
      qualityScore: 3.5,
      durationMs: Date.now() - startedAt,
      raw: { engine: "browser", conversationId: chat.conversationId },
    };
  } catch (e) {
    return failYuanbao(`浏览器生成异常：${e instanceof Error ? e.message : String(e)}`, startedAt);
  } finally {
    try {
      // 关闭 Context 会保留持久 profile（登录态），下次复用；不销毁 userDataDir
      await context?.close().catch(() => {});
    } catch {
      /* ignore */
    }
  }
}

function failYuanbao(error: string, startedAt: number): GenerateResult {
  return { ok: false, providerId: "yuanbao", quotaUsed: 0, errorMessage: error, durationMs: Date.now() - startedAt };
}

/** 在某页面中寻找可见输入框（textarea / input / contenteditable / [role=textbox]） */
const FIND_INPUT_JS = `(() => {
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none';
  };
  const sels = ['textarea','input:not([type])','input[type="text"]','[contenteditable]','[contenteditable="true"]','[role="textbox"]'];
  for (const s of sels) {
    const els = [...document.querySelectorAll(s)].filter(visible);
    if (els.length) return true;
  }
  return false;
})()`;

async function waitForInput(page: import("playwright-core").Page, timeoutMs: number): Promise<boolean> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const found = await page.evaluate(FIND_INPUT_JS);
      if (found) return true;
    } catch {
      /* iframe/导航中，重试 */
    }
    await sleep(800);
  }
  return false;
}

async function fillYuanbaoPrompt(page: import("playwright-core").Page, prompt: string): Promise<boolean> {
  const json = JSON.stringify(prompt);
  const script = `(() => {
    const visible = (el) => { const r = el.getBoundingClientRect(); const cs = getComputedStyle(el); return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none'; };
    const findInput = () => {
      const sels = ['textarea','input:not([type])','input[type="text"]','[contenteditable]','[contenteditable="true"]','[role="textbox"]'];
      for (const s of sels) { const el = [...document.querySelectorAll(s)].filter(visible)[0]; if (el) return el; }
      return null;
    };
    const el = findInput();
    if (!el) return false;
    el.focus();
    if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') {
      const proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement : window.HTMLInputElement;
      const setter = Object.getOwnPropertyDescriptor(proto.prototype, 'value').set;
      setter.call(el, ${json});
      el.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    }
    const sel = window.getSelection();
    if (sel) { sel.selectAllChildren(el); sel.collapseToEnd(); }
    document.execCommand('insertText', false, ${json});
    el.dispatchEvent(new InputEvent('input', { bubbles: true, data: ${json}, inputType: 'insertText' }));
    return true;
  })()`;
  try {
    return Boolean(await page.evaluate(script));
  } catch {
    return false;
  }
}

async function clickYuanbaoSend(page: import("playwright-core").Page): Promise<void> {
  const script = `(() => {
    const visible = (el) => { const r = el.getBoundingClientRect(); const cs = getComputedStyle(el); return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none'; };
    const canClick = (el) => el.disabled !== true && el.getAttribute('aria-disabled') !== 'true';
    const norm = (s) => (s || '').replace(/\\s+/g, ' ').trim();
    const isSend = (t) => /发送|提交|生成/.test(t) && !/停止/.test(t);
    const cands = [...document.querySelectorAll('button,[role="button"],[class*="send" i]')].filter(visible).filter(canClick);
    const hit = cands.find((el) => isSend(norm(el.getAttribute('aria-label')||'')) || isSend(norm(el.getAttribute('title')||'')) || isSend(norm(el.textContent||'')));
    const target = hit || cands.filter((el) => el.querySelector('svg')).pop();
    if (!target) return false;
    target.click();
    return true;
  })()`;
  try {
    await page.evaluate(script);
  } catch {
    /* ignore */
  }
}

async function waitForCaptured(captured: { current: CapturedRequest | null }, timeoutMs: number): Promise<CapturedRequest | null> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (captured.current?.conversationId) return captured.current;
    await sleep(300);
  }
  return null;
}

type PollOutcome = { url: string; downloadUrl: string } | { error: string } | null;

/** 用捕获到的 cookie + 请求头轮询元宝 detail 接口 */
async function pollYuanbaoVideo(chat: CapturedRequest, maxWaitMs: number): Promise<PollOutcome> {
  const cookie = chat.cookie ?? "";
  const skip = new Set([
    "host", "content-length", "connection", "accept-encoding", "transfer-encoding",
    "upgrade-insecure-requests", "sec-fetch-mode", "sec-fetch-site", "sec-fetch-user", "sec-fetch-dest",
    "sec-ch-ua", "sec-ch-ua-mobile", "sec-ch-ua-platform",
  ]);
  const headers: Record<string, string> = {
    cookie,
    "content-type": "application/json",
    accept: "application/json, text/event-stream, text/plain, */*",
    origin: "https://yuanbao.tencent.com",
    referer: `https://yuanbao.tencent.com/chat/naQivTmsDa/${chat.conversationId}`,
    "user-agent": UA,
  };
  for (const [k, v] of Object.entries(chat.headers ?? {})) {
    if (!skip.has(k.toLowerCase()) && v != null && !(k.toLowerCase() in headers)) headers[k] = v;
  }
  const body = JSON.stringify({ conversationId: chat.conversationId });
  const started = Date.now();
  while (Date.now() - started < maxWaitMs) {
    try {
      const res = await fetch(YUANBAO_DETAIL_URL, {
        method: "POST",
        headers,
        body,
        signal: AbortSignal.timeout(15000),
      });
      if (res.status === 401 || res.status === 403) return { error: "元宝接口返回 401/403，登录态可能失效，请重新登录" };
      if (res.status === 200) {
        const json = (await res.json()) as unknown;
        const video = extractYuanbaoVideo(json);
        if (video) return video;
      }
    } catch {
      /* 单次轮询失败继续 */
    }
    await sleep(5000);
  }
  return null;
}

function extractYuanbaoVideo(data: unknown): { url: string; downloadUrl: string } | null {
  const json = data as { convs?: Array<Record<string, unknown>> };
  if (!Array.isArray(json.convs)) return null;
  const latestAi = [...json.convs].reverse().find((c) => c.speaker === "ai");
  if (!latestAi) return null;
  const speeches = latestAi.speechesV2 as Array<Record<string, unknown>> | undefined;
  if (!Array.isArray(speeches)) return null;
  let fallback: { url: string; downloadUrl: string } | null = null;
  for (const sp of speeches) {
    const extra = (sp.extra ?? {}) as { replaces?: Array<{ multimedias?: Array<Record<string, unknown>> }> };
    for (const rp of extra.replaces ?? []) {
      for (const mm of rp.multimedias ?? []) {
        const url = mm.url as string | undefined;
        if (!url || !url.includes("hunyuan-prod")) continue;
        const candidate = { url, downloadUrl: (mm.downloadUrl as string) || url };
        if (mm.type !== "loadingVideo") return candidate;
        fallback = candidate;
      }
    }
  }
  return fallback;
}