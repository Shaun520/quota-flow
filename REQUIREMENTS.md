# Quota-Flow 需求文档

> 视频生成免费额度统一调度平台 · 把豆包 / 即梦 / 通义万相 / 元宝混元 / 可灵 / 海螺 / mcp_mathmind-video 等多家厂商的每日免费额度聚合成一个可调度、可观测、可共享的池子。

---

## 1. 项目定位

### 1.1 一句话定位
在每家视频生成厂商的"每日免费额度"之上，加一层"额度账本 + 智能调度 + 多账号池化 + 团队共享"，让多家的免费额度用起来像同一个池子。

### 1.2 核心价值
- **额度为一等公民**：先查账、再选路、调用后回写账本，0 点自动滚动
- **聚合而非转售**：用户自带 cookie/apikey，平台不付流量费、不抽佣、不对外卖 API
- **团队共享额度池**：多人多账号额度叠加成一个池子（核心创新点）
- **工具而非服务**：桌面端是唯一产品入口，落地页只做营销不做功能

### 1.3 与竞品差异
| 维度 | FreeLLMAPI | OpenRouter / LiteLLM | Quota-Flow |
|---|---|---|---|
| 对象 | LLM 文本/嵌入/图像/音频 | LLM | 视频生成免费额度 |
| 免费额度聚合 | 是（29 家 LLM） | 否（按量计费） | 是（视频厂商） |
| 多账号池化 | 是（per-key） | 可配多 key | 是（团队共享池） |
| 分发形态 | npm/Docker/桌面端/SaaS | SaaS | 桌面端 + Skill |
| 定位 | 商业 SaaS | 商业 SaaS | 开源工具 + 官方托管 |
| 国内视频厂商支持 | 否 | 否 | 是（7 家） |

---

## 2. 用户角色

| 角色 | 描述 | 典型场景 |
|---|---|---|
| 个人用户 | 自用聚合多家免费额度 | 把 7 家厂商账号绑进来，每天用一个池子调 |
| 团队 admin | 小团队管理员 | 绑团队公共 cookie，邀请成员，共享额度池 |
| 团队 member | 被邀请加入团队 | 消费团队额度生成视频，看不到 admin 的 cookie 明文 |
| 自部署用户 | 技术用户/隐私敏感 | 自己注册 Supabase，完全脱离官方托管 |
| 平台运营者 | 你（admin 后台） | 管团队、配 Provider、监控、手动开通订阅、维护消耗表 |

---

## 3. 商业模式

### 3.1 模式 A：开源 + 官方托管 + 自部署

