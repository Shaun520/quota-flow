// 阿里云百炼（Model Studio）API Key 型厂商适配器
//
// 本轮只实现「绑定」所需的能力（API Key 校验、账号级指纹、payload 解码），额度/视频生成延后：
//   - 数据面为 Bearer Token 鉴权（Authorization: Bearer <sk-api-key> + X-DashScope-Async: enable），
//     与智谱/火山同为 API Key 型，见 docs/厂商与API平台接入/阿里云百炼接入方案.md §3.2。
//   - 真实免费额度在百炼控制台 costing-balance/free-quota 页（按业务空间维度，见方案 §3.3），API Key
//     能否直读需实测；不可时走控制台会话捕获（复用智谱/火山会话内核）作为后续迭代，本期实际额度走每日账本 daily_total。
//   - decodeBailianPayload 与智谱同构（兼容纯 key 旧格式）：{v:1,apiKey,consoleJwt}。
//
// 日志埋点统一前缀 [qf-bailian]（含 test / fp 子阶段，便于排障）。

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
 * 解阿里云百炼加密负载（兼容多种格式）：
 * - 新版：{ v: 1; apiKey: string; consoleJwt?: string | null } JSON 字符串
 * - 旧版：纯 API Key 字符串（非 `{` 开头）
 */
export function decodeBailianPayload(decrypted: string): {
  apiKey: string;
  consoleJwt?: string | null;
} {
  const trimmed = (decrypted ?? "").trim();
  if (!trimmed.startsWith("{")) return { apiKey: trimmed };
  try {
    const parsed = JSON.parse(trimmed) as {
      v?: number;
      apiKey?: string;
      consoleJwt?: string | null;
      // 兼容后续会话捕获写入的占位字段（本轮为空）
      workspaceId?: string | null;
    };
    const apiKey = parsed.apiKey?.trim() ?? "";
    let consoleJwt = parsed.consoleJwt ?? null;
    if (typeof consoleJwt === "string" && consoleJwt) {
      try {
        consoleJwt = decodeURIComponent(consoleJwt);
      } catch {}
    }
    return { apiKey, consoleJwt };
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
 * 百炼免费额度按「业务空间（WorkspaceId）」与阿里云账号维度划分，AccountId/Workspace 为更优去重键；
 * 但本期未接控制台会话（拿不到 WorkspaceId），按 API Key 明文哈希回退（与智谱 customerId 兜底策略一致）。
 * payload 为「加密前明文」，可能是 `{v:1,apiKey,consoleJwt}` 或纯 API Key。
 */
export async function bailianAccountFingerprint(payload: string): Promise<string | null> {
  const { apiKey } = decodeBailianPayload(payload);
  if (!apiKey) return null;
  // TODO: 后续接入控制台会话（costing-balance）后可从中解析 WorkspaceId，按
  //     fingerprintFor("bailian", "bailian-account:" + workspaceId) 生成账号级指纹，对齐智谱 customerId 策略。
  return fingerprintFor("bailian", apiKey);
}

/**
 * 校验阿里云百炼 API Key 是否有效（不产生任何生成费用）：
 * 请求一个不存在的只读任务查询端点，用状态码区分鉴权——无效 key 返回 401，有效 key 返回业务错误(404 等)。
 * 仅把 401 视为"无效"，其余 HTTP 响应视为鉴权已通过（Key 有效）。
 * ⚠️ 探测端点待实测确认（见方案 §5.3）；若该域对该格式请求行为异常，按 401 之外均视有效即可。
 */
export async function testBailianApiKey(
  apiKey: string,
): Promise<{ ok: boolean; error?: string }> {
  const key = (apiKey ?? "").trim();
  if (!key) return { ok: false, error: "请先输入 API Key" };
  try {
    // 用一个不可能存在的任务 id 触发查询：有效 key 不会因此扣费，且能区分鉴权是否通过
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