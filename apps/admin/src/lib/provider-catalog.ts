// Provider 生成能力目录（Admin 端勾选候选）。
// 与桌面端 apps/desktop/src/renderer/src/spec.ts 的 MODELS / providerModeOptions 为镜像关系：
// 新增厂商/模型时需同步两处。DB provider_caps 一旦配置即为权威（桌面端只显示列表内可选项）。

export interface ProviderGenerationCap {
  /** 视频生成模式（扁平键）：text2video / img2video / multi_ref / first_last / first_frame */
  modes: string[];
  /** 模型清单 */
  models: string[];
}

export type ProviderGenerationCatalog = Record<string, ProviderGenerationCap>;

export const MODE_LABELS: Record<string, string> = {
  text2video: "文生视频",
  img2video: "图生视频",
  multi_ref: "多参考生成",
  first_last: "首尾帧生成",
  first_frame: "首帧生成"
};

// 网页厂商默认暴露「文生/图生/多参考/首尾帧」四种扁平模式（对应 spec 的 t2v/img/multi_ref/first_last）
const DEFAULT_WEB_MODES = ["text2video", "img2video", "multi_ref", "first_last"];

export const PROVIDER_GENERATION_CATALOG: ProviderGenerationCatalog = {
  doubao: { modes: DEFAULT_WEB_MODES, models: ["Seedance 2.0 Mini"] },
  jimeng: { modes: DEFAULT_WEB_MODES, models: ["视频 S2.0", "视频 S2.0 Pro"] },
  qwen: {
    modes: DEFAULT_WEB_MODES,
    models: ["万相 2.7", "万相 2.6", "HappyHorse 1.0 Beta"]
  },
  qwenwan: {
    modes: ["multi_ref", "first_last", "first_frame"],
    models: ["万相 2.7", "万相 2.6", "HappyHorse 1.0 Beta"]
  },
  yuanbao: { modes: ["multi_ref"], models: ["混元"] },
  dola: { modes: ["multi_ref"], models: ["Dreamina Seedance 2.5", "Dreamina Seedance 2.0 Fast", "Dreamina Seedance 1.0"] },
  kling: { modes: DEFAULT_WEB_MODES, models: ["可灵-标准", "可灵-大师"] },
  hailuo: { modes: DEFAULT_WEB_MODES, models: ["海螺-标准"] },
  zhipu: {
    modes: ["text2video", "img2video", "multi_ref", "first_last"],
    models: ["cogvideox-flash", "cogvideox-2", "cogvideox-3", "Vidu Q1", "Vidu 2"]
  },
  volcengine: {
    modes: ["text2video", "img2video"],
    models: [
      "doubao-seedance-1-0-pro-250528",
      "doubao-seedance-1-5-pro-251215",
      "doubao-seedance-1-0-pro-fast-251015"
    ]
  }
};