**开源策略**：
- 全部开源：packages/* + apps/web + apps/desktop + apps/cli + apps/skill + apps/admin（含运营后台与额度扣减规则）

**两种使用方式**：

| 维度 | 官方托管（推荐） | 自部署 |
|---|---|---|
| 数据库 | 用我的 Supabase | 用户自己注册 Supabase |
| 首次配置 | 下载桌面端 注册账号 直接用 | 下载桌面端 注册 Supabase 填 URL+anon key 用 |
| 数据归属 | 存在我的 Supabase（你运维） | 存在用户自己的 Supabase（用户运维） |
| 席位限制 | 免费 3 人，付费扩展 | 无限制 |
| 费用 | 免费层 $0，付费 $9/$29 月 | 永远 $0（用户自己养 Supabase） |
| 可用性 | 跟着我的 Supabase 走 | 跟用户自己的 Supabase 走 |
| 数据隐私 | 数据在我的 Supabase | 数据完全自己掌控 |
| 客服支持 | GitHub Issues + 邮箱 | 无客服支持，出问题自行排查 |
| 自动更新 | electron-updater | 手动 git pull 或下 GitHub Releases |
| admin 监控 | 可见 | 完全不可见 |
| 适合 | 95% 普通用户 | 技术用户、隐私敏感、企业内网 |

### 3.2 订阅体系（官方托管）

| 套餐 | 价格 | 席位 | 适合 |
|---|---|---|---|
| 个人免费 | $0 | 1 人 | 个人用户 |
| 团队免费 | $0 | 最多 3 人 | 小团队尝鲜 |
| 团队 Pro | $9/月 | 最多 10 人 | 正经小团队 |
| 团队 Business | $29/月 | 最多 30 人 | 大团队 |

**关键设计**：所有套餐功能完全一致，唯一区别是**团队人数上限**。

| 功能 | 个人免费 | 团队免费 | 团队 Pro | Business |
|---|---|---|---|---|
| 厂商数量 | 不限 | 不限 | 不限 | 不限 |
| 生成次数 | 不限 | 不限 | 不限 | 不限 |
| apikey/cookie 数量 | 不限 | 不限 | 不限 | 不限 |
| 基础调度（轮询/降级） | 是 | 是 | 是 | 是 |
| 额度账本 + 看板 | 是 | 是 | 是 | 是 |
| 多账号池化 | 是 | 是 | 是 | 是 |
| Skill / CLI 入口 | 是 | 是 | 是 | 是 |
| 团队共享额度池 | 否 | 是 | 是 | 是 |
| 成员管理 | 否 | 是 | 是 | 是 |
| 防滥用机制 | 否 | 是 | 是 | 是 |
| 历史记录 | 无限 | 无限 | 无限 | 无限 |
| 客服优先级 | 普通 | 普通 | 优先 | 优先 |
| 席位上限 | 1 | 3 | 10 | 30 |

### 3.3 支付系统

**MVP 阶段：手动开通**
1. 用户在桌面端看到升级提示 联系运营者（邮件/GitHub Issues）
2. 用户微信/支付宝转账
3. 运营者在 admin 后台手动开通订阅（选套餐、设席位、设到期时间）
4. 用户桌面端刷新看到订阅生效

**后期**：接微信支付 + 支付宝商户号（需企业主体）

### 3.4 赞助入口

- 落地页顶部或侧边"赞助支持"按钮（GitHub Sponsors / Buy Me a Coffee）
- 桌面端设置 Tab 的"关于"区域放赞助链接
- README 顶部赞助徽章

---

## 4. 团队额度池模型

### 4.1 两种额度来源

**来源 1：团队公共额度（admin 绑的 cookie/key）**
- admin 绑多家厂商的多账号 cookie/apikey，加密存 Supabase
- 这是团队公共财产，所有成员都能用
- cookie/key 明文只有 admin 能看

**来源 2：成员自带额度（成员自绑，可选）**
- 成员自己也有些厂商账号，自愿绑进团队
- 默认进总池（模式 A），admin 可改设置为"仅本人可用"
- key 明文只有绑定者本人能看，admin 也看不到

### 4.2 团队总池 = 公共额度 + 成员自带额度

举例：3 人团队（admin 小张 + member 小王 + member 小李）
- 小张绑团队公共：豆包x3 账号 + 千问x2 账号 = 50 次/日（豆包按次数，千问按次数）
- 小王自带：即梦x1 = 800 灵感值/日（即梦按灵感值）
- 小李自带：元宝x1 = 30 次/日
- **团队总池**：在 UI 上统一折算显示"约 110 等效次数/日"（灵感值按消耗表换算成等效次数用于总览展示，实际扣减仍按各厂商原生单位）

### 4.3 等效次数换算（仅用于总览 UI）

由于不同厂商额度单位不同（次数 / 积分 / 灵感值），团队总池在 UI 上显示"等效次数"：
- 等效次数 = Σ(各厂商剩余额度 / 该厂商单位等效次数分母)
- 等效分母由 admin 后台维护（providers 表的 equivalent_count_divisor 字段 + provider_cost_tables）
- 等效次数仅用于 UI 展示和排序，以及成员日用度上限统计；实际扣减走各厂商原生账本单位

### 4.4 两层约束（防滥用）

**第 1 层：团队总池（共享）**
- 所有可用 cookie/key 额度加起来（按等效次数展示）
- 任何人调用都从对应厂商的对应账号扣原生单位
- 某厂商某账号耗尽 → 自动切同厂商下一个账号，同厂商全部耗尽 → 路由切其他厂商

**第 2 层：成员日额度上限**
- admin 给每个 member 设上限（如每人每天最多 30 等效次数）
- 成员每次消耗按等效次数累计，超限冻结到次日
- 即使总池还有，超限成员也被冻结

**叠加规则**：成员能用 = min(团队总池剩余, 自己的日额度上限剩余)

### 4.5 成员退出处理

| 数据 | 处理方式 |
|---|---|
| 成员自带的 cookie/key | 自动从总池移除，导出给本人，团队总池相应减少 |
| 成员历史任务记录 | 留在团队账本（审计需要），本人失去访问权 |
| 成员消费的额度 | 不退回（已用就用了） |

### 4.6 apikey 明文可见性（分层解密权限）

| 角色 | 能看到哪些 key 明文 |
|---|---|
| admin | 自己绑的团队公共 key |
| member | 自己绑的自带 key |
| admin 看 member 自带 key | 看不到明文，只能看到"小王贡献了 N 等效次数/日" |
| member 看 admin 公共 key | 看不到明文，只能调度使用 |

**member 要用团队公共 key 生成视频时**：
- 走"代调用" 把请求转给 Supabase Edge Function
- 代调用方解密 key 后调厂商
- 桌面端只拿结果，key 不出云端

---

## 5. 技术架构

### 5.1 整体分层

```
Vercel（两个独立项目）
  web/     落地页：定价/文档/下载/注册/赞助
  admin/   后台管理（开源）
                |
                | 短查询：CRUD
                | 代调用：Edge Function（member 调公共 key）
                v
Supabase（数据库 + Auth + Edge Functions）
  Postgres：账本、key、jobs、用户、团队、消耗表
  pg_cron：每日 0 点额度滚动、凌晨 4 点 cookie 健康检查
                ^
                | 桌面端直连（写 job / 查账本 / 读消耗表）
                |
桌面端 Electron（唯一产品入口）
  React UI（4 Tab：调度台/历史/团队/设置）
  内嵌注册/登录页 + 选模式（官方托管 vs 自部署）
  本地调度引擎（packages/core + providers）
  全 7 家厂商支持（统一 WebView 提交方案，见 5.12）
    mcp_mathmind：真 API（仅例外）
    豆包/即梦/通义/元宝/可灵/海螺：WebView cookie 注入 + 自动提交
  WebView 统一执行引擎（隐藏后台，用户不可见）
    每个团队共享 cookie → 独立隔离会话（session.fromPartition）
    提交：两种模式（模拟用户操作 / 调页面内部 JS API）
    结果：拦截 Network 响应 + 读 DOM 提取视频 URL
    保活：每天静默访问厂商页面一次，自动续命 cookie
  所有数据走 Supabase（官方或自部署）
```

### 5.2 桌面端执行路径

桌面端是 Electron 本地长进程：
- 无 Vercel 函数超时限制（视频生成 1-5 分钟可阻塞）
- 无 CORS（Node 进程不受浏览器同源策略约束）
- cookie 在本地内存解密（个人账号 / 成员自带账号）
- 团队公共账号走 Supabase Edge Function 代调用（key 不出云端）
- 调用完成后立即写回 Supabase

### 5.3 Monorepo 结构（pnpm + Turbo）

```
quota-flow/
packages/
  core/              调度核心（路由、降级、账本逻辑、等效次数换算）
  providers/         7 家厂商适配器（含 estimateCost 动态估算）
  crypto/            AES 加密
  db-supabase/       Supabase 客户端 + 消耗表缓存
  shared-ui/         React 共享组件
  cookie-manager/    cookie 健康检查 + 自动续期
  logger/            统一日志（jobs.jsonl 追加）
  auth/              Supabase Auth 封装
  migrations/        SQL 迁移脚本（按序执行，含 provider_cost_tables 初始数据，见 §5.7）
apps/
  web/               落地页（Next.js + React，Vercel）
  admin/             后台管理（Next.js + React，Vercel）
  desktop/           Electron + React（唯一产品入口）
  cli/              命令行
  skill/            SKILL.md（可选附件）
package.json
pnpm-workspace.yaml
turbo.json
tsconfig.base.json
.npmrc
```

### 5.4 Turbo 任务图

```jsonc
{
  "pipeline": {
    "typecheck": { "dependsOn": ["^typecheck"] },
    "build":     { "dependsOn": ["^build", "^typecheck"], "outputs": ["dist/**"] },
    "test":      { "dependsOn": ["build"] },
    "lint":      { "dependsOn": ["^build"] },
    "dev":       { "cache": false, "persistent": true },
    "desktop:build": { "dependsOn": ["build"], "outputs": ["release/**"] }
  }
}
```

### 5.5 .npmrc

```ini
enable-pre-post-scripts = true
only-built-dependencies = electron,better-sqlite3,vite,esbuild,sharp
```

### 5.6 技术选型

- **后端**：Node.js + Fastify（或 Hono）
- **数据库**：Supabase Postgres
- **加密**：Node 内置 crypto，主密钥从系统 keychain 读
- **前端管控台**：React + TypeScript + Tailwind CSS
- **桌面端**：Electron + electron-builder + electron-updater
- **Monorepo**：pnpm + Turbo
- **MCP 层**：@modelcontextprotocol/sdk

### 5.7 Supabase 表结构

```sql
-- 用户（Supabase Auth 内置 auth.users）
profiles                  用户扩展信息（display_name, avatar_url, created_at）

-- 团队与订阅
teams                     团队信息（name, owner_id, plan, seats_limit, created_at）
team_members              成员关系（team_id, user_id, role: admin/member,
                          daily_quota_limit_equivalent, joined_at）
team_invitations          邀请码（team_id, email, role, token, expires_at）
subscriptions             订阅记录（team_id, plan, seats, status,
                          current_period_end, payment_method）

-- 厂商配置
providers                 厂商元信息（id, name, logo, capabilities,
                          auth_type, enabled, unit_name,
                          equivalent_count_divisor, default_daily_quota）
provider_keys             绑定的 cookie/key（team_id, owner_user_id, provider_id, account_id,
                          encrypted_key, auth_type: apikey/cookie/session_token,
                          daily_quota, cookie_expires_at,
                          last_health_check, health_status: healthy/expiring/expired,
                          enabled, created_at）

-- 厂商消耗表（admin 维护，按厂商+模式+参数组合给出成本）
provider_cost_tables      消耗规则（provider_id, mode,
                          duration_min, duration_max,
                          resolution, model,
                          unit_cost, equivalent_count_divisor,
                          display_text, created_at, updated_at）
-- 例：doubao, text2video, 1, 5, 480p, default, 1, 1, "5s内480p = 1次"
--     jimeng, img2video, 1, 5, 720p, default, 80, 80, "5s内720p = 80灵感值"

-- 额度账本（按日、按团队、按厂商、按账号、按原生单位）
quota_ledger              每日额度账本（date, team_id, provider_id, account_id,
                          unit_name, daily_total, used, remaining,
                          last_cost, last_cost_breakdown JSONB,
                          refreshed_at）
member_usage              成员当日消费（date, team_id, user_id,
                          used_equivalent, frozen_until）

-- 任务记录
jobs                      生成任务（id, team_id, user_id, provider_id, account_id,
                          mode, prompt, attachments JSONB,
                          status: pending/running/success/failed, trace_id, result_url,
                          error,
                          cost_unit, cost_amount, cost_breakdown JSONB,
                          equivalent_count,
                          created_at, completed_at）

-- 系统
announcements             系统公告（title, content, target: all/team, created_at）
audit_logs                审计日志（team_id, user_id, action, target, metadata, created_at）
```

### 5.8 RLS 策略（行级安全）

所有表只对登录用户可见：
- provider_keys：admin 只能看自己团队的公共 key（owner_user_id IS NULL）；member 只能看自己绑的 key（owner_user_id = auth.uid()）
- provider_cost_tables：全员只读（admin 可写）
- quota_ledger：团队成员可见本团队账本
- jobs：团队成员可见本团队任务
- subscriptions：admin 可见本团队订阅

### 5.9 packages/core 设计

```ts
// 调度核心
class Scheduler {
  async generate(options: GenerateOptions): Promise<GenerateResult>
  // 1. 拉 provider_cost_tables 缓存（首次/过期刷新）
  // 2. 查总池可用 key（按 health_status + enabled 过滤，按 remaining 排序）
  // 3. 按策略选家（轮询/可用优先/成本优先）
  // 4. 调 provider.estimateCost() 预估算，对比 remaining，不够则跳过
  // 5. 调 provider.generate()
  // 6. 成功：回 quota_ledger.consume(实际扣减, breakdown) + 写 job + 返回
  // 7. 失败（含 cookie 过期）：标记 key + 降级下一家重试
}

// 额度账本（多单位接口）
interface QuotaLedger {
  provider_id: string;
  account_id: string;
  unit_name: string; // "count" | "credits" | "inspiration" | "积分" | 自定义
  daily_total: number;
  used: number;
  remaining: number;
  last_cost?: number;
  last_cost_breakdown?: {
    duration: number;
    resolution?: string;
    model?: string;
    cost: number;
    displayText: string;
  };
}

class QuotaLedgerService {
  async consume(teamId, providerId, accountId, amount, breakdown?): Promise<boolean>
  async refreshDaily(): Promise<void>  // 0 点 pg_cron 触发
  async effectiveStatus(teamId): Promise<PoolStatus>
  async equivalentTotal(teamId): Promise<number> // 等效次数总和，用于总览 UI
}

class CookieManager {
  async healthCheck(keyId): Promise<HealthStatus>
  async silentRefresh(keyId): Promise<boolean>  // 后台静默访问厂商页面续期
  async onExpired(keyId): Promise<void>  // 标记失效，调度器自动切其他账号
}
```

### 5.10 packages/providers 适配规范

每家厂商一个适配器，继承 BaseProvider。**从 v2 架构起，BaseProvider.generate() 的默认实现走 WebView 统一执行引擎**，
不再写独立的 Node.js HTTP 提交代码（逆向签名成本过高）。
Node.js HTTP adapter 代码保留作兜底/高级用户。
见 5.12 WebView 统一执行引擎完整设计。

```ts
abstract class BaseProvider {
  abstract readonly id: string;              // 'doubao' | 'jimeng' | 'qwenwan' | ...
  abstract readonly displayName: string;     // '豆包' | '即梦' | ...
  abstract readonly authType: AuthType;      // 'apikey' | 'cookie' | 'session_token'
  abstract readonly unitName: string;        // 账本单位: 'count' | '灵感值' | '积分'
  abstract readonly capabilities: ProviderCapabilities;

  /**
   * WebProviderConfig：驱动 WebView 自动提交的声明式配置（99% 厂商只需填这个）。
   * 结构参考 5.12.2，含：页面 URL、选择器、提交方式、结果提取器、健康检查。
   */
  abstract readonly webConfig: WebProviderConfig | null;

  supports(mode: VideoMode): boolean;

  /**
   * 实际调用：优先用 webConfig + WebView 执行引擎；
   * webConfig 为 null 则走子类 override 的 HTTP 提交（mathmind 真 API 或兜底 adapter）。
   * 失败时不要抛异常，用 { ok:false, errorMessage } 形式返回，
   * 以便调度器知道是降级重试还是直接冷却。
   */
  abstract generate(options: GenerateOptions): Promise<GenerateResult>;

  /**
   * 估算本次调用会消耗多少（基于 provider_cost_tables + options）。
   * 返回：原生单位 + 等效次数 + 人类可读描述。
   * 调度器用原生单位对比 remaining，用等效次数计入 member 日额度。
   */
  abstract estimateCost(options: GenerateOptions): Promise<{
    unit: string;                // 匹配 unitName
    cost: number;                // 原生单位成本
    equivalentCount: number;     // 等效次数（成员日额度 + UI 总览）
    breakdown: {
      duration: number;
      resolution?: string;
      model?: string;
    };
    displayText: string;         // 例："豆包 5s 480p = 1次"
  }>;
}
```

**7 家适配器**：
- providers/doubao：豆包（doubao.com），cookie，单位 count，时长影响扣减
- providers/jimeng：即梦 AI（jimeng.jianying.com），cookie，单位 inspiration，时长/分辨率/模型影响
- providers/qwenwan：通义万相（tongyi.aliyun.com），cookie，单位 count，时长影响扣减
- providers/yuanbao：元宝混元（yuanbao.tencent.com），cookie，单位 count
- providers/kling：可灵（klingai.kuaishou.com），cookie，单位 credits（积分），时长影响
- providers/hailuo：海螺（hailuo.com），cookie，单位 count
- providers/mathmind：mcp_mathmind-video，真 API，单位 count

### 5.11 apps/cli 说明

CLI 是给开发者/重度用户的"第二入口"，和桌面端 GUI 互补：

```bash
quota-flow check-quota                    # 查看额度（总览等效 + 分厂商原生单位）
quota-flow estimate --mode img2video      # 预览本次消耗（等效 + 原生）
  --imageUrl <url> --prompt "..." --duration 5
