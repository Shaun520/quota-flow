# 桌面端历史记录模块 — 设计方案

> 状态：已实现（2026-08-10 落地；含两处偏离：状态新增“未生成”、生产路径走 userData；
> 同日升级为数据库为真相源：0003_jobs 迁移 + JobService + renderer 直连 Supabase）
> 更新时间：2026-08-10

---

## 1. 现状分析

### 1.1 当前问题

| 层级 | 文件 | 现状 |
|---|---|---|
| UI | `apps/desktop/src/renderer/src/components/History.tsx` | import 静态 `HISTORY_ROWS`（10 条写死假数据），无任何数据通道 |
| 数据定义 | `apps/desktop/src/renderer/src/data.ts` | `HISTORY_ROWS` 硬编码 mock，第 1 行注释标注"后续接入 Supabase / IPC 后替换" |
| 真实数据 | `data/jobs.jsonl` | **已有 11 条真实记录**，由 CLI `generate` 写入（`apps/cli/src/cli.ts:135-161`），字段齐全但 renderer 完全读不到 |
| IPC 桥 | `apps/desktop/src/preload/index.ts` | 无 `history` 相关 API |
| 主进程 | `apps/desktop/src/main/index.ts` | 无 `history:*` IPC handler |

**核心矛盾**：真实数据在本地 JSONL 文件里，UI 从静态变量读，中间没有 IPC 桥接。

### 1.2 `jobs.jsonl` 数据结构

每行一条 JSON，示例：

```json
{
  "at": "2026-08-07T03:31:57.147Z",
  "mode": "img2video",
  "options": {
    "mode": "img2video",
    "prompt": "画面缓慢推近",
    "imageUrl": "https://example.com/***"
  },
  "attempts": [{ "providerId": "mathmind", "ok": true }],
  "result": {
    "ok": true,
    "providerId": "mathmind",
    "traceId": "mathmind-dryrun-1786073517142",
    "quotaUsed": 1,
    "qualityScore": 3.5,
    "errorMessage": null
  },
  "mathmindCalls": [...]
}
```

### 1.3 字段覆盖分析

| 表格列 | jobs.jsonl 字段 | 映射方式 |
|---|---|---|
| 提示词 | `options.prompt` | 直接取 |
| 厂商 | `result.providerId` | 英文 id → 中文名（查 providers seed 或硬编码映射） |
| 模式 | `mode` | `text2video`→`文生视频`，`img2video`→`图生视频` 等 |
| 消耗 | `result.quotaUsed` + 厂商单位 | 结合 providers 表 `unit_name` 拼成 `N 点/灵感值/积分/次` |
| 状态 | `result.ok` / `attempts` | `ok=true`→成功，`ok=false`→失败，`result=null` 且有 attempts→排队 |
| 质量 | `result.qualityScore` | 直接取，null 时显示 `-` |
| 预览 | 无对应字段 | 统一显示占位文字（现有逻辑保留） |
| 操作 | 无对应字段 | 查看/下载/删除（暂为占位，后续接真实 URL） |
| 时间 | `at` | ISO 时间戳，前端格式化为相对时间 |

**结论**：`jobs.jsonl` 能覆盖全部核心列，不需要改 schema。

---

## 2. 架构设计

### 2.1 数据流

```
┌──────────────────────────────────────────────────────┐
│  Renderer (History.tsx)                              │
│  useEffect(() => api.history.list(), [])             │
│  过滤/分页用 useState                                 │
└──────────────┬───────────────────────────────────────┘
               │  ipcRenderer.invoke('history:list')
┌──────────────▼───────────────────────────────────────┐
│  Preload (index.ts)                                  │
│  history: { list() → JobRecord[] }                   │
└──────────────┬───────────────────────────────────────┘
               │  ipcMain.handle('history:list')
┌──────────────▼───────────────────────────────────────┐
│  Main Process (history.ts)                           │
│  读 data/jobs.jsonl → 解析 → 排序 → 字段转换 → 返回  │
└──────────────────────────────────────────────────────┘
```

> 升级说明（数据库为真相源）：§6.2 落地后，History 已改为 renderer 直连 Supabase
> 查询 jobs 表（与 Providers 页的 ProviderService 模式一致），本地 JSONL 的 IPC 链路
> （main/history.ts + preload history API）已移除；RLS 负责按本人/团队隔离可见性。

