# 调度台图生视频（上传图片）方案

> 记录日期：2026-08-11
> 状态：方案已确认，豆包优先实现（上传链路 + 界面实测细化）

---

## 1. 现状

- Dashboard 上传区只有 UI（objectURL 缩略图），图片未随 IPC 发送；非 t2v 模式被 `handleGenerate` 拦截。
- 引擎（`webview-engine.ts`）只实现文生视频（填 prompt → 提交）。
- 厂商能力（迁移 0001）：豆包/即梦/元宝/可灵/海螺 = t2v+img；千问额外支持 multi_ref（≤5 图）/ first_last。
- 适配器：`mathmind.ts` 真 API 支持 img2video/imgs2video；`qwen.ts` img2video 请求结构已带 `resource/url` 但上传未实现（materialId 为 placeholder）；`yuanbao.ts` HTTP 支持单图 `sendPrompt(prompt, imageUrl)`。

## 2. 通用链路（WebView 厂商）

```
渲染层选图（File）→ webUtils.getPathForFile 拿真实路径 → IPC images[] 给主进程
→ 主进程读字节 → base64 data URL → 注入厂商页面：
   找上传 input/按钮 → DataTransfer 注入 File → change 事件 → 页面自动上传
→ 等上传完成（缩略图/chip 出现）→ 填 prompt → 提交 → 轮询
```

## 3. 分厂商实现方式

| 厂商 | 方式 | 要点 |
|---|---|---|
| 豆包（优先） | WebView 注入上传 | 视频界面找 `input[type=file]`/上传按钮 → 注入本地图 → 等豆包上传出图 → 填 prompt 提交。**核心难点**：图片 chip 在编辑器内，不能用现有 `setContent(prompt)` 整体清空（会删掉图片）；时长 chip 冲突问题在图生视频下会重现，需实测编辑器节点结构后定策略。 |
| 元宝 | WebView 上传为主 | 聊天附件上传 → 现有 autoSend/poll；HTTP 侧需先实现元宝上传接口（当前未抓）。限制：仅图片、≤10 张。 |
| 千问 | WebView 上传 + 截获 CDN URL | img2video 请求带 `resource/url`（workspace CDN + auth_key）；WebView 选图后截获上传 URL 再走 chat/detail；multi_ref / first_last 是千问特有。 |
| MathMind | 真 API（最容易） | `mathmind.ts` 已实现 img2video(imageUrl) / imgs2video(imageUrls)；需确认接受 base64 直传还是要求公网 URL。 |

## 4. 前端与链路改动

1. 选图时保存 File，生成时用 `webUtils.getPathForFile(file)` 拿路径（Electron 22+ 移除了 `File.path`）。
2. `dispatch.generate` 增加 `images: string[]`；主进程校验（扩展名/大小/数量）后读取，传给引擎。
3. `mode` 拦截放开：img2video 允许；multi_ref / first_last 待对应厂商支持后再放开。
4. 上传阶段加进度/失败事件。

## 5. 风险点

1. **编辑器图片 chip 与现有提交逻辑冲突**：图生视频不能整体清空编辑器；需「上传图片 → 在保留图片的前提下插入 prompt 文本」的新提交路径（v1 实现：上传后光标移末尾插入文本，不清空）。
2. 上传 DOM/时序各家不同：上传控件选择器、完成判定（缩略图/chip）、多图上限，均需对着真实页面实测。
3. 本地文件安全：仅读用户所选图片，校验扩展名/大小。

## 6. 接入顺序

1. 豆包（优先）：WebView 上传 + 图生视频提交。
2. MathMind：真 API，确认传图方式后最快。
3. 元宝 → 千问：WebView 上传 + 现有轮询，先单图。
4. 即梦/可灵/海螺：同框架后续补齐。

## 7. 豆包界面需实测确认

- 图片上传入口 DOM（input / 按钮 / 粘贴）。
- 上传完成判定（缩略图 / chip / 「上传中」文案消失）。
- 图片 chip 在编辑器里的节点结构（决定插入文本与时长策略）。
- 图生视频提交后回复形态（轮询取 URL 可复用）。
- 豆包 img 模式是否限单图。
