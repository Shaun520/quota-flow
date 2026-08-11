# 豆包风控与受控验证（WebView 显示策略）

> 记录日期：2026-08-12
> 状态：现象已实测定位（风控响应特征）；**智能检测 + 按需弹窗已实现（2026-08-12）**：探针（响应体 + DOM）识别 verify/limit → 验证码弹窗交用户处理 / 限流快速失败 / 干预超时兜底；另提供「显示豆包窗口」手动开关
> 关联文档：[desktop-dispatch-doubao.md](desktop-dispatch-doubao.md)、[desktop-duration-channel-design.md](desktop-duration-channel-design.md)

---

## 1. 现象

调度台选择豆包生成视频时：

- App 侧任务一直停留在「生成中 / 排队」，最终超时失败（等待 280~360s 后报「等待超时未取到视频 URL」）；
- 豆包侧没有真正创建生成任务：会话列表无新消息落库，提示词没有进入生成；
- 同一设备指纹反复提交后，账号被风控加重（验证码 / 限制）。

## 2. 根因：豆包服务端风控

真实抓包 `/chat/completion` 响应体特征：

| 特征 | 含义 |
|---|---|
| `verify_scene: "doubao_message_web"` | 风控验证场景 |
| 加密 `detail`（验证码载荷），`decision.type=verify` 形态 | 需要人机验证 |
| SSE 以 `end_type:3` 结束，**无 `async_task`** | 生成任务未创建 |
| 页面消息仅前端乐观显示、不持久化 | 刷新后无新会话 |

触发因素：

- 同设备指纹（UA / device_id / fp）高频自动化提交；
- 账号当日多次生成/测试后触发风险控制；
- 可能伴随滑块 / 图形验证码，隐藏窗口下无法完成。

## 3. 处理方案：显示 WebView 进行受控验证

原则：**隐藏窗口默认静默生成；需要用户参与（验证码 / 风控）时显示 WebView 弹窗交用户操作。**

### 3.1 已实现（2026-08-12）：手动开关

设置 → 「调试：显示豆包窗口」：

- 默认隐藏（隐式）；
- 开启后生成时弹出豆包 WebView（1280×900，居中，标题「豆包生成 - Quota-Flow」）；
- 本地缓存 `qf-show-webview`（localStorage），切换即生效，重启保留；
- 用途：测试 / 观察生成过程、手动完成验证码（受控验证）。

传递链路：`Dashboard.tsx` → IPC `dispatch:generate`（`showWebview`）→ `dispatch.ts` → `webview-engine.ts`（`BrowserWindow show: options.showWebview === true`）。

### 3.2 智能检测 + 按需弹窗（已实现，2026-08-12）

1. 风控探针（`riskProbeScript`，页面加载后注入）：
   - 包装 `fetch`/`XHR` 读取 `/chat/completion` 响应体，识别 verify（`verify_scene` / `decision`）/ 限流（710022002 / 710022004）/ ok（`async_task`）→ 写 `window.__qfRisk`；
   - `MutationObserver` 监听验证 UI（安全验证 / 滑块 / 人机验证 / captcha iframe）。
2. 主进程每轮询 tick 读探针（`readDoubaoRisk`）：
   - `verify` → `showRiskWindow()`（`show` + `focus` + `center`）+ 事件上报 `risk-verify`，进入干预模式（不重试提交，等用户完成）；
   - `limit` → 直接失败（弹窗无用，报「豆包风控/限流」）。
3. 完成判定：探针归零（`async_task` 出现 / DOM 验证 UI 消失）→ 退出干预，恢复轮询；原为隐藏窗口则重新隐藏。
4. 干预超时（`RISK_TIMEOUT_MS`，5 分钟）→ 失败「豆包风控验证未完成，请手动重试」。

探针逻辑单测：`apps/desktop/scripts/risk-probe-test.cjs`（verify / limit / ok / plain 四例全部识别正确）。

## 4. 已知限制（暂不处理）

- 隐藏窗口下 Enter 提交在部分账号/页面上可能不触发（prompt 留在编辑器、无 `/chat/completion` 请求）。已决定暂不处理；测试 / 观察时可开启「显示豆包窗口」。

## 5. 代码位置

- 显示开关：`apps/desktop/src/renderer/src/components/Modals.tsx`（`qf-show-webview`）；
- 传递：`Dashboard.tsx` → `preload/index.ts` → `dispatch.ts` → `webview-engine.ts`（`showWebview`）；
- 引擎窗口：`apps/desktop/src/main/webview-engine.ts`（`show: options.showWebview === true`）。
