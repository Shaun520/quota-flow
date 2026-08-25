<div align="center">

<h1><img src="apps/desktop/src/renderer/src/assets/brand/logo-mark.svg" width="56" align="center" alt="Quota-Flow logo"/> Quota-Flow</h1>

### 一站式 AI 视频生成免费额度调度平台

把豆包 / 千问 / 元宝 / Dola / 智谱清言 / 智谱（bigmodel）/ 火山方舟 / 阿里云百炼 / 腾讯云 9 家厂商的免费视频生成额度，聚合成一个可调度、可观测、可共享的池子。

<p>
  <a href="https://github.com/Shaun520/quota-flow/releases">
    <img src="https://img.shields.io/github/v/release/Shaun520/quota-flow?style=flat-square&sort=semver&color=blue" alt="version"/>
  </a>
  <img src="https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-lightgrey?style=flat-square" alt="platform"/>
  <img src="https://img.shields.io/badge/node-%3E%3D%2020.0.0-green?style=flat-square" alt="node"/>
  <img src="https://img.shields.io/badge/pnpm-9.7.0-orange?style=flat-square" alt="pnpm"/>
  <a href="https://github.com/Shaun520/quota-flow/stargazers">
    <img src="https://img.shields.io/github/stars/Shaun520/quota-flow?style=flat-square" alt="GitHub stars"/>
  </a>
</p>

<p>
  <a href="./README.md">简体中文</a>
  |
  <a href="./README.en.md">English</a>
  |
  <a href="https://github.com/Shaun520/quota-flow/releases">版本发布</a>
  |
  <a href="https://github.com/Shaun520/quota-flow/issues">问题反馈</a>
</p>

</div>

---

## 宣传视频

<video controls muted loop playsinline width="800" src="https://github.com/user-attachments/assets/40601ea8-1ba7-4dc5-beef-f12ec56d978e"></video>

> 无法直接播放？可下载原视频：[桌面端宣传视频.mp4](./docs/桌面端宣传视频.mp4)

## 目录

