// 核心共享类型定义

export type VideoMode = "text2video" | "img2video" | "video2video" | "imgs2video";

export type ProviderStatus = "active" | "quota_exhausted" | "degraded" | "offline";

export interface ProviderCapabilities {
  text2video: boolean;
  img2video: boolean;
  video2video: boolean;
  imgs2video: boolean;
  /** 单次调用的典型额度消耗（估算，用于路由成本比较） */
  typicalCostPerCall: number;
  /** 0-5 预估质量分，用于选路优先级 */
  qualityScore: number;
  /** 支持的最大分辨率 / 秒数等（可选描述） */
  limits?: Record<string, string | number>;
}

export interface GenerateOptions {
  mode: VideoMode;
  prompt?: string;
  imageUrl?: string;
  imageUrls?: string[];
  videoUrls?: string[];
  voiceUrl?: string;
  bgmUrl?: string;
  bgmVolume?: number;
  coverImageUrl?: string;
  coverImageDuration?: number;
  headerVideoUrl?: string;
  footerVideoUrl?: string;
  voiceVolume?: number;
  /** 希望的输出分辨率 / 时长等（透传到 provider） */
  extra?: Record<string, unknown>;
}

export interface GenerateResult {
  ok: boolean;
  providerId: string;
  traceId?: string;
  videoUrl?: string;
  downloadUrl?: string;
  /** 本轮实际扣减的额度（估算） */
  quotaUsed: number;
  /** 0-5 输出质量估分（可由 provider 内部规则给出） */
  qualityScore?: number;
  /** 若失败，给出原因 */
  errorMessage?: string;
  /** provider 原始响应，方便调试 */
  raw?: unknown;
  /** 生成完成耗时毫秒 */
  durationMs?: number;
}

export interface QuotaLedgerProviderEntry {
  /** 今日免费额度总额（次数或成本单位） */
  dailyQuota: number;
  /** 今日已用 */
  used: number;
  /** 最近一次调用时间 ISO */
  lastUsedAt?: string;
  /** 成功累计次数（累计统计用） */
  totalSuccessful: number;
  /** 失败累计次数 */
  totalFailed: number;
  /** 当前状态 */
  status: ProviderStatus;
  /** 当日账期 YYYY-MM-DD（本地时区） */
  asOfDate: string;
  /** 冷却到期时间（额度耗尽或风控时使用） */
  coolDownUntil?: string;
}

export interface QuotaLedger {
  version: 1;
  updatedAt: string;
  timezone: string;
  /** key = providerId */
  providers: Record<string, QuotaLedgerProviderEntry>;
}

export type RoutingStrategy =
  | "round_robin"
  | "quality_first"
  | "cost_first"
  | "available_first";

export interface RouterPicks {
  providerId: string;
  reason: string;
}
