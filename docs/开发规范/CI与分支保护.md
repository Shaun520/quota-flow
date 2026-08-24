# CI 与分支保护

> 本项目使用 GitHub Actions 搭建 CI/发布工作流。本文说明各工作流用途，以及如何在仓库界面开启分支保护。

## 现有工作流

| 文件 | 触发 | 用途 |
|---|---|---|
| `.github/workflows/ci.yml` | push main / pull_request | 前置质量门槛：typecheck + lint + 单测 + build + 依赖审计 |
| `.github/workflows/release-desktop.yml` | tag `v*`（如 `v0.2.5`） | 三平台（win/mac/linux）桌面端构建并发布到同一 GitHub Release |
| `.github/dependabot.yml` | 每周 | 依赖漏洞/升级自动开 PR |
| `.github/coderabbit.yaml` | PR | 代码审查机器人（需在 Marketplace 安装 CodeRabbit 并授权本仓库） |

## 本地对应命令

```bash
pnpm install                     # 安装依赖
pnpm --filter './packages/*' run build   # 先构建 workspace 包
pnpm run typecheck               # 类型检查（turbo run typecheck）
pnpm run lint                    # ESLint（辅助，不 gate legacy 代码）
pnpm test                        # Vitest 单元测试（packages/*）
pnpm run build                   # 全量构建（turbo run build）
```

## 分支保护（需在 GitHub 界面配置）

以下无法用代码实现，需人工在 **仓库 → Settings → Branches → Add branch protection rule** 针对 `main` 配置：

1. **Require a pull request before merging**
   - Require approvals: 1
   - 主分支当前是「绕过 PR 直推 main」（推送时仓库提示 bypass PR rule），建议改为必须 PR。
2. **Require status checks to pass before merging**
   - 勾选 `CI / Quality gates` 与 `CI / Dependency audit` 为新合并门槛。
3. **Do not allow bypassing the above settings**
   - 开启后连管理员/带 bypass 权限者也不能直推。

> 说明：分支保护规则在仓库 Web 设置里配置，本仓库无 CI 驱动的受保护分支自动管理（如 branch protection API/tf），故以此文档作为操作指引。

## 常见问题

- **PR 里 `@quota-flow/*` 解析失败**：CI 已先执行 `pnpm --filter './packages/*' run build`，与发布工作流一致，无需手动操作。
- **single test 本地跑不进 vitest**：确保测试文件位于 `packages/*/src/**/*.test.ts`（`vitest.config.ts` 的 include 范围）。
- **lint 卡在 legacy 代码**：lint 为辅助项，风格类规则已在 `eslint.config.mjs` 中放宽，仅作提示不阻塞。