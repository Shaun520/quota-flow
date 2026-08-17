<div align="center">

<h1><img src="apps/desktop/src/renderer/src/assets/brand/logo-mark.svg" width="56" align="center" alt="Quota-Flow logo"/> Quota-Flow</h1>

### One-Stop AI Video Generation Free-Quota Scheduler

Aggregate daily free quotas from Doubao / Jimeng / Qwen / Yuanbao / Kling / Hailuo and more into a single schedulable, observable, and shareable pool.

<p>
  <a href="https://github.com/Shaun520/quota-flow/releases">
    <img src="https://img.shields.io/badge/version-0.1.0-blue?style=flat-square" alt="version"/>
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

## Table of Contents

- [Download](#download)
- [Core Features](#core-features)
- [Business Model](#business-model)
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
- **Admin-configurable cost tables**: `provider_cost_tables` is maintained in the admin console; rules like Doubao 5s/10s or Jimeng 720p/1080p can be changed anytime.
- **Smart routing + estimateCost pre-check**: Estimates cost before selecting a provider, skipping accounts that cannot afford the call.
- **Multi-account pooling**: Bind multiple accounts per provider to stack quotas; automatically failover when one account expires.
- **Per-account enable switch**: Each bound account can be enabled/disabled individually (default enabled); disabled accounts are skipped by the scheduler without unbinding.
- **Team-shared quota pool**: Multiple people and multiple accounts merge into one shared pool (core innovation).
- **Declarative WebView integration**: Adding a new provider only requires a page URL + DOM selectors, averaging ~2 hours per provider; no need to reverse-engineer risk-control signatures like Qwen’s bx-ua / clt-acs-sign.
- **Automatic cookie maintenance**: Unified WebView execution engine (shared instance pool for submit and keep-alive) + isolated cookie sessions + 3 AM silent renewal, so users re-login only every 1-2 months.
- **Desktop-first**: Electron local tool, no timeout or CORS issues; personal accounts decrypted locally, team shared accounts called via Edge Functions (keys never leave the cloud).
- **Official hosting + self-hosting**: 95% of users use official hosting; technical users can fully self-host.

## Business Model

**Open Source + Official Hosting + Self-Hosting**

| Plan | Price | Seats | Best For |
|---|---|---|---|
| Personal Free | $0 | 1 | Individual users |
| Team Free | $0 | Up to 3 | Small teams trying it out |
| Team Pro | $9/mo | Up to 10 | Serious small teams |
| Team Business | $29/mo | Up to 30 | Larger teams |

All plans have identical features; only the team size limit differs. Self-hosting is completely free, unlimited, and invisible to admin.

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
    All 7 providers via WebView cookie injection + auto-submit (except mcp_mathmind real API)
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
| doubao | Doubao doubao.com | count | Duration (5s/10s differ) | text/image | WebView cookie injection + auto-submit (Node.js HTTP adapter fallback) |
| jimeng | Jimeng jimeng.jianying.com | inspiration | Duration + resolution + model | text/image/multi-image/video-extension | WebView cookie injection + auto-submit |
| qwenwan | Tongyi Wanxiang tongyi.aliyun.com / qianwen.com | count | Duration | text/image/video-extension | WebView cookie injection + auto-submit (risk-control signatures bx-ua/clt-acs-sign, CLI cannot call directly) |
| yuanbao | Yuanbao Hunyuan yuanbao.tencent.com | count | Fixed count | text/image | WebView cookie injection + auto-submit (Node.js HTTP adapter fallback) |
| kling | Kling klingai.kuaishou.com | credits | Duration + resolution | text/image | WebView cookie injection + auto-submit |
| hailuo | Hailuo hailuo.com | count | Fixed count | text | WebView cookie injection + auto-submit |
| mathmind | mcp_mathmind-video | count | Fixed count | img2video/imgs2video/video2video | Real API (the only exception to the WebView approach) |

Mainstream Chinese mainland providers tie free quotas to login state, not API keys. **mcp_mathmind is the only provider using a real API; the other 6 use the unified WebView execution engine** (cookie injection + auto-submit, see REQUIREMENTS.md §5.12). For providers like Qwen with risk-control signatures, the WebView front-end JS already contains the signing algorithm, so no reverse engineering is needed.

Provider costs are not a fixed “1 per call” — Doubao 5s/10s, Jimeng 720p/1080p, Kling 5s/10s all deduct differently. These are driven by the `provider_cost_tables` table and ultimately normalized into a unified “equivalent count” for UI dashboards and per-member daily caps.

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

```bash
# Check quotas (currently mathmind / qwenwan / yuanbao are connected)
pnpm --filter @quota-flow/cli dev check-quota

# Generate once with a specific provider (needs cookie + conversationId in data/yuanbao-auth.json)
pnpm --filter @quota-flow/cli dev generate --mode text2video \
  --prompt "Generate a 5-second cat video" --provider yuanbao --json

# Generate without specifying a provider (scheduler picks automatically)
pnpm --filter @quota-flow/cli dev generate --mode text2video \
  --prompt "Generate a 5-second cat video" --json

# Refresh ledger (re-read local ledger + re-estimate equivalent counts)
pnpm --filter @quota-flow/cli dev refresh
```

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

## Support

- GitHub Issues: bug reports and feature requests
- Email: support@quota-flow.com
- Self-hosting users: GitHub Issues accepted, no SLA guaranteed

## Compliance Boundaries

- Users calling providers with their own cookies is their own responsibility; the operator does not directly participate in calls.
- No resale, no commission, no public exposure.
- Positioned strictly for “personal / small-team self-use”.
- Calling provider internal APIs with cookies violates each provider’s ToS; low risk for personal use, high risk for public commercial use.

## Roadmap

1. **MVP core**: Monorepo + core + mathmind + Doubao + Jimeng + cost tables + desktop foundation
2. **More providers + cookies**: Connect Qwen / Yuanbao / Kling / Hailuo + cookie manager + complete cost tables for all 7 providers
3. **Team + landing page**: Team quota pool + member management + admin cost-rule editor
4. **Polish**: Auto-update + code signing + cost-table drift alerts + i18n
