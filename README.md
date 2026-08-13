# Quota-Flow

> 视频生成免费额度统一调度平台 · 把豆包 / 即梦 / 通义万相 / 元宝混元 / 可灵 / 海螺 / mcp_mathmind-video 等多家厂商的每日免费额度聚合成一个可调度、可观测、可共享的池子。

## 下载最新版

- 最新 Windows 安装包：[GitHub Releases](https://github.com/Shaun520/quota-flow/releases/latest)
- 下载后运行 `Quota-Flow Setup x.y.z.exe` 即可安装。
- 已安装旧版本的用户可以直接在桌面端“设置 -> 检查更新”升级。

## 核心特性

- **动态额度账本（多单位）**：按厂商原生单位记账（次数/灵感值/积分），支持"时长+分辨率+模型"的动态消耗；0 点自动滚动
- **等效次数总览**：不同单位统一折算等效次数，用于 UI 总览 + 成员日额度上限
- **消耗表 Admin 可配**：`provider_cost_tables` 由 admin 后台维护，豆包 5s/10s、即梦 720p/1080p 等消耗规则随时可改
- **智能调度 + estimateCost 预检查**：按策略选家前先预估算消耗，跳过"剩余不够本次调用"的账号
- **多账号池化**：同一家厂商绑多个账号，额度叠加，单账号失效自动切下一个
- **账号级启用开关**：每个绑定账号可单独启用/停用（默认启用），停用账号被智能调度自动跳过，无需解绑
- **团队共享额度池**：多人多账号额度叠加成一个池子（核心创新点）
- **声明式 WebView 接入**：新厂商接入只需填页面 URL + DOM 选择器，平均 2 小时搞定一家；不用逆向风控签名算法（千问 bx-ua / clt-acs-sign 等）
- **Cookie 自动维护**：WebView 统一执行引擎（提交与保活共享实例池）+ cookie 隔离会话 + 凌晨 3 点自动续命，用户平均 1-2 月重登一次
- **桌面端优先**：Electron 本地工具，无超时无 CORS；个人账号本地解密，团队公共账号走 Edge Function 代调用（key 不出云端）
- **官方托管 + 自部署**：95% 用户用官方托管，技术用户可完全自部署

## 商业模式

**开源 + 官方托管 + 自部署**

| 套餐 | 价格 | 席位 | 适合 |
|---|---|---|---|
| 个人免费 | $0 | 1 人 | 个人用户 |
| 团队免费 | $0 | 最多 3 人 | 小团队尝鲜 |
| 团队 Pro | $9/月 | 最多 10 人 | 正经小团队 |
| 团队 Business | $29/月 | 最多 30 人 | 大团队 |

所有套餐功能完全一致，唯一区别是团队人数上限。自部署完全免费、无限制、admin 不可见。

## 技术架构

```
Vercel（两个独立项目）
  web/     落地页：定价/文档/下载/注册/赞助
  admin/   后台管理（开源，运营者用，含消耗表编辑器）
                |
                v
Supabase（数据库 + Auth + Edge Functions）
  Postgres：账本、cookie（加密）、jobs、用户、团队、消耗表
  pg_cron：每日 0 点额度滚动、每 4 小时 cookie 健康检查
  Edge Functions：团队 cookie 代调用（共享账号 key 不出云端）
                ^
                | 桌面端直连（RLS 写 job / 查账本 / 读消耗表 / AES 解密取自己 cookie）
                |
桌面端 Electron（唯一产品入口）
  React UI（4 Tab：调度台/历史/团队/设置）── 用户只看这个
  本地调度引擎（packages/core + providers）
  WebView 统一执行引擎（后台隐藏，用户不可见）── 见 REQUIREMENTS.md §5.12
    全 7 家厂商通过 WebView cookie 注入 + 自动提交（mcp_mathmind 真 API 除外）
    每个共享账号独立隔离会话（session.fromPartition），互不污染
    两种提交方式（模拟用户操作 / 调页面内部 JS API）+ 三级结果提取 fallback
    提交/保活共享实例池，凌晨 3 点静默访问厂商首页自动续命 cookie
```

## Monorepo 结构（pnpm + Turbo）

```
quota-flow/
packages/
  core/          ✅ 已实现  调度核心（路由、降级、账本逻辑、等效次数换算、消耗表缓存）
  providers/     ✅ 已实现  厂商适配器（mathmind/qwen/yuanbao 已接入，其余待补）+ estimateCost
  crypto/        🔲 骨架已建 · 待实现  AES 加密（团队 cookie 云端加密 + 桌面端本地解密）
  db-supabase/   🔲 骨架已建 · 待实现  Supabase 客户端（RLS、Auth、团队权限）
  shared-ui/     🔲 骨架已建 · 待实现  React 共享组件（桌面端 + 落地页复用）
  cookie-manager/🔲 骨架已建 · 待实现  健康检查 + 自动续期（与 WebView 执行引擎共享实例池）
  logger/        🔲 骨架已建 · 待实现  统一日志（桌面端 + CLI + Edge Functions）
  auth/          🔲 骨架已建 · 待实现  Supabase Auth 封装（官方托管登录 / 自部署模式切换）
apps/
  web/           🔲 骨架已建 · 待实现  落地页（Next.js + React + Vercel）
  admin/         🔲 骨架已建 · 待实现  后台管理（开源，Next.js + React + Vercel）
  desktop/       🔲 骨架已建 · 待实现  Electron + React（唯一产品入口，WebView 统一引擎）
  cli/           ✅ 已实现  命令行（check-quota / generate / refresh）
  skill/         🔲 骨架已建 · 待实现  SKILL.md（可选 Skill 附件）
  migrations/    🆕 新建  Supabase SQL 迁移脚本（约定见 migrations/README.md）
```

## 技术选型

- **后端服务**：MVP 阶段不独立部署；团队代调用走 Supabase Edge Functions；本地桌面端如需供 Skill 调用走 Node 内置 http 轻量接口
- **数据库**：Supabase Postgres
- **加密**：Node 内置 crypto，主密钥从系统 keychain 读
- **前端**：React + TypeScript + Tailwind CSS
- **桌面端**：Electron 28+ LTS + electron-builder + electron-updater（主进程与 packages/* 通过 workspace 依赖引用）
- **Monorepo**：pnpm 9 + Turbo 2
- **构建（packages/* 双格式）**：tsup 8，同时输出 CJS + ESM + DTS；exports 字段显式声明 types/import/require
- **模块系统**：workspace 共享 tsconfig（ESNext target + Bundler resolution）；共享库双格式；Electron 主进程用哪种都行；Next.js App Router 用 ESM
- **厂商接入层**：声明式 `WebProviderConfig`（页面 URL + 选择器 + 两种提交方式 + 三级结果提取），接入新厂商 ≈ 2h
- **MCP 层**：@modelcontextprotocol/sdk

## 厂商清单

| 厂商 id | 产品 | 额度单位 | 扣减影响因素 | 能力 | 调用方式 |
|---|---|---|---|---|---|
| doubao | 豆包 doubao.com | count（次数） | 时长（5s/10s 扣不同） | 文/图 | WebView cookie 注入 + 自动提交（保留 Node.js HTTP adapter 兜底） |
| jimeng | 即梦 jimeng.jianying.com | inspiration（灵感值） | 时长 + 分辨率 + 模型 | 文/图/多图/视频续写 | WebView cookie 注入 + 自动提交 |
| qwenwan | 通义万相 tongyi.aliyun.com / qianwen.com | count（次数） | 时长 | 文/图/视频续写 | WebView cookie 注入 + 自动提交（风控签名 bx-ua/clt-acs-sign，CLI 无法直调） |
| yuanbao | 元宝混元 yuanbao.tencent.com | count（次数） | 固定次数 | 文/图 | WebView cookie 注入 + 自动提交（保留 Node.js HTTP adapter 兜底） |
| kling | 可灵 klingai.kuaishou.com | credits（积分） | 时长 + 分辨率 | 文/图 | WebView cookie 注入 + 自动提交 |
| hailuo | 海螺 hailuo.com | count（次数） | 固定次数 | 文 | WebView cookie 注入 + 自动提交 |
| mathmind | mcp_mathmind-video | count（次数） | 固定次数 | img2video/imgs2video/video2video | 真 API（WebView 方案的唯一例外） |

国内主流厂商的免费额度绑登录态，不绑 apikey。**mcp_mathmind 是唯一走真 API 的厂商，其余 6 家全部走 WebView 统一执行引擎**（cookie 注入 + 自动提交，参考 REQUIREMENTS.md §5.12）。对于千问这类含风控签名的厂商，WebView 前端 JS 自带签名算法，无需逆向。

所有厂商消耗不是固定"1 次"——豆包 5s/10s、即梦 720p/1080p、可灵 5s/10s 的扣减都不一样，由 `provider_cost_tables` 表驱动，最后折算统一的"等效次数"用于 UI 总览 + 成员日额度上限。

## 快速开始

### 自部署（技术用户）

前置：注册 Supabase 空项目（启用 Auth + Postgres）。

```bash
git clone https://github.com/yourname/quota-flow.git
cd quota-flow

# 1. 安装 + 构建（pnpm monorepo）
pnpm install
pnpm build

# 2. 配置 .env（桌面端首次启动也可在设置 Tab 里填）
cp .env.example .env
# 填入：SUPABASE_URL / SUPABASE_ANON_KEY / SELF_HOSTED=true

# 3. 跑 migrations（创建表结构 + provider_cost_tables 初始消耗规则）
# 方式 A：Supabase Dashboard → SQL Editor → 按序执行 migrations/*.sql（约定见 migrations/README.md）
# 方式 B：桌面端首次启动会提示自动执行

# 4. 启动桌面端

cd apps/desktop && pnpm dev  # 设置里的 Supabase 连接信息按需配置
```

### CLI 真跑示例（已验证）

```bash
# 查额度（当前已接入 mathmind / qwenwan / yuanbao 三家）
$ pnpm --filter @quota-flow/cli dev check-quota
 mathmind  0/10    active
 qwenwan   0/0     offline
 yuanbao   0/5     degraded

# 指定厂商跑一次生成（需要在 data/yuanbao-auth.json 配置 cookie + conversationId）
pnpm --filter @quota-flow/cli dev generate --mode text2video \
  --prompt "生成5秒猫咪视频" --provider yuanbao --json

# 不指定厂商走调度（按策略自动选家）
pnpm --filter @quota-flow/cli dev generate --mode text2video \
  --prompt "生成5秒猫咪视频" --json

# 刷新账本（重新读本地账本 + 重新估算等效次数）
pnpm --filter @quota-flow/cli dev refresh
```

## 开发命令（pnpm monorepo + Turbo）

```bash
pnpm install                           # 安装所有 workspace 依赖（首选；别混用 npm）
pnpm build                             # Turbo 并行构建所有 package（core → providers → cli）
pnpm typecheck                         # Turbo 并行类型检查
pnpm test                              # 运行测试（待实现）

# 单包 / 单 app 开发（--filter 精确）
pnpm --filter @quota-flow/core dev           # core 包监视模式
pnpm --filter @quota-flow/providers dev      # providers 包监视模式
pnpm --filter @quota-flow/cli dev --help     # CLI 帮助

# 桌面端（Electron，待实现 apps/desktop）
pnpm --filter @quota-flow/desktop dev   # 开发模式
pnpm release                            # 构建并打包桌面端安装包
```

## 开源策略

| 仓库 | 开源 |
|---|---|
| packages/* | 是 |
| apps/web | 是 |
| apps/desktop | 是 |
| apps/cli | 是 |
| apps/skill | 是 |
| apps/admin | 是（含消耗表可视化编辑器） |

## 客户支持

- GitHub Issues：bug 反馈、功能建议
- 邮箱：support@quota-flow.com
- 自部署用户：GitHub Issues 可提，不承诺 SLA

## 合规边界

- 用户用自己 cookie 调厂商是用户自己的事，运营者不直接参与调用
- 不转售、不抽佣、不对外暴露
- 定位锁死"个人/小团队自用"
- 用 cookie 调厂商内部 API 违反各家 ToS，自用低风险，公开商用高风险

## 落地路径

1. **MVP 核心**：Monorepo + core + mathmind + 豆包 + 即梦 + 消耗表 + 桌面端基础
2. **多厂商 + cookie**：接通义/元宝/可灵/海螺 + cookie 管理器 + 7 家消耗表补齐
3. **团队 + 落地页**：团队额度池 + 成员管理 + admin 消耗表编辑器
4. **打磨**：自动更新 + 代码签名 + 消耗表自动偏差告警 + i18n