quota-flow generate --mode img2video      # 生成视频
  --imageUrl <url> --prompt "..."
  --provider <id>                         # 可选：强制指定厂商
quota-flow refresh                        # 强制重置额度
quota-flow serve                          # 起 HTTP server
quota-flow keys list|add|remove|test      # 管理 cookie/apikey
quota-flow jobs list|get|delete           # 查任务历史
```

**关键点**：apps/cli 和 apps/desktop 直接 import packages/*，不绕 HTTP；只有 Skill 和第三方工具才走 HTTP/MCP 层。


### 5.12 WebView 统一执行引擎（所有 cookie 厂商统一走这里，mcp_mathmind 除外）

**核心决策**：不再每家厂商写独立 Node.js HTTP adapter（需要逆向签名），改为 **Electron WebView 作为统一执行层**。
WebView 里加载的是厂商官方前端页面，自带签名算法/风控逻辑，不用逆向。用户只看桌面端 Tab UI，WebView 全程隐藏在后台。

#### 5.12.1 架构示意

```
┌─────────────────────────────────────────────────────────┐
│                    桌面端 Electron                        │
│                                                         │
│  ┌───────────────┐     ┌────────────────────────────┐  │
│  │  React Tab UI │     │  WebView 执行引擎（隐藏）    │  │
│  │  (用户看得见)  │     │  (用户看不见，后台运行)      │  │
│  └───────┬───────┘     └─────────────┬──────────────┘  │
│          │                           │                  │
│          │ 1. 用户点 [生成视频]       │                  │
│          │                           │                  │
│          ▼                           │                  │
│  ┌───────────────┐                   │                  │
│  │ Scheduler     │──选账号──────────▶│                  │
│  │ (packages/core)│                  │                  │
│  └───────┬───────┘                   │                  │
│          │ 2. 选 provider+cookie      │                  │
│          │                            │                  │
│          ▼                            ▼                  │
│  ┌──────────────────────────────────────────────────┐   │
│  │           ProviderConfig（每家厂商一套配置）        │   │
│  │  ┌─────────────────────────────────────────────┐ │   │
│  │  │  • loginUrl / chatUrl                       │ │   │
│  │  │  • 选择器（输入框/发送按钮/视频元素）         │ │   │
│  │  │  • submitViaJs() （调页面内部 JS API）       │ │   │
│  │  │  • extractVideoFromResponse()               │ │   │
│  │  │  • healthCheckUrl                           │ │   │
│  │  └─────────────────────────────────────────────┘ │   │
│  └──────────────────────┬───────────────────────────┘   │
│                         │                               │
│                         ▼                               │
│  ┌──────────────────────────────────────────────────┐   │
│  │              WebView 会话池（隔离）                 │   │
│  │  session.fromPartition('persist:teamid:accid')   │   │
│  │  每个账号一个独立 cookie jar，互不污染              │   │
│  └──────────────────────┬───────────────────────────┘   │
│                         │ 3. 注入 cookie + 加载页面       │
│                         ▼                               │
│  ┌──────────────────────────────────────────────────┐   │
│  │            提交 prompt（二选一）                    │   │
│  │  A. 模拟用户操作：填输入框 → 点发送按钮（稳）       │   │
│  │  B. 调页面 JS API：window.$api.chat(...)（高效）   │   │
│  └──────────────────────┬───────────────────────────┘   │
│                         │ 4. 提取结果                     │
│                         ▼                               │
│  ┌──────────────────────────────────────────────────┐   │
│  │            提取视频 URL（三选一，依次 fallback）     │   │
│  │  A. 拦截 Network 响应（detail / chat SSE）         │   │
│  │  B. 读 DOM：找 <video src="*.mp4">                │   │
│  │  C. 读 meta_data JSON（iframe 里的 sc_html）       │   │
│  └──────────────────────┬───────────────────────────┘   │
│                         │ 5. 返回 URL + actual_cost       │
│                         ▼                               │
│                    扣账本 + 写 jobs 表                   │
└─────────────────────────────────────────────────────────┘
```

#### 5.12.2 Provider 配置规范（WebProviderConfig）

每家厂商只需提供一份配置文件，**不用写 TypeScript HTTP 代码**（estimateCost 仍走 provider_cost_tables 查表）：

```ts
interface WebProviderConfig {
  readonly id: string;                // 'yuanbao' | 'qwenwan' | ...
  readonly displayName: string;

