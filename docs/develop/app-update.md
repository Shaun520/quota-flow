# App 更新方案：发布 + 旧版本客户端升级通知

> 更新日期：2026-08-13

## Summary

- 发布入口使用 `electron-updater` + GitHub Releases：本地构建并发布新版本，旧版本桌面端启动时或定期检查 GitHub Releases，发现新版本后提示用户下载、重启安装。
- 公告模块只负责发布“版本更新说明”，不负责安装更新；实际更新逻辑由 Electron 主进程处理。
- 当前已有部分更新代码和配置，需要补齐发布脚本、更新交互入口、版本显示和完整流程验证。

## Key Changes

### 发布流程

- 保留 `apps/desktop/electron-builder.yml` 的 GitHub publish 配置（owner `Shaun520`，repo `quota-flow`）。
- 新增/调整脚本：`release:publish` 使用 `electron-builder --win --publish always`，发布时依赖 `GH_TOKEN`。
- 发布前必须更新 `apps/desktop/package.json` 的 `version`；状态栏版本号改成从应用版本读取，不要再硬编码。
- 发布产物需要包含 Windows NSIS 安装包和 `latest.yml`，`electron-updater` 靠它判断新版本。

### 桌面端更新逻辑

- 主进程继续使用 `autoUpdater`，只在 `app.isPackaged` 时执行更新检查。
- 启动后延迟检查一次，之后每 4 小时后台检查一次；也提供手动检查入口。
- 新增 `updater.download` IPC：发现新版本后由用户点“下载更新”再开始下载，避免一打开就默默下载大安装包。
- 下载完成后推送 `downloaded` 状态，用户点“重启安装”调用 `quitAndInstall()`。

### 客户端通知体验

- 发现新版本时，弹窗提醒一次（按版本号记录本地已提醒状态），按钮为“稍后”和“下载更新”；点“稍后”后状态栏继续保留更新入口。
- 底部状态栏显示更新状态：检查中、发现新版本、下载进度、已下载可重启安装、检查失败。
- 设置弹窗增加“检查更新”区域，显示当前版本和检查结果，支持手动触发检查。

### 版本说明

- Admin 发布 `kind=update` 公告用于展示更新内容。
- 桌面端铃铛下拉可展示版本更新说明，但安装动作只走 `electron-updater`，不放进公告逻辑。

## Test Plan

- 类型检查：
  - `pnpm --filter @quota-flow/desktop typecheck`
  - `pnpm --filter @quota-flow/admin typecheck`
- 构建检查：
  - `pnpm --filter @quota-flow/desktop build`
  - `pnpm --filter @quota-flow/desktop release:dir` 确认打包产物包含主进程更新代码。
- 发布验证：
  - 修改版本号后发布到 GitHub Releases，确认 Release 资产包含 NSIS 安装包和 `latest.yml`。
- 升级验证：
  - 安装旧版本包，启动后确认能检查到新版本；
  - 点“下载更新”能看到下载进度；
  - 下载完成后点“重启安装”，确认应用升级到新版本；
  - 设置页“检查更新”可手动触发并显示当前状态。

## Assumptions

- 首批只做 Windows 更新，使用 NSIS 安装包作为自动更新目标；portable 包可以发布但只适合手动下载。
- 更新检查不是“服务端实时推送”，而是旧版本客户端启动/定时/手动检查时发现新版本。
- 当前不做代码签名，Windows 可能出现 SmartScreen 风险提示；后续可单独补签名流程。
- GitHub Releases 使用公开仓库 `Shaun520/quota-flow`，`electron-updater` 可以直接访问。