### 2.2 与现有模式的一致性

项目已有的 IPC 模式（`auth:*`、`provider:*`、`webview-test:*`）完全复用：
- 主进程注册 `ipcMain.handle(channel, handler)`
- preload 通过 `ipcRenderer.invoke(channel)` 暴露给 renderer
- renderer 通过 `window.api.xxx` 调用

历史模块新增 `history:list` 和 `history:delete`，与现有模式一致。

---

## 3. 具体改动点

### 3.1 主进程：新建 `src/main/history.ts`

**职责**：读取本地 `data/jobs.jsonl`，解析并返回结构化数据。

```typescript
// IPC channel: history:list
// 1. 读 data/jobs.jsonl（路径解析与 CLI 一致）
// 2. 逐行 JSON.parse，跳过格式异常行
// 3. 按 at 降序排列（最新在前）
// 4. 字段转换（见 §4 转换规则）
// 5. 返回 JobRecord[]
```

同时预留 `history:delete`：从 jobs.jsonl 中移除指定行（按 `at` 时间戳匹配），重写文件。

在 `src/main/index.ts` 中加一行 `initHistory()` 调用。

### 3.2 Preload：暴露 API

在 `DesktopApi` 接口和 `api` 对象中新增：

```typescript
history: {
  list: () => Promise<JobRecord[]>
  delete: (at: string) => Promise<void>
}
```

`JobRecord` 类型定义在 preload（与 renderer 共享）：

```typescript
interface JobRecord {
  at: string           // ISO 时间戳
  provider: string     // 中文名：豆包、即梦...
  mode: string         // 中文模式：文生视频、图生视频...
  prompt: string       // 提示词
  cost: string         // 消耗：如 "1 点"、"80 灵感值"
  status: '成功' | '排队' | '失败'
  quality: string      // 质量分，如 "4.5" 或 "-"
  traceId: string | null
  errorMessage: string | null
}
```

### 3.3 History.tsx：替换数据源

改动量约 15 行：

1. **删除** `import { HISTORY_ROWS } from '../data'`
2. **新增** `useState<JobRecord[]>` + `useEffect` 调用 `window.api.history.list()`
3. 筛选项 `providers` 从拉回来的数据动态生成（不变）
4. 筛选/分页逻辑完全复用（不变）
5. 加载态显示 skeleton 或空态文案

### 3.4 data.ts：清理

删除 `HISTORY_ROWS` 常量及其 `HistoryRow` 类型（约 20 行），或保留但标注 `@deprecated`。

---

## 4. 字段转换规则

### 4.1 Provider ID → 中文名

```typescript
const PROVIDER_NAME_MAP: Record<string, string> = {
  mathmind: 'MathMind',
  qwenwan: '通义万相',
  yuanbao: '元宝混元',
  doubao: '豆包',
  jimeng: '即梦',
  kling: '可灵',
  hailuo: '海螺',
}
```

### 4.2 Mode → 中文标签

```typescript
const MODE_LABEL: Record<string, string> = {
  text2video: '文生视频',
  img2video: '图生视频',
  video2video: '视频转视频',
  imgs2video: '多图生视频',
}
```

### 4.3 Provider ID → 额度单位

```typescript
const UNIT_MAP: Record<string, string> = {
  mathmind: '次',
  qwenwan: '额度',
  yuanbao: '个',
  doubao: '点',
  jimeng: '灵感值',
  kling: '积分',
  hailuo: '次',
}
```

转换示例：`result.providerId=yuanbao, result.quotaUsed=1` → 厂商=`元宝混元`，消耗=`1 个`

### 4.4 状态判定

```
result.ok = true                       → 成功
result.ok = false                      → 失败
result=null && attempts.length > 0     → 排队（生成中）
result=null && attempts 为空           → 未生成（无可用厂商派发：额度耗尽/冷却/离线）
```

> 落地说明：`attempts` 为空且 `result` 为 null 表示调度时没有任何可用厂商派发
>（router 中 pick 直接返回 null），显示为“排队”会造成永久“生成中”的假象，
> 因此实现中作为独立第四状态“未生成”展示（灰色 badge）。

### 4.5 时间格式化

| 条件 | 显示 |
|---|---|
| < 1 分钟 | `刚刚` |
| < 60 分钟 | `N 分钟前` |
| < 24 小时 | `N 小时前` |
| < 7 天 | `N 天前` |
| 其余 | `YYYY-MM-DD HH:mm` |

