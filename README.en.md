<div align="center">

<h1><img src="apps/desktop/src/renderer/src/assets/brand/logo-mark.svg" width="56" align="center" alt="Quota-Flow logo"/> Quota-Flow</h1>

### One-Stop AI Video Generation Free-Quota Scheduler

Aggregate daily free quotas from 9 providers — Doubao / Qwen / Yuanbao / Dola / ChatGLM / Zhipu (bigmodel) / Volcano Ark / Alibaba Cloud Bailian / Tencent Cloud — into a single schedulable, observable, and shareable pool.

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
  <a href="https://github.com/Shaun520/quota-flow/releases">Releases</a>
  |
  <a href="https://github.com/Shaun520/quota-flow/issues">Issues</a>
</p>

</div>

---

## Demo Video

<video controls muted loop playsinline width="800" src="https://github.com/user-attachments/assets/40601ea8-1ba7-4dc5-beef-f12ec56d978e"></video>

> Can't play inline? Download the original: [desktop promo video](./docs/桌面端宣传视频.mp4)

## Table of Contents

- [Download](#download)
- [Core Features](#core-features)
- [Usage Notes](#usage-notes)
- [Team Shared Quota](#team-shared-quota)
- [Architecture](#architecture)
- [Monorepo Structure](#monorepo-structure)
- [Tech Stack](#tech-stack)
- [Supported Providers](#supported-providers)
- [Quick Start](#quick-start)
  - [Self-Hosting](#self-hosting)
  - [CLI Examples](#cli-examples)
- [Development Commands](#development-commands)
- [Open Source Policy](#open-source-policy)
- [Support](#support)
- [Compliance Boundaries](#compliance-boundaries)
- [Roadmap](#roadmap)

## Download

- Latest Windows installer: [GitHub Releases](https://github.com/Shaun520/quota-flow/releases/latest)
- Run `Quota-Flow Setup x.y.z.exe` after downloading.
- Existing users can upgrade via “Settings -> Check for Updates” in the desktop app.

## Core Features

- **Dynamic multi-unit quota ledger**: Tracks each provider’s native unit (count / inspiration / credits), supports dynamic consumption by duration, resolution, and model; auto-rolls over at midnight.
- **Equivalent-count overview**: Normalizes different units into a unified equivalent-count metric for UI dashboards and per-member daily caps.
- **Admin-configurable cost tables**: `provider_cost_tables` is maintained in the admin console; rules like Doubao 5s/10s can be changed anytime.
- **Smart routing + estimateCost pre-check**: Estimates cost before selecting a provider, skipping accounts that cannot afford the call.
- **Multi-account pooling**: Bind multiple accounts per provider to stack quotas; automatically failover when one account expires.
- **Per-account enable switch**: Each bound account can be enabled/disabled individually (default enabled); disabled accounts are skipped by the scheduler without unbinding.
- **Team-shared quota pool**: Multiple people and multiple accounts merge into one shared pool (core innovation).
- **Declarative WebView integration**: Adding a new provider only requires a page URL + DOM selectors, averaging ~2 hours per provider; no need to reverse-engineer risk-control signatures like Qwen’s bx-ua / clt-acs-sign.
- **Automatic cookie maintenance**: Unified WebView execution engine (shared instance pool for submit and keep-alive) + isolated cookie sessions + 3 AM silent renewal, so users re-login only every 1-2 months.
- **Desktop-first**: Electron local tool, no timeout or CORS issues; personal accounts decrypted locally, team shared accounts called via Edge Functions (keys never leave the cloud).
- **Official hosting + self-hosting**: 95% of users use official hosting; technical users can fully self-host.

## Usage Notes

- **Accounts & cookies**: For cookie-based providers (Doubao / Qwen / Yuanbao / Dola / ChatGLM), you must log in and authorize in the desktop app yourself. Cookies expire over time; the app auto-renews them at 3 AM by default, but **hard-TTL sessions must be re-authenticated manually** (typical re-login every 1-2 months). Only bind accounts you own, and never share your important account cookies with others.
- **Quotas & costs**: Different providers use different quota units (count / inspiration points / credits), and consumption is driven by the `provider_cost_tables` rules (e.g., Doubao deducts differently for 5s vs 10s). The "equivalent count" shown in the UI is only for overviews and daily member caps, not real usable quota. Free quotas roll over at midnight; if today's quota runs out, wait until the next day.
- **Per-account enable switch**: Each bound account can be enabled/disabled individually; disabled accounts are automatically skipped by the scheduler. Duplicate binding of the same account triggers a de-duplication notice.
- **Team shared quota**: Shared team accounts' cookies are encrypted and stored in the cloud (keys never leave the cloud); member usage is limited by daily caps and seat limits. Only share with trusted members.
- **Self-hosting**: Requires your own Supabase project (enable Auth + Postgres), run `migrations/*.sql` in order, and configure `SUPABASE_URL / SUPABASE_ANON_KEY / SELF_HOSTED=true` in `.env`.
- **Upgrades**: Windows installers are available on [GitHub Releases](https://github.com/Shaun520/quota-flow/releases/latest); existing users can upgrade via "Settings -> Check for Updates".

## Team Shared Quota

**Open Source + Free Team + Shared Quota Pool**

- **Personal use**: Solo use; quota comes from the daily free quota of your own bound accounts.
- **Free team**: Multiple people share one quota pool; shared accounts (team cookies) and member management are completely free with no subscription cost.
- Offered solely as free teams with a shared quota pool; no subscription billing whatsoever.
- Self-hosting is completely free, unlimited, and invisible to admin.

## Architecture

```
Vercel (two separate projects)
  web/     Landing page: pricing / docs / download / signup / sponsor
  admin/   Admin dashboard (open source, for operators, includes cost-rule editor)
                |
                v
Supabase (Database + Auth + Edge Functions)
  Postgres: ledger, cookies (encrypted), jobs, users, teams, cost tables
  pg_cron: daily midnight quota rollover, cookie health check every 4 hours
  Edge Functions: team cookie proxy calls (shared account keys never leave the cloud)
                ^
                | Desktop connects directly (RLS writes jobs / reads ledger / reads cost tables / AES decrypts own cookies)
                |
Desktop Electron (the only product entry point)
  React UI (4 tabs: Dispatch / History / Team / Settings) — users only see this
  Local scheduling engine (packages/core + providers)
  Unified WebView execution engine (hidden background, see REQUIREMENTS.md §5.12)
    All providers via WebView cookie injection + auto-submit (API-Key-based providers use open-platform real API)
    Each shared account uses an isolated session (session.fromPartition), no cross-contamination
    Two submit modes (simulate user actions / call page internal JS API) + three-tier result-extraction fallback
    Shared instance pool for submit/keep-alive, silent 3 AM homepage visits to renew cookies
```

## Monorepo Structure

> pnpm workspace + Turbo 2

```
quota-flow/
packages/
  core/          Scheduling core (routing, fallback, ledger logic, equivalent-count conversion, cost-table cache)
  providers/     Provider adapters (mathmind/qwen/yuanbao implemented, rest pending) + estimateCost
  crypto/        AES encryption (team cookies encrypted in cloud, decrypted locally on desktop)
  db-supabase/   Supabase client (RLS, Auth, team permissions)
  shared-ui/     Shared React components (desktop + landing page reuse)
  cookie-manager/Health checks + auto-renewal (shares instance pool with WebView engine)
  logger/        Unified logging (desktop + CLI + Edge Functions)
  auth/          Supabase Auth wrapper (official hosting login / self-hosting mode switch)
apps/
  web/           Landing page (Next.js + React + Vercel)
  admin/         Admin dashboard (open source, Next.js + React + Vercel)
  desktop/       Electron + React (the only product entry point, unified WebView engine)
  cli/           Command line (check-quota / generate / refresh)
  skill/         SKILL.md (optional Skill attachment)
  migrations/    Supabase SQL migration scripts (conventions in migrations/README.md)
```

| Module | Status |
|---|---|
| `packages/core` | Implemented |
| `packages/providers` | Partially implemented |
| `apps/cli` | Implemented |
| `apps/desktop` | In development |
| `apps/web` | Skeleton |
| `apps/admin` | Skeleton |
| Other packages | Skeleton |

## Tech Stack

- **Backend services**: No independent backend in MVP; team proxy calls go through Supabase Edge Functions; local desktop can expose a lightweight Node built-in HTTP interface for Skill calls.
- **Database**: Supabase Postgres
- **Encryption**: Node built-in crypto, master key read from system keychain
- **Frontend**: React + TypeScript + Tailwind CSS
- **Desktop**: Electron 28+ LTS + electron-builder + electron-updater (main process references packages/* via workspace dependencies)
- **Monorepo**: pnpm 9 + Turbo 2
- **Build (packages/* dual format)**: tsup 8, outputs CJS + ESM + DTS simultaneously; exports field explicitly declares types/import/require
- **Module system**: Shared workspace tsconfig (ESNext target + Bundler moduleResolution); shared libs dual format; Electron main process can use either; Next.js App Router uses ESM
- **Provider integration layer**: Declarative `WebProviderConfig` (page URL + selectors + two submit modes + three-tier extraction), ~2h per new provider
- **MCP layer**: @modelcontextprotocol/sdk

## Supported Providers

| Provider ID | Product | Quota Unit | Cost Factors | Capabilities | Invocation Method |
|---|---|---|---|---|---|
| doubao | Doubao doubao.com | Points (count) | Duration (5s/10s differ) | Text-to-video / Image-to-video | WebView cookie injection + auto-submit |
| qwen / qwenwan | Qwen (Tongyi Wanxiang) qianwen.com | Quota (count) | Duration | Text-to-video / Image-to-video / Multi-ref / First-last frames | WebView cookie injection + auto-submit (risk-control signatures bx-ua/clt-acs-sign) |
| yuanbao | Yuanbao Hunyuan yuanbao.tencent.com | Count | Fixed count | Text-to-video / Image-to-video | WebView cookie injection + auto-submit |
| dola | Dola dola.com | Points (count) | Duration (5s/10s) | Image-to-video (multi-ref) | WebView cookie injection + auto-submit |
| chatglm | ChatGLM chatglm.cn | Count | — | Account binding only (video generation not yet integrated) | WebView cookie login (no generation yet) |
| zhipu | Zhipu (bigmodel) bigmodel.cn | Count | Per-model billing (flash free / -2 ¥0.5/call / -3 ¥1/call) | Text-to-video / Image-to-video / First-last frames / Multi-ref | Open platform real API (API Key) |
| volcengine | Volcano Ark console.volcengine.com/ark | Count (free token quota) | Free video models per call | Text-to-video / Image-to-video | Open platform real API (API Key) |
| bailian | Alibaba Cloud Bailian bailian.console.aliyun.com | Count | Free quota | Text-to-video / Image-to-video / Multi-ref / First-last frames (wan2.7 supports audio reference) | Open platform real API (API Key) |
| tokenhub | Tencent Cloud TokenHub console.cloud.tencent.com/tokenhub | Credits (1 credit ≈ ¥1) | Per model / duration (e.g. hy-video-1.5 1.5 credits/call) | Text-to-video / Image-to-video | Open platform real API (API Key) |

Free quotas are bound in two ways: **cookie-based providers** (Doubao / Qwen / Yuanbao / Dola / ChatGLM) go through the unified WebView execution engine with cookie injection + auto-submit (see REQUIREMENTS.md §5.12); for Qwen-like risk-control signatures, the WebView front-end JS already contains the signing algorithm, so no reverse engineering is needed. **API-Key-based providers** (Zhipu / Volcano Ark / Alibaba Cloud Bailian / Tencent Cloud TokenHub) call each open platform's real API directly, with quota computed by the integration layer.

Provider costs are not a fixed “1 per call” — Doubao 5s/10s deducts differently. These are driven by the `provider_cost_tables` table and ultimately normalized into a unified “equivalent count” for UI dashboards and per-member daily caps.

## Quick Start

### Self-Hosting

Prerequisites: register a blank Supabase project (enable Auth + Postgres).

```bash
git clone https://github.com/Shaun520/quota-flow.git
cd quota-flow

# 1. Install + build (pnpm monorepo)
pnpm install
pnpm build

# 2. Configure .env (can also be filled in the desktop Settings tab on first launch)
cp .env.example .env
# Fill in: SUPABASE_URL / SUPABASE_ANON_KEY / SELF_HOSTED=true

# 3. Run migrations (schema + initial provider_cost_tables cost rules)
# Option A: Supabase Dashboard → SQL Editor → execute migrations/*.sql in order (conventions in migrations/README.md)
# Option B: Desktop app will prompt to auto-run on first launch

# 4. Start the desktop app
cd apps/desktop && pnpm dev  # Configure Supabase connection in Settings as needed
```

### CLI Examples

Install `quota-flow` as a global command and use it from any directory:

```bash
npm install -g @quota-flow/cli        # or pnpm add -g @quota-flow/cli

# Verify the install
quota-flow --help
quota-flow --version

# Upgrade to the latest
npm update -g @quota-flow/cli
```

Three sub-commands cover "view quotas → generate → refresh ledger":

```bash
# Check remaining quota per provider (table / JSON)
quota-flow check-quota
quota-flow check-quota --json

# Refresh today's quota back to defaults (after midnight or after changing credentials)
quota-flow refresh

# Generate a video (auto-routed)
quota-flow generate --mode text2video --prompt "a cat rolling on the grass" --json

# Generate with a specific provider
quota-flow generate --mode text2video --prompt "a cat rolling on the grass" --provider yuanbao

# Image-to-video
quota-flow generate --mode img2video --imageUrl https://example.com/cat.jpg --prompt "slowly turning head"

# Choose a routing strategy
quota-flow generate --mode text2video --prompt "sunset by the sea" --strategy cost_first
```

Key `generate` options: `--mode <text2video|img2video|video2video|imgs2video>` (required), `--prompt`, `--imageUrl(s)`, `--videoUrls`, `--provider <id>`, `--strategy <quality_first|cost_first|round_robin|available_first>`, `--engine <fetch|browser>`, `--fallback-rounds <n>`, `--coolDown <n>`, `--json`.

> **Note:** The CLI is only a scheduling front-end; actual generation requires per-provider login credentials (cookie or API Key). A provider shown as `offline` in `check-quota` has no usable credentials, so `generate` may fail for lack of an available quota source.

Runtime data defaults to `~/.quota-flow/` (ledger `ledger.json`, task log `jobs.jsonl`); override with `QUOTA_FLOW_DATA_DIR=/path`:
- **fetch engine (default)**: put cookie-based provider credentials (qwen/yuanbao) in `~/.quota-flow/qwen-auth.json` / `~/.quota-flow/yuanbao-auth.json`;
- **browser engine**: pass `--engine browser` to let the CLI open the provider page in your real Edge and auto-capture cookies;
- **optional DB credentials**: put `SUPABASE_URL` / `SUPABASE_ANON_KEY` / `QUOTA_FLOW_EMAIL` / `QUOTA_FLOW_PASSWORD` in `~/.quota-flow/.env` to write jobs into Supabase; otherwise only local JSONL is written.

## Development Commands

```bash
pnpm install                           # Install all workspace dependencies (preferred; do not mix npm)
pnpm build                             # Turbo parallel build for all packages (core → providers → cli)
pnpm typecheck                         # Turbo parallel type check
pnpm test                              # Run tests (pending)

# Single package / app development (--filter precisely)
pnpm --filter @quota-flow/core dev           # core package watch mode
pnpm --filter @quota-flow/providers dev      # providers package watch mode
pnpm --filter @quota-flow/cli dev --help     # CLI help

# Desktop (Electron)
pnpm --filter @quota-flow/desktop dev   # Dev mode
pnpm release                            # Build and package desktop installer
```

## Open Source Policy

| Repository | Open Source |
|---|---|
| packages/* | Yes |
| apps/web | Yes |
| apps/desktop | Yes |
| apps/cli | Yes |
| apps/skill | Yes |
| apps/admin | Yes (includes cost-rule editor) |

## License and Contributing

- **License**: The final license for this repository is **not yet decided** (planned to be MIT or AGPL-3.0). Until the official license is settled, the code is available for personal / small-team self-use only. For commercial use, redistribution, or large-scale deployment, please contact us via [GitHub Issues](https://github.com/Shaun520/quota-flow/issues) or 2316520653@qq.com first.
- **Contributing**: Issues (bug reports, feature requests) and Pull Requests are welcome. Before submitting a PR, please read `AGENTS.md` and `docs/开发规范/PostgREST数据与AI开发规范.md` in the repo, and follow the existing code style and database access conventions.

## Support

- GitHub Issues: bug reports and feature requests
- Email: 2316520653@qq.com
- Self-hosting users: GitHub Issues accepted, no SLA guaranteed

## Compliance Boundaries

- Users calling providers with their own cookies is their own responsibility; the operator does not directly participate in calls.
- No resale, no commission, no public exposure.
- Positioned strictly for “personal / small-team self-use”.
- Calling provider internal APIs with cookies violates each provider’s ToS; low risk for personal use, high risk for public commercial use.

## Roadmap

1. **MVP core**: Monorepo + core + mathmind + Doubao + cost tables + desktop foundation
2. **More providers + cookies**: Connect Qwen / Yuanbao + cookie manager + complete cost tables
3. **Team + landing page**: Team quota pool + member management + admin cost-rule editor
4. **Polish**: Auto-update + code signing + cost-table drift alerts + i18n
