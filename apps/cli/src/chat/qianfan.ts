// OpenAI 兼容 Chat Completions 客户端（SSE 流式）。对外默认端点用硅基流动免费 GLM-4-9B；
// 也兼容智谱/千帆。模型/端点/分片结构由平台决定，本模块采用防御式解析 + 限流退避重试。

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface StreamChatOptions {
  messages: ChatMessage[];
  /** 平台 API Key（如硅基 sk-...）。运行时从 env 读取，不写死。 */
  apiKey: string;
  baseUrl?: string;
  model?: string;
  timeoutMs?: number;
  /** 每个内容增量回调 */
  onToken?: (token: string) => void;
}

// 默认端点：硅基流动免费模型 THUDM/GLM-4-9B-0414（9B 以下永久免费不限量，官方 Rate Limits 高，国内低延迟）。
// 实测(2026-08-25)：账号 GET /v1/models 可用；流式首 token ~270ms、完成 ~600ms。Qwen3-8B 实测首 token ~18s（慢），故不用。
// 可用 QIANFAN_BASE_URL / QIANFAN_MODEL 环境变量覆盖（QIANFAN 前缀仅为兼容历史命名）。
const DEFAULT_BASE_URL = "https://api.siliconflow.cn/v1";
const DEFAULT_MODEL = "THUDM/GLM-4-9B-0414";

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** 逐 token 累积并 onToken 回调，返回完整文本 */
export async function streamChat(opts: StreamChatOptions): Promise<{ content: string; toolCalls: Array<{ name: string; args: Record<string, string> }>; }> {
  const base = (process.env.QIANFAN_BASE_URL || opts.baseUrl || DEFAULT_BASE_URL).replace(/\/$/, "");
  const url = `${base}/chat/completions`;
  const maxRetries = 2; // 免费档偶发 429/5xx，指数退避重试自愈，避免打断对话

  let content = "";
  const toolCalls: Array<{ name: string; args: Record<string, string> }> = [];
  let buf = "";
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 60000);

  try {
    const body = JSON.stringify({
      model: process.env.QIANFAN_MODEL || opts.model || DEFAULT_MODEL,
      stream: true,
      messages: opts.messages,
    });

    let res: Response;
    for (let attempt = 0; ; attempt++) {
      try {
        res = await fetch(url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${opts.apiKey}`,
          },
          body,
          signal: controller.signal,
        });
      } catch (e) {
        if (attempt >= maxRetries) throw e instanceof Error ? e : new Error(String(e));
        await sleep(600 * 2 ** attempt);
        continue;
      }
      if (res.ok && res.body) break;
      const errText = await res.text().catch(() => "");
      const retriable = res.status === 429 || res.status >= 500;
      if (!retriable || attempt >= maxRetries) {
        throw new Error(`对话接口 ${res.status}: ${errText || res.statusText}`);
      }
      await sleep(600 * 2 ** attempt);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();

    // 逐分片读，按行切分 SSE `data: {...}` 事件
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (line.startsWith("data:")) {
          const payload = line.slice(5).trim();
          if (payload === "[DONE]") { buf = ""; break; }
          if (!payload) continue;
          try {
            const j = JSON.parse(payload) as {
              choices?: Array<{ delta?: { content?: string | null } }>;
            };
            const d = j?.choices?.[0]?.delta?.content;
            if (typeof d === "string" && d) {
              content += d;
              opts.onToken?.(d);
            }
          } catch {
            /* 忽略单条异常事件，继续下行 */
          }
        }
      }
    }
  } finally {
    clearTimeout(timer);
  }

  // 从累加文本中提取 CMD 工具块（约定标记，不依赖模型原生 function calling）
  const re = /CMD:\s*\{([\s\S]*?)\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    try {
      const obj = JSON.parse(`{${m[1]}}`) as { name?: unknown; args?: unknown };
      if (typeof obj.name === "string") {
        toolCalls.push({
          name: obj.name,
          args: obj.args && typeof obj.args === "object" ? (obj.args as Record<string, string>) : {},
        });
      }
    } catch {
      /* 跳过无法解析的工具块 */
    }
  }

  return { content, toolCalls };
}

/** 把 user 侧（含 tab/换行）内容安全地交给模型，避免 JSON 转义问题（由调用方直接放 messages） */