---

## 5. 改动文件清单

| 文件 | 改动类型 | 行数估计 | 说明 |
|---|---|---|---|
| `src/main/history.ts` | **新建** | ~60 行 | IPC handler，读 jobs.jsonl，转换字段返回 |
| `src/main/index.ts` | 修改 | +1 行 | `initHistory()` 调用 |
| `src/preload/index.ts` | 修改 | +20 行 | `DesktopApi` 接口加 `history`，`api` 对象加实现 |
| `src/renderer/src/components/History.tsx` | 修改 | ~15 行 | 换 useEffect 数据源，删静态 import |
| `src/renderer/src/data.ts` | 修改 | -20 行 | 删 `HISTORY_ROWS` 及 `HistoryRow` 类型 |

**总改动量**：约 80 行（含新建文件），无 schema 变更，无数据库迁移。

---

## 6. 后续扩展路径

### 6.1 删除功能

✅ 已实现：`JobService.deleteJob` / `deleteJobs` 按数据库 id 删除（RLS 仅限本人），
renderer 支持单条删除与批量删除（行勾选 + 全选/半选当前筛选结果 + 确认弹窗），删除成功后刷新列表。

### 6.2 团队共享历史

✅ 已实现（2026-08-10）：
- 新增 `migrations/0003_jobs.sql`：jobs 表 + RLS（团队成员可见本团队任务，写入需本人且属于该团队，删除仅限本人）
- `@quota-flow/db-supabase` 新增 `JobService`（listJobs / insertJob / deleteJob），类型为显式接口（沿用 ProviderService 模式）
- CLI `generate` 成功后写库：从环境变量读取 `SUPABASE_URL` / `SUPABASE_ANON_KEY` /
  `QUOTA_FLOW_EMAIL` / `QUOTA_FLOW_PASSWORD` 登录后写入；未配置时跳过写库并提示，
  本地 `jobs.jsonl` 仍作为审计日志保留。环境变量写在 `apps/cli/.env`（已 gitignore，
  值复制自桌面端 `apps/desktop/.env` 的 `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY`，
  邮箱密码为桌面端注册账号）
- 桌面端 History 页改为 renderer 直连 Supabase（`useJobs` hook），删除主进程本地 JSONL 读取链路
- 桌面端 dispatch 落地后可复用 `JobService.insertJob` 写库，无需新增读取链路

### 6.3 视频预览

✅ 已实现：桌面端 dispatch 成功后将视频下载落盘到 `userData/videos/<jobId>.mp4`（避免签名 URL 过期），
`result_url` 记录本地路径、`options.localPath` 记录绝对路径；历史页通过本地媒体服务
（127.0.0.1 随机端口，支持 Range）渲染首帧缩略图与行内播放。
操作列不再提供“下载”，改为“打开所在文件夹”（`shell.showItemInFolder`，仅允许访问 videos 目录）。

### 6.4 实时刷新
dispatch 完成后主进程发 `webContents.send('history:updated')`，renderer 监听该事件自动调用 `list()` 刷新列表，无需用户手动切换 tab。

### 6.5 统计面板
基于历史数据聚合：各厂商调用次数、成功率、平均质量分、日/周趋势图，可作为 Dashboard 的补充卡片。

---

## 7. 注意事项

- `jobs.jsonl` 是 append-only 日志，删除操作需重写整个文件，高并发下可能冲突（桌面端单实例运行无此问题）
- 路径解析：开发/预览模式与 CLI 一致，读仓库根 `data/jobs.jsonl`
  （通过 `app.getAppPath()` 定位，不能用 `__dirname` 数 `..`，主进程产物在 `out/main`，层数与 CLI 不同）；
  打包后 `data/` 不在 asar 发布范围内，落到 `app.getPath('userData')/data/jobs.jsonl`；
  数据库为真相源后，JSONL 仅作 CLI 审计日志，不再参与 UI 展示
- `providerName` / 单位映射在 renderer（useJobs）中硬编码（已兼容 `qwen`/`qwenwan` 两种 ID），
  后续可改为从 Supabase `providers` 表动态拉取（已有 `listProviders()` API）
- 预览列已支持本地视频缩略图/播放；本地文件在 `userData/videos`，删除历史记录不会自动清理文件（后续可补）
