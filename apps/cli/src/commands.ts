// 命令业务逻辑：被两种入口复用的纯函数模块（无副作用，不执行命令）。
//   1) cli.ts（commander 子命令入口）
//   2) repl.ts（交互式 UI 入口）
// 这里不 import repl，避免循环；环境变量 .env 由 cli.ts/repl.ts 各自最外层加载。

import * as fs from "node:fs";
import * as path from "node:path";
import { createAuthService } from "@quota-flow/auth";
import { JobService, type JobStatus } from "@quota-flow/db-supabase";
import {
  LEDGER_PATH,
  consume,
  dataFile,
  effectiveStatus,
  loadLedger,
  maybeRollDaily,
  refreshToday,
  remaining,
  saveLedger,
  todayLocal,
} from "@quota-flow/core";
import { Router, type DispatchOptions, type DispatchResult } from "@quota-flow/core";
import type { GenerateOptions, GenerateResult, RoutingStrategy, VideoMode } from "@quota-flow/core";
import { createAllProviders, toProviderMap } from "@quota-flow/providers";
import { runBrowserGenerate } from "./browser/engine";

const JOBS_PATH = dataFile("jobs.jsonl");

/** 汇总对象：生成命令 handleRaw 解析后的原始参数（兼容 commander option 字段） */
export interface GenerateRaw {
  mode?: string;
  prompt?: string;
  imageUrl?: string;
  imageUrls?: string;
  videoUrls?: string;
  voiceUrl?: string;
  bgmUrl?: string;
  bgmVolume?: number | string;
  voiceVolume?: number | string;
  coverImageUrl?: string;
  coverImageDuration?: number | string;
  headerVideoUrl?: string;
  footerVideoUrl?: string;
  strategy?: string;
  provider?: string;
  engine?: string;
  fallbackRounds?: number | string;
  coolDown?: number | string;
  json?: boolean;
}

export async function runCheckQuota(opts: { json?: boolean }, out?: (s: string) => void): Promise<void> {
  const put = out ?? ((s: string) => process.stdout.write(s));
  const ledger = loadLedger();
  const rolled = maybeRollDaily(ledger);
  if (rolled) saveLedger(ledger);

  const rows = Object.entries(ledger.providers).map(([id, e]) => ({
    providerId: id,
    date: e.asOfDate,
    dailyQuota: e.dailyQuota,
    used: e.used,
    remaining: Math.max(0, e.dailyQuota - e.used),
    status: effectiveStatus(ledger, id),
    lastUsedAt: e.lastUsedAt ?? null,
    coolDownUntil: e.coolDownUntil ?? null,
    totalSuccessful: e.totalSuccessful,
    totalFailed: e.totalFailed,
  }));

  const out2 = {
    asOf: new Date().toISOString(),
    timezone: ledger.timezone,
    today: todayLocal(),
    rolled,
    providers: rows,
  };
  if (opts.json) {
    put(JSON.stringify(out2, null, 2) + "\n");
    return;
  }
  put(renderQuotaTable(out2) + "\n");
}

export async function runRefresh(): Promise<void> {
  const ledger = loadLedger();
  const touched = refreshToday(ledger);
  saveLedger(ledger);
  const out = { refreshed: true, asOf: new Date().toISOString(), providers: touched };
  process.stdout.write(JSON.stringify(out, null, 2) + "\n");
}

