// 桌面端历史记录模块共享类型（main / preload / renderer 三端共用，避免重复定义）

export type HistoryStatus = '成功' | '排队' | '失败' | '未生成'

export interface JobRecord {
  at: string // ISO 时间戳
  provider: string // 中文名：豆包、即梦...
  accountName: string | null // 实际使用的账号名（多账号）
  mode: string // 中文模式：文生视频、图生视频...
  prompt: string // 提示词
  cost: string // 消耗：如 "1 点"、"80 灵感值"、"-"
  status: HistoryStatus
  quality: string // 质量分，如 "4.5" 或 "-"
  traceId: string | null
  /** 视频地址：本地路径（app-media:// 可播放）或远程 https URL */
  resultUrl: string | null
  /** 本地视频文件绝对路径（生成后落盘 userData/videos/<jobId>.mp4），无本地文件时为 null */
  localPath: string | null
  /** 生成参数（模式/时长/比例/配音/分辨率），无记录时为 null */
  params: { mode?: string; durationSec?: number; ratio?: string; audio?: string; resolution?: string } | null
  /** 上传的本地图片副本路径（userData/images/<jobId>-<n>.<ext>），无图片时为空数组 */
  images: string[]
  errorMessage: string | null
}
