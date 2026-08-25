// CLI 入口：无参数进入交互式 UI（quota-flow），带子命令走 commander（shebang 由 tsup banner 注入）
// 命令业务逻辑统一放在 ./commands.ts，供 commander 与交互式 REPL 共用。

import { Command } from "commander";
import { config as loadEnv } from "dotenv";
import { spawnSync } from "node:child_process";
import { dataFile } from "@quota-flow/core";
import { runCheckQuota, runGenerate, runRefresh } from "./commands";
import { startRepl } from "./repl";

// Windows 控制台默认 GBK，utf-8 流式字符会被误解码成乱码；强制切到 UTF-8 代码页
if (process.platform === "win32") {
  try {
    spawnSync("chcp", ["65001"], { stdio: "ignore" });
  } catch {
    /* ignore */
  }
}

// 加载用户数据目录 .env（写库凭据 SUPABASE_* / QUOTA_FLOW_* 可选）与当前目录 .env
loadEnv({ path: dataFile(".env"), quiet: true });
loadEnv({ quiet: true });

const program = new Command();
program
  .name("quota-flow")
  .description("Unified daily free-quota scheduler for multi-provider video generation")
  .version("0.1.0");

// 无子命令（直接运行 `quota-flow`）时进入交互式 UI
program.action(async () => {
  await startRepl();
});

program
  .command("check-quota")
  .description("Show remaining daily quota and status per provider")
  .option("--json", "Output as JSON")
  .action((opts) => runCheckQuota(opts));

program
  .command("refresh")
  .description("Force-refresh today's daily quota to defaults")
  .action(() => runRefresh());

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
  .option("--bgmVolume <n>", "BGM volume 0-100", (v) => Number(v))
  .option("--voiceVolume <n>", "Voice volume 0-100", (v) => Number(v))
  .option("--coverImageUrl <url>", "Cover image URL")
  .option("--coverImageDuration <n>", "Cover duration in seconds", (v) => Number(v))
  .option("--headerVideoUrl <url>", "Header video URL (video2video)")
  .option("--footerVideoUrl <url>", "Footer video URL (video2video)")
  .option("--strategy <s>", "Routing strategy: quality_first|cost_first|round_robin|available_first", "quality_first")
  .option("--provider <id>", "Force use a specific provider id (debugging)")
  .option("--engine <fetch|browser>", "Execution engine: fetch (static cookie, default) or browser (auto cookie capture via real Edge)", "fetch")
  .option("--fallback-rounds <n>", "Max fallback rounds on failure (default 2)", (v) => Number(v), 2)
  .option("--coolDown <n>", "Cool-down minutes after failure (default 10)", (v) => Number(v), 10)
  .option("--json", "Output JSON instead of pretty text")
  .action((raw) => runGenerate(raw));

program.parseAsync(process.argv).catch((err: unknown) => {
  process.stderr.write((err instanceof Error ? err.stack : String(err)) ?? "unknown error");
  process.stderr.write("\n");
  process.exit(1);
});