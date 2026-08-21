// 桌面端历史记录模块共享类型（main / preload / renderer 三端共用，避免重复定义）

export type HistoryStatus = '成功' | '排队' | '失败' | '未生成' | '意外中断'

export type WatermarkStatus = 'none' | 'pending' | 'processing' | 'done' | 'failed' | 'needs_bbox' | 'cancelled'

export interface WatermarkBBox {
  x: number
  y: number
  width: number
  height: number
}

export interface JobRecord {
  at: string // ISO 时间戳
  provider: string // 中文名：豆包、即梦...
  /** 原始 provider id（auto/doubao/qwenwan/yuanbao/dola 等），旧记录可能缺失 */
  providerId?: string
  /** 生成时使用的模型名，旧记录可能缺失 */
  model?: string
  accountName: string | null // 实际使用的账号名（多账号）
  mode: string // 中文模式：文生视频、图生视频...
  prompt: string // 提示词
  cost: string // 消耗：如 "1 点"、"80 灵感值"、"-"
  status: HistoryStatus
  traceId: string | null
  /** 视频地址：本地路径（app-media:// 可播放）或远程 https URL */
  resultUrl: string | null
  /** 本地视频文件绝对路径（生成后落盘 userData/videos/<jobId>.mp4），无本地文件时为 null */
  localPath: string | null
  /** 去水印后本地视频绝对路径（userData/videos/<jobId>.clean.mp4），无结果时为 null */
  cleanLocalPath: string | null
  /** 去水印状态；旧记录或未开启时可为 null */
  watermarkStatus: WatermarkStatus | null
  /** 去水印方法，例如 delogo */
  watermarkMethod: string | null
  /** 去水印失败原因 */
  watermarkError: string | null
  /** 用户框选的水印区域；无手动框选时为 null */
  watermarkBBox: WatermarkBBox | null
  /** 用户框选的多个水印区域；无手动框选时为 null */
  watermarkBBoxes: WatermarkBBox[] | null
  /** 生成参数（模式/时长/比例/配音/分辨率），无记录时为 null */
  params: { mode?: string; durationSec?: number; ratio?: string; audio?: string; resolution?: string } | null
  /** 文生视频音频参考的本地副本路径（历史回显/重新生成回填时重传取新 URL） */
  audioLocalPath?: string | null
  /** 文生视频音频参考的公网 https URL（旧记录兼容） */
  audioUrl?: string | null
  /** 上传的本地图片副本路径（userData/images/<jobId>-<n>.<ext>），无图片时为空数组 */
  images: string[]
  errorMessage: string | null
}