  // —— 页面路由 ——
  readonly loginUrl: string;          // 首次登录页 URL
  readonly chatUrl: (agentId?: string) => string;   // 生成视频页

  // —— 提交方式 A：模拟用户操作（最稳，首选）——
  readonly selectors?: {
    inputBox: string;                // prompt 输入框（contenteditable 的 DOM）
    sendBtn: string;                 // 发送按钮
    imageUploadInput?: string;       // 图生视频的 <input type="file">
    attachmentDropZone?: string;     // 图生视频拖拽区
  };
  readonly fillPromptViaDom?: (
    webContents: Electron.WebContents,
    prompt: string,
    attachments: { imageUrl?: string }[],
  ) => Promise<void>;
  readonly clickSendViaDom?: (webContents: Electron.WebContents) => Promise<void>;

  // —— 提交方式 B：调页面内部 JS API（高效，但可能随版本失效）——
  readonly submitViaJs?: (opts: {
    prompt: string;
    attachments: { imageUrl?: string }[];
    duration: number;
    resolution?: string;
    model?: string;
  }) => string;    // 返回要 executeJavaScript 的 JS 代码字符串

  // —— 结果提取（依次 fallback）——
  readonly resultExtractors: Array<
    | { type: 'network-intercept'; match: (url: string) => boolean; parse: (body: string) => { videoUrl?: string; status: 'pending' | 'success' | 'failed'; actualCost?: number; error?: string } }
    | { type: 'dom-query'; selector: string; attr: 'src' | 'textContent'; regex?: RegExp }
    | { type: 'dom-js'; code: string } // executeJavaScript 返回 {videoUrl,status,...}
  >;

