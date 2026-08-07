// mcp_mathmind-video 适配器：当前环境已接入的视频生成 MCP。
// 在 CLI / Skill 环境里默认做 dry-run：把要调用的 MCP 参数打印出来，由上层 Skill 实际通过 run_mcp 执行。
// 如需真正打通，可在此处直接走子进程或直接调用 MCP SDK（后续迭代接入）。

import type { GenerateOptions, GenerateResult, ProviderCapabilities } from "@quota-flow/core";
import { BaseProvider } from "@quota-flow/core";

export interface MathmindCallRecord {
  tool: string;
  args: Record<string, unknown>;
}

export interface MathmindDryRunContext {
  /** 记录下来的调用指令列表，便于上层 Skill 实际 run_mcp */
  calls: MathmindCallRecord[];
}

export class MathmindProvider extends BaseProvider {
  readonly id = "mathmind";
  readonly displayName = "mcp_mathmind-video";
  private ctx: MathmindDryRunContext;

  constructor(ctx?: MathmindDryRunContext) {
    super();
    this.ctx = ctx ?? { calls: [] };
  }

  /** 取出累积的 MCP 调用指令 */
  get calls(): MathmindCallRecord[] {
    return this.ctx.calls;
  }

  get capabilities(): ProviderCapabilities {
    return {
      text2video: false, // 当前 mcp_mathmind 未暴露纯文生视频
      img2video: true,   // imageGenVideo
      video2video: true, // video2video
      imgs2video: true,  // imgs2video
      typicalCostPerCall: 1,
      qualityScore: 3.5,
      limits: {
        imageGenVideo: "1 pic -> motion",
        imgs2video: "N pics + voice/bgm + cover",
        video2video: "N clips + header/footer/cover",
      },
    };
  }

  async generate(options: GenerateOptions): Promise<GenerateResult> {
    const startedAt = Date.now();
    try {
      const { mode } = options;
      let tool: string | null = null;
      let args: Record<string, unknown> | null = null;

      if (mode === "img2video") {
        if (!options.imageUrl) {
          return fail(this.id, "img2video requires imageUrl");
        }
        tool = "imageGenVideo";
        args = { imageUrl: options.imageUrl };
        if (options.prompt) args.prompt = options.prompt;
      } else if (mode === "imgs2video") {
        if (!options.imageUrls || options.imageUrls.length === 0) {
          return fail(this.id, "imgs2video requires imageUrls");
        }
        tool = "imgs2video";
        args = { imageUrls: options.imageUrls };
        if (options.voiceUrl) args.voiceUrl = options.voiceUrl;
        if (options.bgmUrl) args.bgmUrl = options.bgmUrl;
        if (options.bgmVolume != null) args.bgmVolume = options.bgmVolume;
        if (options.coverImageUrl) args.coverImageUrl = options.coverImageUrl;
        if (options.coverImageDuration != null)
          args.coverImageDuration = options.coverImageDuration;
      } else if (mode === "video2video") {
        const videoFiles =
          options.videoUrls && options.videoUrls.length > 0 ? options.videoUrls : undefined;
        if (!videoFiles) return fail(this.id, "video2video requires videoUrls");
        tool = "video2video";
        args = { videoFiles };
        if (options.voiceUrl) args.voiceUrl = options.voiceUrl;
        if (options.bgmUrl) args.bgmUrl = options.bgmUrl;
        if (options.voiceVolume != null) args.voiceVolume = options.voiceVolume;
        if (options.bgmVolume != null) args.bgmVolume = options.bgmVolume;
        if (options.headerVideoUrl) args.headerVideoUrl = options.headerVideoUrl;
        if (options.footerVideoUrl) args.footerVideoUrl = options.footerVideoUrl;
        if (options.coverImageUrl) args.coverImageUrl = options.coverImageUrl;
        if (options.coverImageDuration != null)
          args.coverImageDuration = options.coverImageDuration;
      } else {
        return fail(this.id, `mode '${mode}' is not supported by ${this.displayName}`);
      }

      this.ctx.calls.push({ tool, args });

      // 当前是骨架实现，dry-run：返回可执行指令 + 占位 traceId
      return {
        ok: true,
        providerId: this.id,
        traceId: `mathmind-dryrun-${Date.now()}`,
        quotaUsed: this.estimateCost(options),
        qualityScore: this.capabilities.qualityScore,
        durationMs: Date.now() - startedAt,
        raw: { tool, args, note: "dry-run, actual call via run_mcp to mcp_mathmind-video" },
      };
    } catch (err: unknown) {
      return fail(this.id, err instanceof Error ? err.message : String(err), Date.now() - startedAt);
    }
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
