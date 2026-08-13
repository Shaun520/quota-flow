# Desktop 端本地去水印接入方案

> 状态：方案记录，暂不改代码。  
> 目标：在 Electron desktop 端接入“生成后自动去水印”，优先本地免费方案，不依赖在线第三方去水印服务。

## 1. 背景

当前 desktop 端是 Electron + React，主进程 `dispatch.ts` 负责调度生成，并在生成成功后把视频下载到 `userData/videos/<jobId>.mp4`。本地媒体服务 `src/main/index.ts` 目前只允许 `/^[0-9a-fA-F-]+\.mp4$/` 的本地视频预览，renderer 通过 `useJobs.ts` 从 `row.options.localPath` 推导本地路径。

豆包免费生成视频的 URL 带水印参数，例如 `lr=video_gen_watermark_unpaid`。这个项目当前没有去水印能力，也没有 ffmpeg、opencv、onnxruntime 等本地处理依赖。

## 2. 目标

- 视频生成成功并下载后，自动执行本地去水印后处理。
- 产出无水印副本 `<jobId>.clean.mp4`，保留原文件 `<jobId>.mp4`。
- 历史记录和预览优先使用 clean 文件。
- 处理失败不影响生成任务成功，只标记失败状态并允许重试。
- 不调用在线去水印 API，不尝试从平台直接下载无水印资源。
- 不依赖用户机器预装 Python/FFmpeg，尽量在安装包内提供本地工具。

## 3. 非目标

- 不做在线去水印服务接入。
- 不绕过平台下载无水印原始文件。
- 不承诺去除所有水印；动态水印、复杂遮挡、遮挡主体内容等情况需要后续模型升级或人工辅助。
- 不负责平台条款、版权、肖像权合规，用户需自行确认使用边界。

## 4. 总体流程

```text
生成成功
  -> downloadVideo 下载到 userData/videos/<jobId>.mp4
  -> 写 job success，options.watermarkStatus = 'processing'
  -> 后台执行本地去水印引擎
  -> 输出 userData/videos/<jobId>.clean.mp4
  -> 更新 options：
       cleanLocalPath
       originalLocalPath
       watermarkStatus: 'done' | 'failed'
       watermarkMethod
       watermarkError
  -> renderer 历史/预览优先读取 cleanLocalPath
```

处理失败时只发事件并更新状态，不把 job 改成 failed。用户可在历史记录中看到“去水印失败/重试”。

## 5. 实现要点

### 5.1 本地去水印引擎模块

新增 `apps/desktop/src/main/watermark-remover/engine.ts`，提供统一接口：

```ts
export interface WatermarkBBox {
  x: number
  y: number
  width: number
  height: number
}

export interface WatermarkProgress {
  jobId: string
  stage: 'detect' | 'ffmpeg' | 'inpaint' | 'done' | 'failed' | 'cancelled'
  progress: number
  message?: string
}

export interface WatermarkRequest {
  inputPath: string
  outputPath: string
  jobId: string
  bbox?: WatermarkBBox | null
  mode?: 'auto' | 'delogo' | 'inpaint'
  onProgress?: (progress: WatermarkProgress) => void
}

export interface WatermarkResult {
  ok: boolean
  outputPath?: string
  bbox?: WatermarkBBox | null
  method?: string
  status: 'done' | 'failed' | 'needs_bbox' | 'cancelled'
  error?: string
}
```

引擎实现策略：

- 内置 FFmpeg：优先使用 `ffmpeg-static` 或 electron-builder `extraResources` 提供的 `ffmpeg.exe`，不依赖系统安装 FFmpeg。
- 自动检测：采样若干帧，检测稳定角标/文字水印 bbox；检测不到时返回 `needs_bbox`，UI 可让用户框选或跳过。
- 静态水印 v1：bbox 已知时，优先用 FFmpeg `delogo` 重编码，免费、稳定、速度快。
- 质量增强：需要时使用本地 OpenCV inpaint 或 LaMa 修复关键帧后重组视频。
- 引擎保留可插拔接口，后续可替换成 Florence-2/LaMa 等本地 AI 模型。

### 5.2 dispatch.ts 集成

在 `dispatch.ts` 下载成功并写 job success 后启动后台去水印：

- 写 job success 时，在 `options` 中写入 `watermarkStatus: 'processing'`。
- 启动 `removeWatermark`，输入 `localPath`，输出 `userData/videos/<jobId>.clean.mp4`。
- 完成后更新 `options`：
  - `cleanLocalPath`
  - `originalLocalPath`
  - `watermarkStatus: 'done' | 'failed'`
  - `watermarkMethod`
  - `watermarkError`
- 失败路径不改变 job 状态，只发事件供 renderer 展示。

### 5.3 媒体服务与 renderer

- `src/main/index.ts` 的 `startMediaServer()` 需要允许 `/^[0-9a-fA-F-]+\.clean\.mp4$/`。
- `media:get-url` 的入参校验也需要允许 `*.clean.mp4`。
- `useJobs.ts` 从 `options.cleanLocalPath` 生成预览 URL。
- `localPath` 仍指向原文件，用于“打开所在文件夹”。
- 历史行显示去水印状态，并提供失败重试按钮。

### 5.4 IPC / preload API

新增 preload API：

```ts
watermark: {
  process: (jobId: string) => Promise<WatermarkResult>
  retry: (jobId: string) => Promise<WatermarkResult>
  cancel: (jobId?: string) => Promise<{ ok: boolean; reason?: string }>
  getStatus: (jobId: string) => Promise<WatermarkStatus | null>
  onProgress: (callback: (progress: WatermarkProgress) => void) => () => void
}
```

channel 统一使用 `watermark:*`。

### 5.5 数据字段

扩展 `apps/desktop/src/shared/history.ts` 的 `JobRecord`：

```ts
cleanLocalPath?: string | null
watermarkStatus?: 'none' | 'pending' | 'processing' | 'done' | 'failed' | 'needs_bbox' | null
watermarkMethod?: string | null
watermarkError?: string | null
```

数据库不改表结构，`jobs.options` JSON 中写入对应字段即可。

## 6. 打包方案

- electron-builder 当前 `files` 只打包 `out/**`。
- 需要把 FFmpeg 和本地 worker 作为 `extraResources` 或 `asarUnpack` 打进安装包。
- 优先提供 portable 工具目录，例如 `resources/ffmpeg/ffmpeg.exe`、`resources/watermark-worker/`。
- 模型默认放 `userData/models`，v1 不强制下载重型模型，默认走 delogo/OpenCV 快速路径。

## 7. 测试计划

- 单元/集成：用 FFmpeg 合成带静态角标水印的测试视频，验证自动检测、delogo/inpaint 输出存在、时长/分辨率保持一致、clean 文件可被媒体服务读取。
- 失败路径：mock 引擎失败，确认 job 仍为 success，UI 显示失败状态并可重试。
- 手工验收：
  - `pnpm typecheck`
  - `pnpm build`
  - `pnpm --filter @quota-flow/desktop run release:dir`
  - 生成/导入一个 job，验证自动处理、历史预览、打开文件夹、重试按钮。
- 打包验收：检查安装目录包含 FFmpeg 和本地 worker，不依赖用户机器预装 Python/FFmpeg。

## 8. 默认决策

- 默认采用“生成后自动处理”，用户无需手动触发。
- 优先本地免费方案，不接入在线去水印服务。
- 只对用户已生成的本地视频做后处理。
- 平台条款和版权/肖像风险由用户自行确认。