  // —— cookie 健康检查（轻量，4 小时一次）——
  readonly healthCheck: {
    method: 'get' | 'post';
    url: string;
    parse: (statusCode: number, body: string) => 'healthy' | 'expired' | 'quota_exhausted';
  };

  // —— 页面内 agent/model 切换（如需）——
  readonly ensureModelReady?: (webContents: Electron.WebContents) => Promise<void>;
}
```

#### 5.12.3 新增厂商工作量对比

| 方案 | 接入新厂商 | 维护成本 | 签名/风控问题 |
|---|---|---|---|
| 旧：Node.js HTTP adapter（逆向 API） | 2-3 天/厂（逆向签名） | 高（每个改机制重逆） | 每家单独处理 |
| 新：WebView 统一引擎（ProviderConfig） | **2 小时/厂**（填选择器） | **低**（官方页面自动更新） | **无**（页面 JS 自带签名） |

#### 5.12.4 Cookie 隔离（多账号 + 团队共享）

使用 Electron `session.fromPartition(persist:${teamId}:${accountId})`：
- 每个账号（含团队共享账号）一个独立 cookie jar
- 切换账号不污染
- 本地 persist 保存（重启桌面端 cookie 不丢）
- 共享 cookie 从 Supabase 解密后，用 `session.cookies.set()` 逐条注入，**不在桌面端本地明文落盘**（仅内存 + session 加密 persist）

#### 5.12.5 WebView 生命周期池化

避免每次生成都新建销毁 WebView（耗资源）：
- 常驻 2-3 个空闲 WebView 实例（按厂商热分区）
- LRU 回收：10 分钟不用销毁
- 提交任务：从空闲池取 → 注入 cookie → 切 URL → 执行 → 回收回空闲池（或销毁切下一个账号）
- 后台保活：每天凌晨 3 点，遍历所有 partition，静默 `webContents.loadURL(厂商首页)` → 等 5s → 关 → cookie 自动续命（100% 用户无感）

#### 5.12.6 兜底：CLI 直调仍保留（仅开发者/高级用户）

WebView 是桌面端默认路径。**保留 Node.js HTTP adapter 代码**作兜底：
- 某些厂商没有风控签名（如元宝、mathmind）
- 服务端部署场景（CLI 批量跑，不启 Electron）
- 逆向爱好者继续完善

调度策略优先级：WebView 能用就用 WebView；不行再 fallback 到 HTTP adapter。

---

## 6. 厂商接入清单

### 6.1 厂商列表（7 家）

| 厂商 id | 产品 | 每日免费额度 | 额度单位 | 扣减影响因素 | 能力 | 调用方式 |
|---|---|---|---|---|---|---|
| doubao | 豆包 doubao.com | 每日登录次数 | count（次数） | 时长（5s/10s 扣不同） | 文/图 | WebView cookie 注入 + 自动提交（兜底 HTTP adapter） |
| jimeng | 即梦 jimeng.jianying.com | 每日登录灵感值 | inspiration（灵感值） | 时长 + 分辨率 + 模型 | 文/图/多图/视频续写 | WebView cookie 注入 + 自动提交 |
| qwenwan | 通义万相 tongyi.aliyun.com / qianwen.com | 每日免费次数 | count（次数） | 时长 | 文/图/视频续写 | WebView cookie 注入 + 自动提交（风控签名，CLI 不可直调） |
| yuanbao | 元宝混元 yuanbao.tencent.com | 每日免费次数 | count（次数） | 按固定次数 | 文/图 | WebView cookie 注入 + 自动提交（兜底 HTTP adapter） |
| kling | 可灵 klingai.com/ | 每月免费216积分 | credits（积分） | 时长 + 分辨率 | 文/图 | WebView cookie 注入 + 自动提交 |
| hailuo | 海螺 hailuoai.com | 有限免费 | count（次数） | 按固定次数 | 文 | WebView cookie 注入 + 自动提交 |
| mathmind | mcp_mathmind-video | 工具内置额度 | count（次数） | 按固定次数 | img2video/imgs2video/video2video | 真 API（WebView 方案的唯一例外） |

### 6.2 关键现实

- **国内主流厂商的免费额度绑登录态，不绑 apikey**
- 公开 API 是商用付费的（按量计费），走不了每日免费额度
- **唯一例外**：mcp_mathmind-video 是真 API
- **次数 ≠ 固定 1 次**：豆包/即梦/可灵等选择不同时长/分辨率/模型会扣不同额度，不能简单按 1 扣
- default_daily_quota / provider_cost_tables 必须可在 admin 后台调整下发
- admin 后台可控制厂商全局启用/禁用，用户可在设置里临时禁用某家（调度器自动跳过）
- **账号级启用/停用**：每个绑定账号有 `enabled` 开关（默认开），停用后该账号不被调度器选号（生成视频、保活、健康检查聚合均跳过），额度/绑定信息保留

### 6.3 豆包：按次数但时长影响

豆包生成视频时可选择 5s / 10s，扣减次数不同（例：5s 扣 1 次，10s 扣 2 次）。
适配器 estimateCost 基于 options.duration 查 provider_cost_tables 返回扣减次数。

### 6.4 即梦：灵感值积分制

即梦不是按次数，是按灵感值（例：5s 720p 文生视频 = 80 灵感值，每日约 800 灵感值）。
estimateCost 返回 `{ unit: 'inspiration', cost: 80, equivalentCount: 1 }`。
账本按灵感值原生单位存储，UI 统一换算等效次数展示。

### 6.5 可灵：积分制

可灵按积分，时长/分辨率影响积分消耗。estimateCost 基于参数查表。

### 6.6 provider_cost_tables 示例数据

| provider_id | mode | duration_min | duration_max | resolution | model | unit_cost | equivalent_count_divisor | display_text |
|---|---|---|---|---|---|---|---|---|
| doubao | text2video | 1 | 5 | 480p | default | 1 | 1 | 豆包 5s 480p = 1次 |
| doubao | text2video | 6 | 10 | 480p | default | 2 | 1 | 豆包 10s 480p = 2次 |
| doubao | img2video | 1 | 5 | 480p | default | 1 | 1 | 豆包图生 5s 480p = 1次 |
| jimeng | text2video | 1 | 5 | 720p | default | 80 | 80 | 即梦 5s 720p = 80灵感值 |
| jimeng | text2video | 6 | 10 | 720p | default | 160 | 80 | 即梦 10s 720p = 160灵感值 |
| jimeng | img2video | 1 | 5 | 720p | default | 80 | 80 | 即梦图生 5s 720p = 80灵感值 |
| qwenwan | text2video | 1 | 10 | 720p | default | 1 | 1 | 通义万相 10s 内 = 1次 |
| yuanbao | text2video | 1 | 10 | 720p | default | 1 | 1 | 元宝 10s 内 = 1次 |
| kling | text2video | 1 | 5 | 720p | default | 5 | 5 | 可灵 5s 720p = 5积分 |
| kling | text2video | 1 | 5 | 1080p | default | 10 | 5 | 可灵 5s 1080p = 10积分 |
| hailuo | text2video | 1 | 10 | 720p | default | 1 | 1 | 海螺 10s 内 = 1次 |
| mathmind | img2video | 1 | 10 | 720p | default | 1 | 1 | mathmind = 1次 |

---

## 7. Cookie 与登录态管理

### 7.1 方案组合：1+4+5

**方案 1：WebView 统一执行引擎 + 自动续期**
- 桌面端内嵌 BrowserWindow（隐藏，用户看不到），不是登录时才打开，而是**常驻后台池化实例**
- 用户首次登录各家厂商：显示登录 WebView（可见）→ 用户操作 → 抓 cookie → 存 Supabase 加密 → 关掉可见 WebView → 后续都用隐藏实例
- cookie 续期：每天凌晨 3 点后台定时任务，按 partition 遍历所有账号 → 静默 `loadURL(厂商首页)` 等待 5s → 关 → cookie 滑动续命（100% 用户无感）
- 真过期才弹通知：只有访问后被跳登录页才判定真过期 → 桌面端右下角 toast「豆包 cookie 已失效，点此重新登录」→ 弹可见 WebView
- 目标：用户平均 1-2 个月重新登录 1 次，不是每周
- 与 WebView 提交引擎共用同一套 partition、同一套 session，不重复建 WebView（保活和提交共享池）

**方案 4：Cookie 健康检查 + 提前预警**
- 每天凌晨 4 点 pg_cron 触发健康检查
- 对所有 cookie 调一个轻量 API 验证
- 快过期的标记 health_status = expiring
- 用户打开桌面端时看到提示"即梦登录将在 6 小时后失效"

**方案 5：失败自动切其他账号**
- cookie 突然失效时，调度器检测失败 自动切下一个账号
- 标记失效账号 health_status = expired
- UI 标红提示用户有空再登录
- 多账号池化的价值就在这里

### 7.2 Cookie 寿命参考

| 厂商 | 登录方式 | cookie 寿命 |
|---|---|---|
| 豆包 | 抖音/手机号 | 7-30 天 |
| 即梦 | 抖音/手机号 | 7-30 天 |
| 通义万相 | 阿里云账号 | 7-30 天 |
| 元宝 | 微信/QQ 扫码 | 1-7 天 |
| 可灵 | 快手账号 | 7-30 天 |
| 海螺 | 手机号 | 7-30 天 |

### 7.3 现实约束

- **不可能 100% 消除重新登录** cookie 一定会过期，厂商一定会改机制
- 目标：降到每月 1-2 次（不是零）
- 每家厂商 cookie 机制不一样，每个适配器要单独实现 cookie 维护逻辑
- 厂商改版会让适配器失效，需要持续维护 **长期维护成本**

---

## 8. 调度核心设计

### 8.1 路由策略

| 策略 | 说明 |
|---|---|
| available_first | 优先选剩余等效次数最多的厂商账号（默认） |
| round_robin | 轮询所有可用厂商账号 |
| cost_first | 优先选单次等效成本最低的厂商（同参数下比较） |

### 8.2 estimateCost 预检查路由

路由选家时必须先 estimateCost，避免选了一个"剩余 80 灵感值，但本次要 160"的账号：
1. 列出所有 enabled + healthy 的账号（provider_keys，账号级停用的直接剔除）
2. 对每个账号调 provider.estimateCost(options) 得 cost
3. 过滤掉 remaining < cost 的账号
4. 在剩下列表里按策略选一个

> 账号停用（`provider_keys.enabled = false`）：等同从候选池剔除，但不删除记录、不扣额度、不影响其余账号；重新启用立即恢复参与调度。厂商状态聚合同样只看启用账号，全部停用视为离线。

---

## 9. Skill 设计

### 9.1 定位

Skill 是"可选附件" 不依赖特定宿主，任何能识别 SKILL.md 的 AI 代理/工具都能挂载。用户不一定用 Skill，桌面端 GUI 是主入口。

### 9.2 能力边界

Skill 只翻译意图，不存 key、不存账本、不做路由：
- 用户说"生成个猫的视频，5 秒左右" → Skill 调本地 HTTP POST /v1/generate，带 duration=5
- 用户说"看下额度" → Skill 调 GET /v1/quota（返回等效总次数 + 分厂商明细）
- 用户说"生成这个大概耗多少" → Skill 调 POST /v1/estimate
- SKILL.md 只写"什么时候调哪个 HTTP 接口"

### 9.3 文件结构

```
apps/skill/
  SKILL.md    # 触发条件、CLI 用法、Provider 清单、设计原则