/** generate 核心：接受已解析的 raw 参数（mode/prompt/engine...），走 router 或浏览器引擎 */
export async function runGenerate(raw: GenerateRaw, out?: (s: string) => void): Promise<void> {
  const put = out ?? ((s: string) => process.stdout.write(s));
  const mode = raw.mode as VideoMode;
  if (!["text2video", "img2video", "video2video", "imgs2video"].includes(mode)) {
    process.stderr.write(`invalid --mode ${mode ?? "(missing)"}（可选：${["text2video", "img2video", "video2video", "imgs2video"].join("|")}）\n`);
    return;
  }

  const opts: GenerateOptions = {
    mode,
    prompt: raw.prompt,
    imageUrl: raw.imageUrl,
    imageUrls: typeof raw.imageUrls === "string" ? splitList(raw.imageUrls) : undefined,
    videoUrls: typeof raw.videoUrls === "string" ? splitList(raw.videoUrls) : undefined,
    voiceUrl: raw.voiceUrl,
    bgmUrl: raw.bgmUrl,
    bgmVolume: raw.bgmVolume == null ? undefined : Number(raw.bgmVolume),
    voiceVolume: raw.voiceVolume == null ? undefined : Number(raw.voiceVolume),
    coverImageUrl: raw.coverImageUrl,
    coverImageDuration: raw.coverImageDuration == null ? undefined : Number(raw.coverImageDuration),
    headerVideoUrl: raw.headerVideoUrl,
    footerVideoUrl: raw.footerVideoUrl,
  };

  let res: DispatchResult;

  if (raw.engine === "browser") {
    // 浏览器引擎：拉起真实 Edge，在厂商页面内自动登录/填 prompt/拦截 cookie。当前仅元宝。
    const pid = raw.provider || "yuanbao";
    const br = await runBrowserGenerate(opts, pid);
    const ledger = loadLedger();
    if (maybeRollDaily(ledger)) saveLedger(ledger);
    if (br.result?.ok && br.result.quotaUsed > 0) {
      consume(ledger, pid, br.result.quotaUsed, { success: true });
      saveLedger(ledger);
    }
    res = { result: br.result, attempts: br.attempts, rounds: br.attempts.length, ledgerSnapshot: ledger };
  } else {
    const providers = createAllProviders();
    void toProviderMap(providers);

    const dispatchOpts: DispatchOptions = {
      strategy: (raw.strategy as RoutingStrategy) || "quality_first",
      preferredProviderId: raw.provider,
      fallbackMaxRounds: Number(raw.fallbackRounds ?? 2),
      coolDownMinutesOnFail: Number(raw.coolDown ?? 10),
    };

    const router = new Router(providers);
    res = await router.dispatch(opts, dispatchOpts);
  }

  // 写 jobs 日志（JSON Lines，一行一个请求摘要）
  try {
    const dir = path.dirname(JOBS_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(
      JOBS_PATH,
      JSON.stringify({
        at: new Date().toISOString(),
        mode,
        options: maskUris(opts),
        attempts: res.attempts,
        result: res.result
          ? {
              ok: res.result.ok,
              providerId: res.result.providerId,
              traceId: res.result.traceId ?? null,
              quotaUsed: res.result.quotaUsed,
              qualityScore: res.result.qualityScore ?? null,
              errorMessage: res.result.errorMessage ?? null,
            }
          : null,
      }) + "\n",
      "utf-8",
    );
  } catch {
    /* ignore log failure */
  }

  // 写 Supabase jobs 表（数据库为真相源；未配置凭据时跳过，仅保留本地 JSONL 日志）
  await writeJobToDb(res, mode, opts);

  const ledgerAfter = res.ledgerSnapshot;
  const quotaRows = Object.entries(ledgerAfter.providers).map(([id, e]) => ({
    providerId: id,
    dailyQuota: e.dailyQuota,
    used: e.used,
    remaining: remaining(ledgerAfter, id),
    status: effectiveStatus(ledgerAfter, id),
  }));

  const payload = {
    ok: !!res.result?.ok,
    rounds: res.rounds,
    attempts: res.attempts,
    result: res.result,
    nextSteps: deriveNextSteps(res.result),
    quotaSnapshot: quotaRows,
  };

  if (raw.json) {
    put(JSON.stringify(payload, null, 2) + "\n");
    return;
  }
  put(renderGenerate(payload) + "\n");
}

export function splitList(s: string): string[] {
  return String(s ?? "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
}

async function writeJobToDb(
  res: {
    result: GenerateResult | null;
    attempts: Array<{ providerId: string; ok: boolean; errorMessage?: string }>;
  },
  mode: VideoMode,
  opts: GenerateOptions
): Promise<void> {
  const url = process.env["SUPABASE_URL"];
  const anon = process.env["SUPABASE_ANON_KEY"];
  const email = process.env["QUOTA_FLOW_EMAIL"];
  const password = process.env["QUOTA_FLOW_PASSWORD"];
  if (!url || !anon || !email || !password) {
    process.stderr.write(
      "[jobs] 未配置 SUPABASE_URL / SUPABASE_ANON_KEY / QUOTA_FLOW_EMAIL / QUOTA_FLOW_PASSWORD，跳过写库（仍写入本地 jobs.jsonl）\n"
    );
    return;
  }
  try {
    const auth = createAuthService("hosted", { supabaseUrl: url, supabaseAnonKey: anon });
    const login = await auth.signIn(email, password);
    if (login.error || !login.user) {
      process.stderr.write(`[jobs] 写库登录失败：${login.error ?? "未返回用户"}\n`);
      return;
    }
    const team = await auth.getTeam(login.user.id);
    const svc = new JobService(auth.getClient());
    const pid = res.result?.providerId ?? res.attempts[0]?.providerId ?? null;
    const status: JobStatus = res.result
      ? res.result.ok
        ? "success"
        : "failed"
      : res.attempts.length > 0
        ? "pending"
        : "not_generated";
    await svc.insertJob(login.user.id, {
      teamId: team?.id ?? null,
      providerId: pid,
      mode,
      prompt: opts.prompt ?? "",
      options: maskUris(opts) as unknown as Record<string, unknown>,
      attempts: res.attempts as unknown as Array<Record<string, unknown>>,
      status,
      traceId: res.result?.traceId ?? null,
      qualityScore: res.result?.qualityScore ?? null,
      error: res.result?.errorMessage ?? null,
      costAmount: res.result?.quotaUsed ?? 0,
      createdAt: new Date().toISOString(),
      completedAt: res.result ? new Date().toISOString() : null,
    });
    process.stderr.write(`[jobs] 已写入 Supabase jobs 表（status=${status}）\n`);
  } catch (e) {
    process.stderr.write(`[jobs] 写库失败：${e instanceof Error ? e.message : String(e)}\n`);
  }
}

/** 日志脱敏：把 URL 只保留 scheme+host，避免隐私外泄 */
function maskUris(opts: GenerateOptions): GenerateOptions {
  const mask = (u?: string) => (u ? maskOneUrl(u) : undefined);
  const maskList = (list?: string[]) => (list ? list.map(maskOneUrl) : undefined);
  return {
    ...opts,
    imageUrl: mask(opts.imageUrl),
    imageUrls: maskList(opts.imageUrls),
    videoUrls: maskList(opts.videoUrls),
    voiceUrl: mask(opts.voiceUrl),
    bgmUrl: mask(opts.bgmUrl),
    coverImageUrl: mask(opts.coverImageUrl),
    headerVideoUrl: mask(opts.headerVideoUrl),
    footerVideoUrl: mask(opts.footerVideoUrl),
  };
}
function maskOneUrl(u: string): string {
  try {
    const pu = new URL(u);
    return `${pu.protocol}//${pu.host}/***`;
  } catch {
    return String(u).slice(0, 24) + (u.length > 24 ? "…" : "");
  }
}

function renderQuotaTable(out: {
  today: string;
  rolled: boolean;
  providers: Array<{
    providerId: string;
    date: string;
    dailyQuota: number;
    used: number;
    remaining: number | null;
    status: string;
    lastUsedAt: string | null;
    coolDownUntil: string | null;
  }>;
}): string {
  const header = ["provider", "date", "daily", "used", "remain", "status", "last_used", "cooldown"];
  const rows = [header.join("\t")];
  for (const p of out.providers) {
    rows.push(
      [
        p.providerId,
        p.date,
        String(p.dailyQuota),
        String(p.used),
        String(p.remaining ?? 0),
        p.status,
        p.lastUsedAt ?? "-",
        p.coolDownUntil ?? "-",
      ].join("\t"),
    );
  }
  return (
    `# quota-flow  ${out.today}  rolled=${out.rolled}  ledger=${LEDGER_PATH}\n` + rows.join("\n")
  );
}

function renderGenerate(payload: {
  ok: boolean;
  rounds: number;
  attempts: Array<{ providerId: string; ok: boolean; errorMessage?: string }>;
  result: { providerId: string; traceId?: string; videoUrl?: string; downloadUrl?: string; quotaUsed: number; qualityScore?: number; errorMessage?: string; ok: boolean } | null;
  nextSteps?: string[];
}): string {
  const lines: string[] = [];
  lines.push(`# quota-flow generate => ${payload.ok ? "OK" : "FAIL"}  (rounds=${payload.rounds})`);
  lines.push("attempts:");
  for (const a of payload.attempts) {
    lines.push(`  - ${a.providerId}: ${a.ok ? "OK" : "FAIL"}${a.errorMessage ? `  (${a.errorMessage})` : ""}`);
  }
  if (payload.result) {
    const r = payload.result;
    lines.push(`provider=${r.providerId}  traceId=${r.traceId ?? "-"}  quotaUsed=${r.quotaUsed}  quality=${r.qualityScore ?? "-"}`);
    if (r.videoUrl) lines.push(`videoUrl=${r.videoUrl}`);
    if (r.downloadUrl) lines.push(`downloadUrl=${r.downloadUrl}`);
    if (!r.ok && r.errorMessage) lines.push(`error=${r.errorMessage}`);
  }
  if (payload.nextSteps && payload.nextSteps.length > 0) {
    lines.push("next-steps:");
    for (const s of payload.nextSteps) lines.push(`  - ${s}`);
  }
  return lines.join("\n");
}

function deriveNextSteps(
  result: { ok: boolean; providerId?: string; traceId?: string; videoUrl?: string; errorMessage?: string } | null,
): string[] {
  const steps: string[] = [];
  if (!result) {
    steps.push("All providers exhausted; run `quota-flow refresh` tomorrow or add more providers/accounts.");
    return steps;
  }
  if (!result.ok) {
    steps.push("Failure: either add more accounts/providers, or wait for cooldown to expire (see check-quota).");
    return steps;
  }
  return steps;
}