- [下载最新版](#下载最新版)
- [核心特性](#核心特性)
- [团队共享额度](#团队共享额度)
- [技术架构](#技术架构)
- [Monorepo 结构](#monorepo-结构)
- [技术选型](#技术选型)
- [厂商清单](#厂商清单)
- [快速开始](#快速开始)
  - [自部署](#自部署技术用户)
  - [CLI 真跑示例](#cli-真跑示例)
- [开发命令](#开发命令)
- [开源策略](#开源策略)
- [许可证与贡献说明](#许可证与贡献说明)
- [客户支持](#客户支持)
- [合规边界](#合规边界)
- [落地路径](#落地路径)

## 下载最新版

- 最新 Windows 安装包：[GitHub Releases](https://github.com/Shaun520/quota-flow/releases/latest)
- 下载后运行 `Quota-Flow Setup x.y.z.exe` 即可安装。
- 已安装旧版本的用户可以直接在桌面端“设置 -> 检查更新”升级。

## 核心特性

- **动态额度账本（多单位）**：按厂商原生单位记账（次数/灵感值/积分），支持“时长+分辨率+模型”的动态消耗；0 点自动滚动。
- **等效次数总览**：不同单位统一折算等效次数，用于 UI 总览 + 成员日额度上限。
- **消耗表 Admin 可配**：`provider_cost_tables` 由 admin 后台维护，豆包 5s/10s 等消耗规则随时可改。
- **智能调度 + estimateCost 预检查**：按策略选家前先预估算消耗，跳过“剩余不够本次调用”的账号。
- **多账号池化**：同一家厂商绑多个账号，额度叠加，单账号失效自动切下一个。
- **账号级启用开关**：每个绑定账号可单独启用/停用（默认启用），停用账号被智能调度自动跳过，无需解绑。
- **团队共享额度池**：多人多账号额度叠加成一个池子（核心创新点）。
- **声明式 WebView 接入**：新厂商接入只需填页面 URL + DOM 选择器，平均 2 小时搞定一家；不用逆向风控签名算法（千问 bx-ua / clt-acs-sign 等）。
- **Cookie 自动维护**：WebView 统一执行引擎（提交与保活共享实例池）+ cookie 隔离会话 + 凌晨 3 点自动续命，用户平均 1-2 月重登一次。
- **桌面端优先**：Electron 本地工具，无超时无 CORS；个人账号本地解密，团队公共账号走 Edge Function 代调用（key 不出云端）。
- **官方托管 + 自部署**：95% 用户用官方托管，技术用户可完全自部署。

## 功能使用注意事项

- **账号与 cookie**：cookie 型厂商（豆包/千问/元宝/Dola/智谱清言）需你自己在桌面端完成登录授权；cookie 会过期，应用默认凌晨 3 点自动续命，但**硬 TTL 型会话到期后只能手动重新登录**（目标 1-2 个月重登一次）。请只绑定自己的账号，不要把重要账号的 cookie 交给他人。
- **额度与消耗**：不同厂商额度单位不同（次数/灵感值/积分），消耗由 `provider_cost_tables` 规则驱动（如豆包 5s/10s 扣减不同）；UI 展示的"等效次数"仅用于总览与成员日上限，不代表真实可用额度。免费额度每日 0 点自动滚动，当日用完需等次日。
- **账号启用开关**：每个绑定账号可单独启用/停用，停用账号会被智能调度自动跳过；同一账号重复绑定会收到去重提示。
- **团队共享额度**：团队共享账号的 cookie 会加密存储在云端（key 不出云端），成员使用受日额度上限与席位限制；请只与可信成员共享。
- **自部署**：需自行准备 Supabase 项目（启用 Auth + Postgres），按序执行 `migrations/*.sql`，并在 `.env` 配置 `SUPABASE_URL / SUPABASE_ANON_KEY / SELF_HOSTED=true`。
- **升级**：Windows 安装包在 [GitHub Releases](https://github.com/Shaun520/quota-flow/releases/latest) 下载；已安装旧版本可在桌面端"设置 -> 检查更新"升级。

## 团队共享额度

**开源 + 免费团队 + 共享额度池**

- **个人使用**：单人使用，额度为个人所绑定账号的每日免费额度。
- **团队免费**：多人共用一个额度池，共享账号（团队 cookie）与成员管理完全免费，无订阅费用。
- 仅以免费团队 + 共享额度模式对外，不涉及任何订阅收费。
- 自部署完全免费、无限制、admin 不可见。

## 技术架构

```
Vercel（两个独立项目）
  web/     落地页：定价/文档/下载/注册/赞助
  admin/   后台管理（开源，运营者用，含额度扣减规则）
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
    各家厂商通过 WebView cookie 注入 + 自动提交（API Key 型厂商走开放平台真 API）
    每个共享账号独立隔离会话（session.fromPartition），互不污染
    两种提交方式（模拟用户操作 / 调页面内部 JS API）+ 三级结果提取 fallback
    提交/保活共享实例池，凌晨 3 点静默访问厂商首页自动续命 cookie
```

## Monorepo 结构

> pnpm workspace + Turbo 2

```
quota-flow/
packages/
  core/          调度核心（路由、降级、账本逻辑、等效次数换算、消耗表缓存）
  providers/     厂商适配器（mathmind/qwen/yuanbao 已接入，其余待补）+ estimateCost
  crypto/        AES 加密（团队 cookie 云端加密 + 桌面端本地解密）
  db-supabase/   Supabase 客户端（RLS、Auth、团队权限）
  shared-ui/     React 共享组件（桌面端 + 落地页复用）
  cookie-manager/健康检查 + 自动续期（与 WebView 执行引擎共享实例池）
  logger/        统一日志（桌面端 + CLI + Edge Functions）
  auth/          Supabase Auth 封装（官方托管登录 / 自部署模式切换）
apps/
  web/           落地页（Next.js + React + Vercel）
  admin/         后台管理（开源，Next.js + React + Vercel）
  desktop/       Electron + React（唯一产品入口，WebView 统一引擎）
  cli/           命令行（check-quota / generate / refresh）
  skill/         SKILL.md（可选 Skill 附件）
  migrations/    Supabase SQL 迁移脚本（约定见 migrations/README.md）
```

| 模块 | 状态 |
|---|---|
| `packages/core` | 已实现 |
| `packages/providers` | 部分实现 |
| `apps/cli` | 已实现 |
| `apps/desktop` | 开发中 |
| `apps/web` | 骨架已建 |
| `apps/admin` | 骨架已建 |
| 其余 packages | 骨架已建 |

## 技术选型

- **后端服务**：MVP 阶段不独立部署；团队代调用走 Supabase Edge Functions；本地桌面端如需供 Skill 调用走 Node 内置 http 轻量接口。
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
| doubao | 豆包 doubao.com | 点（次数） | 时长（5s/10s 扣不同） | 文生/图生视频 | WebView cookie 注入 + 自动提交 |
| qwen / qwenwan | 千问（通义万相）qianwen.com | 额度（次数） | 时长 | 文生/图生/多参考/首尾帧视频 | WebView cookie 注入 + 自动提交（风控签名 bx-ua/clt-acs-sign） |
| yuanbao | 元宝混元 yuanbao.tencent.com | 个（次数） | 固定次数 | 文生/图生视频 | WebView cookie 注入 + 自动提交 |
| dola | Dola dola.com | 点（次数） | 时长（5s/10s） | 图生视频（多参考） | WebView cookie 注入 + 自动提交 |
| chatglm | 智谱清言 chatglm.cn | 次 | — | 暂未接入视频生成（仅账号绑定） | WebView cookie 登录（暂不生成） |
| zhipu | 智谱（bigmodel）bigmodel.cn | 次 | 按模型计费（flash 免费 / -2 ¥0.5/次 / -3 ¥1/次） | 文生/图生/首尾帧/多参考视频 | 开放平台真 API（API Key） |
| volcengine | 火山方舟 console.volcengine.com/ark | 次（免费 token 额度） | 免费视频模型按次 | 文生/图生视频 | 开放平台真 API（API Key） |
| bailian | 阿里云百炼 bailian.console.aliyun.com | 次 | 免费额度 | 文生/图生/多参考/首尾帧视频（wan2.7 支持音频参考） | 开放平台真 API（API Key） |
| tokenhub | 腾讯云TokenHub console.cloud.tencent.com/tokenhub | 积分（1 积分≈1 元） | 按模型/时长（如 hy-video-1.5 1.5 积分/次） | 文生/图生视频 | 开放平台真 API（API Key） |

免费额度按厂商分两类绑定：**cookie 型**（豆包/千问/元宝/Dola/智谱清言）走 WebView 统一执行引擎，cookie 注入 + 自动提交（参考 REQUIREMENTS.md §5.12）；千问这类含风控签名的厂商，WebView 前端 JS 自带签名算法，无需逆向。**API Key 型**（智谱/火山方舟/阿里云百炼/腾讯云TokenHub）直接调各开放平台真 API，额度由接入层自动核算。

所有厂商消耗不是固定“1 次”——豆包 5s/10s 的扣减都不一样，由 `provider_cost_tables` 表驱动，最后折算统一的“等效次数”用于 UI 总览 + 成员日额度上限。

## 快速开始

### 自部署（技术用户）

前置：注册 Supabase 空项目（启用 Auth + Postgres）。

```bash
git clone https://github.com/Shaun520/quota-flow.git
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

### 全局安装 CLI（命令行工具）

把 `quota-flow` 装成全局命令，任意目录直接用：

```bash
npm install -g @quota-flow/cli      # 或 pnpm add -g @quota-flow/cli

# 验证是否装好
quota-flow --help
quota-flow --version

# 升级到最新版
npm update -g @quota-flow/cli
```

#### 命令一览

三个子命令，对应「看额度 → 生成 → 刷新账本」的完整流程：

| 命令 | 作用 |
|------|------|
| `quota-flow check-quota [--json]` | 查看每家厂商今日剩余额度和状态（表格 / JSON） |
| `quota-flow generate <参数>` | 生成视频，可选指定厂商或走智能调度 |
| `quota-flow refresh` | 强制把今日额度重设为默认值（凌晨或换了登录态后使用） |

```bash
# 看额度（普通表格）
quota-flow check-quota

# 看额度（JSON，方便脚本解析）
quota-flow check-quota --json

# 刷新今日额度到默认值
quota-flow refresh
```

#### generate 参数详解

```bash
quota-flow generate --mode <text2video|img2video|video2video|imgs2video>
  # 必填：生成模式。

  --prompt "<提示词>"             # 文生视频的提示词；其他模式可省略
  --imageUrl <url>               # 单图生视频（img2video）
  --imageUrls <u1,u2>            # 多图生视频（imgs2video）
  --videoUrls <v1,v2>            # 多视频合成 / 图生视频（video2video）

  --provider <id>                # 强制指定厂商（qwenwan / yuanbao / seedance 等）
  --strategy <s>                 # 不指定厂商时的调度策略：
                                 #   quality_first | cost_first | round_robin | available_first
                                 #   （默认 quality_first）
  --engine <fetch|browser>       # 执行引擎：fetch=静态凭据；browser=真实 Edge 自动抓 cookie（默认 fetch）
  --fallback-rounds <n>          # 失败后最多重试几家厂商（默认 2）
  --coolDown <n>                 # 失败冷却分钟数（默认 10）
  --json                         # 输出 JSON 代替表格文本
```

常用示例：

```bash
# 文生视频，自动选厂商
quota-flow generate --mode text2video --prompt "一只猫在草地上打滚" --json

# 文生视频，强制走某家厂商
quota-flow generate --mode text2video --prompt "一只猫在草地上打滚" --provider yuanbao

# 图生视频
quota-flow generate --mode img2video --imageUrl https://example.com/cat.jpg --prompt "缓缓转头"

# 指定调度策略
quota-flow generate --mode text2video --prompt "海边日落" --strategy cost_first
```

#### 使用前提：需要「登录态」

CLI 本身只是调度前端，真正出片依赖各家厂商的登录凭据（cookie 或 API Key）。`check-quota` 里显示 `offline` 的厂商说明当前缺少可用登录态，直接 `generate` 会因为找不到可用额度来源而失败。

运行时数据默认落在用户主目录 `~/.quota-flow/`（账本 `ledger.json`、任务日志 `jobs.jsonl`），可用环境变量 `QUOTA_FLOW_DATA_DIR=/path` 覆盖：

- **fetch 引擎（默认）**：cookie 型厂商（千问/元宝）把抓取的凭据放 `~/.quota-flow/qwen-auth.json` / `~/.quota-flow/yuanbao-auth.json`（结构见 `packages/providers/src/qwen.ts`、`yuanbao.ts` 顶部注释）；
- **browser 引擎**：传 `--engine browser`，让 CLI 用本机真实 Edge 打开厂商页面自动抓取 cookie，无需手动抠凭据；
- **写库凭据（可选）**：放 `~/.quota-flow/.env`：`SUPABASE_URL` / `SUPABASE_ANON_KEY` / `QUOTA_FLOW_EMAIL` / `QUOTA_FLOW_PASSWORD`，配置后才把任务写入 Supabase jobs 表，否则只落本地 JSONL。

## 开发命令

```bash
pnpm install                           # 安装所有 workspace 依赖（首选；别混用 npm）
pnpm build                             # Turbo 并行构建所有 package（core → providers → cli）
pnpm typecheck                         # Turbo 并行类型检查
pnpm test                              # 运行测试（待实现）

# 单包 / 单 app 开发（--filter 精确）
pnpm --filter @quota-flow/core dev           # core 包监视模式
pnpm --filter @quota-flow/providers dev      # providers 包监视模式
pnpm --filter @quota-flow/cli dev --help     # CLI 帮助

# 桌面端（Electron）
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
| apps/admin | 是（含额度扣减规则编辑器） |

## 许可证与贡献说明

- **许可证**：本仓库目前**尚未确定最终许可证**（计划在 MIT 与 AGPL-3.0 之间选择）。在正式许可证落地前，代码按"仅限个人/小团队自用"开放；如需商用、二次分发或大规模部署，请先通过 [GitHub Issues](https://github.com/Shaun520/quota-flow/issues) 或 2316520653@qq.com 联系确认。
- **贡献**：欢迎提交 issue（bug 反馈、功能建议）与 Pull Request。提交 PR 前请先阅读仓库内 `AGENTS.md` 与 `docs/开发规范/PostgREST数据与AI开发规范.md`，遵循既有代码风格与数据库访问规范。

## 客户支持

- GitHub Issues：bug 反馈、功能建议
- 邮箱：2316520653@qq.com
- 自部署用户：GitHub Issues 可提，不承诺 SLA

## 合规边界

- 用户用自己 cookie 调厂商是用户自己的事，运营者不直接参与调用。
- 不转售、不抽佣、不对外暴露。
- 定位锁死“个人/小团队自用”。
- 用 cookie 调厂商内部 API 违反各家 ToS，自用低风险，公开商用高风险。

## 落地路径

1. **MVP 核心**：Monorepo + core + mathmind + 豆包 + 消耗表 + 桌面端基础
2. **多厂商 + cookie**：接通义/元宝 + cookie 管理器 + 消耗表补齐
3. **团队 + 落地页**：团队额度池 + 成员管理 + admin 额度扣减规则
4. **打磨**：自动更新 + 代码签名 + 消耗表自动偏差告警 + i18n
