# Cookie 自动续命设计

> 状态：**已实现**（2026-08-12：调度器 `main/cookie-renew.ts` + `visitAndCapture` + 设置开关 + 状态栏）· 关联设置项：设置 →「自动续命 Cookie」

## 1. 现状盘点

| 部分 | 现状 |
|---|---|
| 设置项开关 | 占位：`Modals.tsx` 中 `cookieRenew` 仅 useState，无保存、无应用 |
| "自动续命：03:00" 展示 | `App.tsx:201` 静态文字，无定时器支撑 |
| 定时调度 | 无（全仓库仅一次性轮询/超时，无周期任务） |
| 底层能力 | **已具备且可复用**：隐藏窗口 + 账号级分区（`partitionFor`）+ cookie 注入/抓取 + safeStorage 加密 + `PROVIDER_SITES` 站点配置 + healthUrl 探测 |

## 2. 原理与边界

厂商 cookie 分两类：

- **滑动会话型**（大多数厂商）：服务端按活跃度续期，定期"正常访问"即可无限延续 → **可自动化续命**
- **硬 TTL 型**：到期即废，必须人工重新登录 → 无法绕过，续命只能延后、不能杜绝重登

**准确定义**：周期性用隐藏窗口模拟用户活跃访问厂商站点，最大化会话存活时长（目标：把重登频率从每周降到 1-2 月）。依赖 `cookie_expires_at` 判断会话剩余时间，接近过期才触发续命，而非天天硬刷（降低风控暴露面）。

## 3. 方案设计

### 3.1 定时调度（主进程，`cookie-renew.ts`）

- 应用启动时拉起递归 `setTimeout` 定时器：每日 03:00 触发 + 每账号按 `cookie_expires_at` 提前 24h 触发
- 触发条件：设置开关开启 && 账号 `enabled` && 非 `expired`
- 与健康检查（4/8/12h 可配）天然错开：健康检查只**探测**状态，续命要**抓取并写回**数据
- 应用休眠/关机漏跑 → 启动时检查 `last_health_check` / `cookie_expires_at`，决定是否立刻补一轮

### 3.2 续命动作

```
打开隐藏 BrowserWindow（partitionFor 同分区、CHROME_UA 同 UA）
→ injectCookies 注入该账号旧 cookie
→ 加载站点健康页/创作页，静默停留 5-10s（模拟活跃）
→ 复用登录时的 cookie 抓取逻辑重新抓取（cookies + localStorage + storages）
→ 会话仍有效：safeStorage 加密 → refreshProviderKey 写回
    （encrypted_key 更新 + cookie_expires_at 顺延）
→ 401/403/跳登录页：updateHealth 写 expired，提示用户重新登录
```

### 3.3 设置开关可达性（关键接线）

- 现有设置全部在 renderer 侧的 `localStorage`，续命定时器在主进程读不到
- 方案：renderer 保存时通过 IPC（如 `settings:set`）同步给主进程，或落 `userData/settings.json`
- `App.tsx` 的「自动续命：03:00」改为渲染主进程回传的定时器真实状态（下次执行时间）

### 3.4 并发与风控

- 并发 1 个隐藏窗口，多账号顺序执行
- 每账号每天最多 1 次，账号间错峰 5 分钟
- 连续续命失败 N 次即熔断停止，提示人工重登

## 4. 风险与对策

| 风险 | 对策 |
|---|---|
| 风控 | 固定凌晨 + 每天 1 次低频率；熔断机制 |
| 抓取残缺（验证码/风控页导致 cookie 不完整） | 比较抓取数量，低于阈值放弃写回，保留旧 cookie |
| 硬 TTL 厂商续命无效 | 无法自动化，靠人工重登；续命仅延后 |

## 5. 工作量拆解

1. **基础设施（中）**：从 `openLoginWindow` 抽出可复用的 `visitAndCapture(providerId, keyId, url)`（打开 → 停留 → 抓 cookie），返回 cookie 集 + 会话有效性
2. **调度器（小）**：`cookie-renew.ts` 定时器 + 触发条件 + 熔断
3. **设置通道（小）**：IPC 设置同步 + 开关读取
4. **UI 接线（小）**：`App.tsx` 状态文字接通定时器真实状态；开关保存
5. **自测（中）**：真实厂商跑 1-2 轮，验证 `cookie_expires_at` 顺延与数据完整性

> 建议实施顺序：先 1+2+3 验证有效性，再接线 UI。