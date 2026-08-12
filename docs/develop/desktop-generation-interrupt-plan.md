# 生成中断处理方案（意外中断状态 + 关闭确认 + 发送前可终止）

> 记录日期：2026-08-12
> 状态：方案已确认，按此实现

---

## 一、背景与现状

- 任务状态：`pending / running / success / failed / not_generated`，**没有“中断”状态**；历史页把 pending/running 都显示为“排队”。
- 关闭流程：`window:close` IPC → `BrowserWindow.close()`，无拦截、无确认；主进程无“是否有生成在跑”的标记。
- 生成流程：`runGenerate` 一个 async 函数从头等到底，无取消机制。
- `recoverOrphanedJobs`（启动自动恢复）已在引擎重构中移除，符合“不自动恢复生成”的要求。
- 关键边界：豆包引擎在提交成功后有 `submit-verify` 阶段，可作为“提示词已发送”的判定点。

## 二、需求与设计

### 1. 意外中断状态（下次进入时标记）

- `JobStatus` 增加 `interrupted`，历史页显示「意外中断」（badge 用警示色）。
- 渲染层登录后启动清扫：把所有 `pending/running` 的任务更新为 `interrupted`，错误信息写“应用意外退出，生成中断”。
  - 清扫发生在登录后、任何新生成开始前，此时遗留的 pending/running 必然是上次会话的，不会误伤本次任务。
  - 幂等：只改 pending/running。
- 不做自动恢复。

### 2. 关闭时的友好确认

- 主进程维护活跃生成注册表 `activeRuns: Map<jobId, { aborted, submitted }>`，`dispatch:generate` 登记、结束时清除。
- `BrowserWindow` 挂 `close` 事件：有生成在跑时 `preventDefault()`，弹原生确认框（`dialog.showMessageBox`）：
  - “当前有视频正在生成，关闭应用将中断生成，确定要关闭吗？” ［取消 / 确认关闭］
  - 确认 → 放行关闭；取消 → 不关闭。
- 覆盖所有关闭入口：标题栏 X、Alt+F4、任务栏关闭都走 `close` 事件。

### 3. 终止生成（发送前可终止，发送后不可）

- 活跃任务注册表 + 新增 IPC `dispatch:cancel(jobId)`。
- 引擎（`runDoubaoGeneration`）接收共享 `{ aborted, submitted }` 状态，在**提交前的每个阶段边界**检查 `aborted`（注入登录态/打开页面/进视频界面/设置时长/上传图片/填入提示词之前），命中即销毁窗口并返回“已终止”。
- 提交成功后置 `submitted = true`，之后的 `cancel` 返回 `{ ok: false, reason: '提示词已发送，无法终止' }`。
- 渲染层：生成中显示“终止生成”按钮；阶段进入 `submit / submit-img2video / submit-verify / waiting` 后隐藏/禁用。
- 取消成功 → 任务标记 `interrupted`（错误信息“已手动终止生成（提示词未发送）”）。
- jobId 通过 `job:event` 的 running 事件捕获（事件本身带 jobId）。

## 三、决策点（默认采用）

1. 手动终止复用 `interrupted` 状态（显示“意外中断”，错误信息注明“已手动终止”）。
2. 关闭确认文案采用上面的默认文案。
3. 启动清扫范围：所有 pending/running 任务（当前引擎只有豆包，全扫即可）。

## 四、涉及改动点

| 文件 | 改动 |
| --- | --- |
| `packages/db-supabase` | `JobStatus` 增加 `interrupted` |
| `apps/desktop/src/renderer/src/shared/history.ts` | `HistoryStatus` 增加“意外中断” |
| `useJobs.ts` | 状态映射加“意外中断” |
| `App.tsx` | 登录后清扫 pending/running → interrupted |
| `History.tsx` | badge / 预览文案支持“意外中断” |
| `main/index.ts` | `dialog` 引入 + `close` 拦截确认；`activeRuns` 注册表；`dispatch:cancel` IPC |
| `dispatch.ts` | 创建/传递 `{ aborted, submitted }`；cancelled 结果写 interrupted |
| `webview-engine.ts` | 提交前阶段边界检查 aborted；提交后置 submitted |
| `preload/index.ts` | dispatch 增加 `cancel(jobId)` |
| `Dashboard.tsx` | 捕获 jobId、终止按钮、发送后隐藏 |

## 五、验证

- typecheck + build 通过；
- 手工验证：生成中关闭应用弹确认框；确认后重启，遗留任务显示“意外中断”；发送前点“终止生成”任务中断；发送后终止按钮隐藏。

---

## 六、二轮修复（2026-08-12）：立即停止 + 停止按钮合并 + 防连点）

### 问题

1. 「准备中」阶段任务尚未注册进 `activeRuns`，此时点停止返回“任务不存在或已结束”，停止无效且界面刷红字。
2. 取消是阶段边界检查：若在 `fillAndSubmitScript` / `uploadImagesScript` 执行期间点停止，脚本跑完可能已发送提示词，引擎在脚本返回后没有 abort 检查，会继续生成。
3. 重复点击：`cancelling` 只锁住 IPC 往返，连点反复请求、错误文字闪现。
4. 阶段文案“准备中”与实际任务时机错位。

### 修复设计

1. **待取消标志**：`dispatch:generate` 进入即置 `isGenerating`；任务注册前点停止 → 置 `pendingCancel` 并返回成功；任务注册（`onJobCreated`）时若 `pendingCancel` 立即置 `aborted=true`；生成结束清理标志。→ 准备中阶段点停止也立即生效。
2. **脚本返回后补 abort 检查**：引擎在 `fillResult.ok` 之后、置 `submitted` 之前检查一次 abort，命中即销毁窗口返回中断；dispatch 在调用 `runDoubaoGeneration` 前也检查一次（注册即取消时近零延迟）。
3. **UI 停止状态机**：第一次点停止后按钮锁定“正在终止…”直到任务真正结束；主进程返回“提示词已发送”时按钮切回“生成中…”并只提示一次；重复点击忽略。
4. **阶段文案对齐**：`pending` 事件显示“正在创建任务…”，不再出现与真实时机脱节的裸“准备中”。
5. **停止按钮与生成按钮合并**：生成中主按钮即“停止生成”（发送前）/“生成中…”（发送后）。
