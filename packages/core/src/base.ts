// Provider 抽象基类：只负责把 generate 调通并返回归一化结果，不管账本与路由

import type {
  GenerateOptions,
  GenerateResult,
  ProviderCapabilities,
  VideoMode,
} from "./types";

export abstract class BaseProvider {
  abstract readonly id: string;
  abstract readonly displayName: string;

  /** 能力声明，供路由决策参考 */
  abstract get capabilities(): ProviderCapabilities;

  /** 是否支持指定模式（基于 capabilities） */
  supports(mode: VideoMode): boolean {
    const c = this.capabilities;
    switch (mode) {
      case "text2video":
        return c.text2video;
      case "img2video":
        return c.img2video;
      case "video2video":
        return c.video2video;
      case "imgs2video":
        return c.imgs2video;
    }
  }

  /**
   * 实际调用。失败时不要抛异常，用 { ok:false, errorMessage } 形式返回，
   * 以便调度器知道是降级重试还是直接冷却。
   */
  abstract generate(options: GenerateOptions): Promise<GenerateResult>;

  /**
   * 估算本次调用会消耗多少额度单位。默认按 typicalCostPerCall，
   * 子类可基于 options（如视频时长、分辨率）给出更精确估算。
   */
  estimateCost(_options: GenerateOptions): number {
    return this.capabilities.typicalCostPerCall;
  }
}
