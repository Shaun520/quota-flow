// 交互式 UI：运行 `quota-flow`（无子命令）进入。
// `>` 默认是 AI 助手（硅基流动免费 GLM-4-9B 流式）；`/cmd` 直接执行本地命令。
// 命令执行复用 ./commands.ts，AI 通过 CMD:{} 工具块调用本地命令并把结果回喂。

import * as readline from "node:readline";
import * as fs from "node:fs";
import { runCheckQuota, runGenerate, runRefresh, type GenerateRaw } from "./commands";
import { streamChat, type ChatMessage } from "./chat/qianfan";

const VERSION = "0.1.0";
const PROMPT = "> ";

const SYSTEM_PROMPT =
  "你是 quota-flow 的对话助手。quota-flow 是一个聚合多家厂商（yuanbao|qwenwan|seedance）每日免费视频生成额度的调度工具。\n" +
  "可用的工具（只准使用下面给出的形式，不臆造参数）：\n" +
  '- 查看今日各厂商剩余额度：CMD:{"name":"quota","args":{"json":"false"}}\n' +
  '- 生成视频：CMD:{"name":"generate","args":{"mode":"text2video","prompt":"<提示词>","engine":"fetch","provider":""}}\n' +
  "规则：\n" +
  "- 查询类问题优先用 quota 工具。\n" +
  "- 仅当用户明确要求“生成/制作视频”时才调用 generate（会真实消耗每日免费额度），不要擅自触发。\n" +
  "- 一次回复可携带多个 CMD:{} 块，正文与 CMD 可同时输出。\n" +
  "- 用中文回答，简洁；不确定就明说。";

function cwd(): string {
  try {
    return process.cwd();
  } catch {
    return ".";
  }
}

/** 同步写 stdout：Windows 控制台是行缓冲（无换行会攒到退出才刷），
 *  非 TTY 重定向用 fs.writeSync 即时落屏，保证流式 token 逐字可见。 */
function stdout(s: string): void {
  try {
    if (process.stdout.isTTY) {
      process.stdout.write(s);
    } else {
      fs.writeSync(process.stdout.fd ?? 1, s);
    }
  } catch {
    process.stdout.write(s);
  }
}

/** 无条件同步写 stdout（即使无换行也立即落屏），用于 spinner / 流式 token */
function writeRaw(s: string): void {
  try {
    fs.writeSync(process.stdout.fd ?? 1, s);
  } catch {
    process.stdout.write(s);
  }
}

/** 清屏并打印顶部 banner */
function printBanner(out: NodeJS.WritableStream): void {
  const width = 100;
  const pad = (s: string): string => "  " + s;
  // 萌脸 logo（复刻 .trae 那张手绘表情：闭眼笑 + 脸颊红晕 + 戳脸手指，3 行，右侧配版本/描述/目录）
  const logo = [
    "    ◡     ◡",
    "  〃   ︶   〃",
    "        ☞",
  ];
  const col = (i: number, text: string): string => pad((logo[i] ?? "").padEnd(15, " ") + " " + text);
  out.write("\x1b[2J\x1b[H"); // ANSI 清屏并回左上角
  out.write(col(0, `quota-flow v${VERSION}`) + "\n");
  out.write(col(1, "") + "\n");
  out.write(col(2, cwd()) + "\n\n");
  out.write("欢迎使用 quota-flow\n\n");
}

function printHelp(out: NodeJS.WritableStream): void {
  const rows = [
    ["（直接输入）", "与 AI 助手对话；可让它查额度/生成视频"],
    ["/quota [--json]", "查看今日各厂商剩余额度"],
    ["/refresh", "将今日额度重置为默认值"],
    ["/generate", "生成视频（进入交互式向导）"],
    ["/generate --mode text2video --prompt \"...\"", "一行式生成参数"],
    ["/help", "显示本帮助"],
    ["/clear", "清屏并重绘 banner"],
    ["/quit", "退出交互式 CLI"],
  ];
  out.write("可用命令（以 / 开头，不带 / 的输入会交给 AI）：\n");
  for (const [cmd, desc] of rows) out.write(`  ${cmd.padEnd(46, " ")}${desc}\n`);
  out.write("\n");
}

/** 把 `--k v --flag` 形式拆成对象；flag 无值时记 true */
function tokenizeArgs(argsStr: string): Record<string, string | boolean> {
  const tokens = argsStr.match(/(?:[^\s"]+|"[^"]*")+/g) ?? [];
  const raw: Record<string, string | boolean> = {};
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (!t.startsWith("--")) continue;
    const key = t.replace(/^--/, "");
    const next = tokens[i + 1];
    const hasValue = next != null && !next.startsWith("--");
    if (hasValue) { raw[key] = next.replace(/^"|"$/g, ""); i++; } else { raw[key] = true; }
  }
  return raw;
}

function ask(rl: readline.Interface, q: string, def?: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(def ? `${q}（默认 ${def}）> ` : `${q}> `, (ans) => {
      resolve(ans.trim() === "" && def !== undefined ? def : ans.trim());
    });
  });
}

async function generateWizard(rl: readline.Interface): Promise<void> {
  const mode = (await ask(rl, "生成模式", "text2video")) || "text2video";
  const prompt = await ask(rl, "提示词（prompt）");
  const engine = (await ask(rl, "引擎（fetch/browser）", "fetch")) || "fetch";
  const provider = await ask(rl, "指定厂商（留空自动路由）");
  const raw: GenerateRaw = { mode, prompt, engine };
  if (provider) raw.provider = provider;
  await runGenerate(raw);
}