```

构建脚本把它拷贝到宿主工具识别的目录。

---

## 10. 桌面端设计

### 10.1 核心定位

桌面端是**唯一产品入口**，所有功能都在这里。落地页只做营销不做功能。

### 10.2 首次启动流程

```
用户下载安装桌面端
  |
首次启动 显示欢迎页 + 选模式：
  官方托管（推荐）       自部署
  下载即用              数据完全自己掌控
  免费版支持 3 人团队    无席位限制
  有客服支持            需自己注册 Supabase

  官方托管 → 内嵌注册/登录页 → 进入主界面
  自部署 → 填 Supabase URL + anon key → 内嵌注册/登录页 → 进入主界面
  |
首次使用引导：
  1. 设置 Tab 绑各家厂商 cookie/apikey（WebView 登录）
  2. 调度台 开始生成视频
```

### 10.3 WebView cookie 管理 + 统一执行引擎

桌面端所有 cookie 厂商的"登录"和"生成视频"都走内嵌 WebView，**对用户是两态分离**：

| 场景 | WebView 是否可见 | 说明 |
|---|---|---|
| 首次绑定厂商 cookie | ✅ 可见 | 设置 Tab → 点"绑定豆包" → 弹出登录窗口 → 用户扫码/输密码 → 自动抓 cookie → 关窗口 |
| 日常生成视频 | ❌ 隐藏 | 调度台点 [生成] → 后台池化 WebView 实例注入 cookie → 自动填 prompt → 自动点发送 → 提取 URL → 只在 UI 显示进度 |
| 每天 cookie 保活 | ❌ 隐藏 | 凌晨 3 点后台静默访问各厂商首页 5s，完事儿，用户无感 |
| cookie 真过期 | 才可见 | 右下角 toast「元宝 cookie 失效，点此重登录」→ 弹可见 WebView → 用户 30s 登录完关闭 |

**用户 UI 里永远看不到"生成视频时的 WebView"。** 用户只看到调度台 Tab 的进度条 + 卡片，与厂商页面交互全部在后台隐藏 WebView 里自动完成。

关键实现点：
- 提交/保活共享 WebView 实例池（partition 隔离多账号）
- 视频生成失败（cookie 失效/风控）→ 调度器自动切账号重试，用户看到的只有"降级重试中..."

### 10.4 分发渠道

1. **官网下载页**（落地页 /download，自动检测 OS 给下载链接）
2. **GitHub Releases**（electron-builder 自动打包上传）
3. **electron-updater 自动更新**（用户首次下载后不用手动下新版）

### 10.5 代码签名

MVP 阶段不买证书（Mac $99/年、Windows $200-400/年），用户安装时会看到"未知发布者"警告。有 10+ 付费用户后再买。

---

## 11. 界面设计



---

## 12. Web 端（落地页）

### 12.1 定位

Web 端**只做营销不做功能**。用户不登录可看大部分内容，所有产品功能都在桌面端。

### 12.2 页面清单

**不登录可看**：
- 首页（产品介绍、特性展示、对比表）
- 定价页（个人免费 + 团队免费 3 人 + Pro $9 + Business $29）
- 下载页（自动检测 OS，给下载链接）
- 文档站（怎么用、FAQ、Provider 清单、自部署教程）
- 注册页（注册完跳下载页，不注册也可下载）

**登录后可选看**：
- 账号管理（改密码、看订阅状态）
- 团队成员邀请（发邀请链接）

**明确不做**：
- 视频生成
- 厂商配置
- 额度查看
- 任务历史
- 任何"产品功能"

---

## 13. 后台管理系统（admin）

### 13.1 定位

独立部署的后台管理系统，只给运营者自己用，不对外公开。

### 13.2 部署

- 独立 Next.js + React 项目（apps/admin，开源）
- 部署在 Vercel，独立域名
- 连同一个官方 Supabase
- 加 IP 白名单 + TOTP 二步验证 + 操作审计

### 13.3 监控范围

**只监控官方托管实例** 自部署实例完全脱离 admin 视野。

### 13.4 功能模块

**13.4.1 团队与用户管理**
- 所有团队列表（订阅档、成员数、到期时间、用量）
- 团队详情（成员、key 数量、消费明细）
- 用户列表（注册时间、所属团队、消费统计）
- 封禁/解封团队或用户
- 重置某团队的额度（客诉用）

**13.4.2 订阅管理**（MVP 手动开通）
- 手动开通订阅（选套餐、设席位、设到期时间）
- 订阅记录列表
- 取消/续费订阅
- 支付记录（用户微信/支付宝转账后手动登记）

**13.4.3 Provider 与消耗表管理**
- 厂商列表（全局启用/禁用、改 default_daily_quota、改 unit_name、改 equivalent_count_divisor）
- **provider_cost_tables 可视化编辑器**：
  - 按厂商列出所有消耗规则
  - 增删改：mode、时长区间、分辨率、model、unit_cost、divisor、display_text
  - 保存后所有官方托管团队下次拉缓存时生效（可强制刷新）
  - 提供"导入 JSON"和"导出 JSON"做版本管理
- 厂商健康监控（成功率、平均时长、最近故障）
- 适配器版本管理（灰度上线新适配器）

**13.4.4 系统监控**
- 调用总量趋势（按厂商、按团队、按等效次数）
- 错误率告警（某家厂商失败率 >30%）
- 消耗偏离告警（某厂商实际扣减与表偏差 >20%，提醒运营者更新消耗表）
- Supabase 用量（DB 占用、MAU 接近免费层上限）
- pg_cron 任务状态

**13.4.5 安全与合规**
- cookie/key 审计日志（谁绑了/解了哪个 key）
- 异常行为检测（某账号 1 小时调 500 次，疑似刷量）
- 内容审核队列（生成的视频被举报后进队列）
- GDPR/隐私合规（用户请求删除数据时的处理入口）

**13.4.6 公告与通知**
- 给所有用户推系统公告（厂商维护、新厂商上线、消耗表变更）
- 给某团队单独推消息

---

## 14. 客户支持

### 14.1 渠道

| 渠道 | 入口 | SLA |
|---|---|---|
| GitHub Issues | README + Web 端 footer | 48 小时响应（免费）、12 小时（付费） |
| 邮箱 | Web 端 footer + 桌面端"帮助"菜单 | 同上 |

**不做 Discord 社区**。

### 14.2 自部署用户

明确告知："自部署无客服支持，出问题自行排查"。GitHub Issues 仍可提，但不承诺 SLA。

---

## 15. 合规与风险

### 15.1 ToS 风险

**国内主流视频厂商的"每日免费额度"绑登录态，不绑 apikey**。用 cookie 调厂商内部 API 违反各家 ToS：
- 禁止自动化访问
- 禁止多账号
- 禁止账号共享
- 禁止逆向工程

### 15.2 风险等级

| 场景 | 风险 |
|---|---|
| 个人自用低频 | 低（厂商没动力管） |
| 小团队共享 | 中（有账号共享） |
| 公开高频商用 | 高（厂商会定向封杀） |

### 15.3 合规边界

- **模式 A 官方托管**：卖的是"工具托管 + 团队协作功能"，不是"调厂商 API 的中介费"
- 用户用自己 cookie 调厂商是用户自己的事，运营者不直接参与调用
- 不转售、不抽佣、不对外暴露
- 定位锁死"个人/小团队自用"，公开商用需用户自负风险

### 15.4 长期维护成本

- 厂商改版会让适配器失效
- cookie 机制可能变化
- **消耗表需要持续维护**：豆包/即梦/可灵的扣减规则一变，provider_cost_tables 就要跟着改
- admin 后台监控"实际扣减 vs 预估偏差"，偏差大时告警运营者手动更新
- 允许每个 provider 适配器在 generate() 成功后返回实际扣减（从厂商响应里解析 actual_cost），与 estimateCost 预估对比，偏差大时写 audit_logs

---

## 16. 落地路径

### 阶段 1：MVP 核心（1-2 个月）

- Monorepo 骨架（pnpm + Turbo）
- packages/core：调度核心 + 多单位账本 + 等效次数换算 + provider_cost_tables 缓存
- packages/providers：先接 mcp_mathmind（真 API）+ 豆包（cookie，按次数）+ 即梦（cookie，灵感值）
- provider_cost_tables：3 家初始数据
- apps/desktop：Electron + React UI 基础框架
- 桌面端 4 Tab 基础页面（额度总览卡片显示多单位）
- Supabase 表结构 + RLS + pg_cron 0 点滚动
- 个人用户能用：绑 key、生成视频、看额度

### 阶段 2：多厂商 + cookie 管理（1 个月）

- 接通义万相、元宝、可灵、海螺（共 4 家 cookie 厂商）
- 补全 7 家的 provider_cost_tables 数据
- packages/cookie-manager：WebView 登录 + 健康检查 + 自动续期
- 桌面端账号健康页面
- 失败自动切账号

### 阶段 3：团队功能 + 落地页（1 个月）

- apps/web：落地页（定价/文档/下载/注册）
- 团队额度池（公共 + 成员自带，等效次数展示）
- 成员管理 + 邀请
- 防滥用机制（成员日等效次数上限）
- admin 后台：团队管理 + 用户管理 + Provider 管理 + **额度扣减规则** + 系统监控

### 阶段 3.5：后台管理系统细化

- apps/admin：独立部署
- 6 大功能块（团队用户/订阅管理/Provider+消耗表/监控/安全合规/公告）
- Stripe / 微信支付接入（或继续手动开通）

### 阶段 4：打磨 + 商业化

- electron-updater 自动更新
- 代码签名证书
- i18n 预留
- 性能优化
- 消耗表持续校准 + 自动偏差告警
- 文档完善

---

## 17. 开源策略

### 17.1 开源范围

| 仓库 | 开源 | 说明 |
|---|---|---|
| packages/* | 是 | core / providers / crypto / db-supabase / shared-ui / cookie-manager / logger / auth |
| apps/web | 是 | 落地页 |
| apps/desktop | 是 | 桌面端 |
| apps/cli | 是 | 命令行 |
| apps/skill | 是 | SKILL.md |
| apps/admin | 是 | 后台管理（含额度扣减规则；自部署用户也可自建运营后台） |

### 17.2 License

待定（MIT 或 AGPL，AGPL 可以防止别人拿去商用闭源）

### 17.3 自部署用户用法

- clone 仓库
- 自己注册 Supabase，跑 migrations（含 provider_cost_tables 初始数据）
- pnpm install && pnpm build
- pnpm desktop:build 或 pnpm dev:desktop
- 完全免费、无限制、admin 不可见
- 自部署可自己改本地 provider_cost_tables（通过 SQL 或自己加个页面）

---

## 18. 未确认事项

无。所有关键决策已锁定。








