// CLI 入口：check-quota / generate / refresh 三个子命令

import { Command } from "commander";
import * as path from "node:path";
import * as fs from "node:fs";
import {
  LEDGER_PATH,
  consume,
  effectiveStatus,
  loadLedger,
  maybeRollDaily,
  refreshToday,
  remaining,
  saveLedger,
  todayLocal,
} from "@quota-flow/core";
import { MathmindDryRunContext, createAllProviders, toProviderMap } from "@quota-flow/providers";
import { Router, type DispatchOptions } from "@quota-flow/core";
import type { GenerateOptions, RoutingStrategy, VideoMode } from "@quota-flow/core";

const JOBS_PATH = path.resolve(__dirname, "..", "..", "..", "data", "jobs.jsonl");

const program = new Command();
program
  .name("quota-flow")
  .description("Unified daily free-quota scheduler for multi-provider video generation")
  .version("0.1.0");

program
  .command("check-quota")
  .description("Show remaining daily quota and status per provider")
  .option("--json", "Output as JSON")
  .action((opts) => {
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

    const out = {
      asOf: new Date().toISOString(),
      timezone: ledger.timezone,
      today: todayLocal(),
      rolled,
      providers: rows,
    };
    if (opts.json) {
      process.stdout.write(JSON.stringify(out, null, 2) + "\n");
      return;
    }
    process.stdout.write(renderQuotaTable(out) + "\n");
  });

program
  .command("refresh")
  .description("Force-refresh today's daily quota to defaults")
  .action(() => {
    const ledger = loadLedger();
    const touched = refreshToday(ledger);
    saveLedger(ledger);
    const out = { refreshed: true, asOf: new Date().toISOString(), providers: touched };
    process.stdout.write(JSON.stringify(out, null, 2) + "\n");
  });

program
  .command("generate")
  .description("Generate video via auto-routed provider, using and deducting daily quota")
  .requiredOption("--mode <mode>", "Generation mode: text2video|img2video|video2video|imgs2video")
  .option("--prompt <text>", "Text prompt (optional for img2video/video2video/imgs2video)")
  .option("--imageUrl <url>", "Single image URL (img2video)")
  .option("--imageUrls <list>", "Comma-separated image URLs (imgs2video)")
  .option("--videoUrls <list>", "Comma-separated video URLs (video2video)")
  .option("--voiceUrl <url>", "Voice/配音 URL")
  .option("--bgmUrl <url>", "BGM URL")
  .option("--bgmVolume <n>", "BGM volume 0-100 (mathmind provider)", (v) => Number(v))
  .option("--voiceVolume <n>", "Voice volume 0-100", (v) => Number(v))
  .option("--coverImageUrl <url>", "Cover image URL")
  .option("--coverImageDuration <n>", "Cover duration in seconds", (v) => Number(v))
  .option("--headerVideoUrl <url>", "Header video URL (video2video)")
  .option("--footerVideoUrl <url>", "Footer video URL (video2video)")
  .option("--strategy <s>", "Routing strategy: quality_first|cost_first|round_robin|available_first", "quality_first")
  .option("--provider <id>", "Force use a specific provider id (debugging)")
  .option("--fallback-rounds <n>", "Max fallback rounds on failure (default 2)", (v) => Number(v), 2)
  .option("--coolDown <n>", "Cool-down minutes after failure (default 10)", (v) => Number(v), 10)
  .option("--json", "Output JSON instead of pretty text")
  .action(async (raw) => {
    const mode = raw.mode as VideoMode;
    if (!["text2video", "img2video", "video2video", "imgs2video"].includes(mode)) {
      process.stderr.write(`invalid --mode ${mode}\n`);
      process.exit(2);
    }

    const opts: GenerateOptions = {
      mode,
      prompt: raw.prompt,
      imageUrl: raw.imageUrl,
      imageUrls: raw.imageUrls ? splitList(raw.imageUrls) : undefined,
      videoUrls: raw.videoUrls ? splitList(raw.videoUrls) : undefined,
      voiceUrl: raw.voiceUrl,
      bgmUrl: raw.bgmUrl,
      bgmVolume: raw.bgmVolume,
      voiceVolume: raw.voiceVolume,
      coverImageUrl: raw.coverImageUrl,
      coverImageDuration: raw.coverImageDuration,
      headerVideoUrl: raw.headerVideoUrl,
      footerVideoUrl: raw.footerVideoUrl,
    };

    const mathmindCtx: MathmindDryRunContext = { calls: [] };
    const providers = createAllProviders({ mathmindCtx });
    void toProviderMap(providers);

    const dispatchOpts: DispatchOptions = {
      strategy: raw.strategy as RoutingStrategy,
      preferredProviderId: raw.provider as string | undefined,
      fallbackMaxRounds: raw.fallbackRounds as number,
      coolDownMinutesOnFail: raw.coolDown as number,
    };

    const router = new Router(providers);
    const res = await router.dispatch(opts, dispatchOpts);

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
          mathmindCalls: mathmindCtx.calls,
        }) + "\n",
        "utf-8",
      );
    } catch {
      /* ignore log failure */
    }

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
      mathmindCalls: mathmindCtx.calls,
      nextSteps: deriveNextSteps(res.result, mathmindCtx.calls),
      quotaSnapshot: quotaRows,
    };

    if (raw.json) {
      process.stdout.write(JSON.stringify(payload, null, 2) + "\n");
      return;
    }
    process.stdout.write(renderGenerate(payload) + "\n");
  });

function splitList(s: string): string[] {
  return String(s ?? "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
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
  mathmindCalls: Array<{ tool: string; args: Record<string, unknown> }>;
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
  if (payload.mathmindCalls.length > 0) {
    lines.push("mathmind mcp calls (run via run_mcp mcp_mathmind-video):");
    for (const c of payload.mathmindCalls) {
      lines.push(`  - tool: ${c.tool}  args: ${JSON.stringify(c.args)}`);
    }
  }
  if (payload.nextSteps && payload.nextSteps.length > 0) {
    lines.push("next-steps:");
    for (const s of payload.nextSteps) lines.push(`  - ${s}`);
  }
  return lines.join("\n");
}

function deriveNextSteps(
  result: { ok: boolean; providerId?: string; traceId?: string; videoUrl?: string; errorMessage?: string } | null,
  mathmindCalls: Array<{ tool: string; args: Record<string, unknown> }>,
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
  if (result.providerId === "mathmind" && mathmindCalls.length > 0) {
    steps.push(
      "在支持 run_mcp 的 MCP 宿主中，用上面的 payload 调用 serverName=mcp_mathmind-video 的对应 toolName 即可触发生成，随后用 taskFetchByTraceID 或轮询任务结果。",
    );
    if (result.traceId) steps.push(`After the task is submitted, poll by traceId=${result.traceId}.`);
  }
  return steps;
}

program.parseAsync(process.argv).catch((err: unknown) => {
  process.stderr.write((err instanceof Error ? err.stack : String(err)) ?? "unknown error");
  process.stderr.write("\n");
  process.exit(1);
});