/** 执行本地命令（/xxx 形式），返回是否已处理 */
async function runCommand(rl: readline.Interface, name: string, rest: string[]): Promise<boolean> {
  const lower = name.toLowerCase();
  if (lower === "quit" || lower === "exit" || lower === "q") { rl.close(); return true; }
  if (lower === "clear" || lower === "clc") { printBanner(process.stdout); return true; }
  if (lower === "help" || lower === "h" || name === "?") { printHelp(process.stdout); return true; }
  if (lower === "quota") {
    await runCheckQuota({ json: tokenizeArgs(rest.join(" ")).json === true });
    return true;
  }
  if (lower === "refresh") { await runRefresh(); return true; }
  if (lower === "generate") {
    const raw = tokenizeArgs(rest.join(" "));
    if (rest.length > 0 && raw.mode) await runGenerate(raw as GenerateRaw);
    else if (rest.length === 0) await generateWizard(rl);
    else process.stdout.write("generate 缺少 --mode（可选：text2video|img2video|video2video|imgs2video），或直接输入 /generate 进入向导。\n");
    return true;
  }
  return false;
}

/** 执行 AI 请求的工具，捕获输出而非直接打屏 */
async function runTool(name: string, args: Record<string, string>): Promise<string> {
  const cap: string[] = [];
  const put = (s: string) => cap.push(s);
  try {
    if (name === "quota") {
      await runCheckQuota({ json: false }, put);
    } else if (name === "generate") {
      const raw: GenerateRaw = {
        mode: args.mode || "text2video",
        prompt: args.prompt,
        engine: args.engine || "fetch",
        provider: args.provider || undefined,
        json: false,
      };
      await runGenerate(raw, put);
    } else {
      return `未知工具：${name}`;
    }
    const text = cap.join("");
    return text.length > 1500 ? text.slice(0, 1500) + "\n（结果过长已截断）" : text;
  } catch (e) {
    return `工具执行出错：${e instanceof Error ? e.message : String(e)}`;
  }
}

/** AI 对话：与硅基流动免费 GLM-4-9B 流式对话，解析工具块并回喂结果 */
async function assistantChat(rl: readline.Interface, history: ChatMessage[], userText: string): Promise<void> {
  const apiKey = process.env.SILICONFLOW_API_KEY || process.env.ZHIPU_API_KEY || process.env.GLM_API_KEY || process.env.QIANFAN_API_KEY;
  if (!apiKey) {
    process.stdout.write("\n未配置 AI Key，无法对话。请注册硅基流动 cloud.siliconflow.cn 拿 API Key，并在 ~/.quota-flow/.env 里添加：SILICONFLOW_API_KEY=sk-xxxx（默认模型 GLM-4-9B 免费）\n\n");
    rl.prompt();
    return;
  }

  history.push({ role: "user", content: userText });
  let rounds = 0;
  while (true) {
    // 等待首个 token 前的加载 spinner（同步写即时生效）
    const spin = ["|", "/", "-", "\\"];
    let si = 0;
    let started = false;
    let timer: NodeJS.Timeout | undefined;
    writeRaw("\nassistant> ");
    const stopSpin = (): void => {
      if (timer) { clearInterval(timer); timer = undefined; }
    };
    timer = setInterval(() => {
      writeRaw(`\rassistant> ${spin[si++ % 4]}`);
    }, 110);

    const { content, toolCalls } = await streamChat({
      messages: history,
      apiKey,
      onToken: (t) => {
        if (!started) {
          started = true;
          stopSpin();
          writeRaw(`\rassistant> `);
        }
        writeRaw(t);
      },
    }).catch((e) => {
      stopSpin();
      writeRaw("\rassistant> "); // 清掉 spinner，回到提示
      stdout(`\n[AI 调用失败：${e instanceof Error ? e.message : String(e)}]`);
      return { content: "", toolCalls: [] };
    });
    history.push({ role: "assistant", content });
    if (toolCalls.length === 0) break;
    if (++rounds > 3) {
      stdout("\n（工具调用次数已达上限，停止）\n");
      break;
    }
    for (const tc of toolCalls) {
      const result = await runTool(tc.name, tc.args);
      history.push({ role: "user", content: `[工具 ${tc.name} 结果]\n${result}` });
    }
  }
  stdout("\n\n");
  rl.prompt();
}

export async function startRepl(): Promise<void> {
  // 交互式 UI 不适用非 TTY（管道输入），退化为提示用命令行子命令
  if (!process.stdin.isTTY) {
    process.stdout.write("交互式 CLI 需要 TTY 终端。请用子命令方式调用：quota-flow check-quota | generate | refresh\n");
    return;
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  let closed = false;
  rl.setPrompt(PROMPT);
  const history: ChatMessage[] = [{ role: "system", content: SYSTEM_PROMPT }];

  printBanner(process.stdout);

  rl.on("line", (line) => {
    const text = line.trim();
    if (!text) { if (!closed) rl.prompt(); return; }
    void (async () => {
      if (text.startsWith("/")) {
        const [cmd, ...rest] = text.slice(1).split(/\s+/);
        const handled = await runCommand(rl, cmd, rest);
        if (!handled) {
          process.stdout.write(`未知命令：/${cmd}。输入 /help 查看。\n`);
          if (!closed) rl.prompt();
        }
      } else {
        await assistantChat(rl, history, text);
      }
    })();
  });

  rl.on("close", () => {
    closed = true;
    process.stdout.write("\nbye.\n");
    process.exit(0);
  });

  rl.prompt();
}