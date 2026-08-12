# 桌面端安装体积分析报告

> 分析日期：2026-08-12
> 分析对象：`apps/desktop/release/win-unpacked/`（安装后程序本体）
> 当前体积：**~356MB**（不含安装包，安装后的程序目录）

## 一、体积构成明细

| 文件/目录 | 大小 | 类型 | 能否优化 |
|-----------|------|------|----------|
| `Quota-Flow.exe` | 215.01 MB | Electron 主程序（含 Chromium 引擎） | ❌ 固有成本 |
| `locales/`（55 个语言包） | 46.65 MB | Chromium 多语言资源 | ✅ **可大幅优化** |
| `dxcompiler.dll` | 24.43 MB | DirectX 编译器 | ❌ 固有成本 |
| `LICENSES.chromium.html` | 19.37 MB | Chromium 许可证文本 | ❌ 固有成本 |
| `icudtl.dat` | 10.37 MB | ICU 国际化数据 | ❌ 固有成本 |
| `resources/app.asar` | 8.41 MB | **应用自身代码** | ✅ 可优化 |
| `libGLESv2.dll` | 7.66 MB | Chromium 图形库（OpenGL ES） | ❌ 固有成本 |
| `resources.pak` | 6.90 MB | Chromium 核心资源 | ❌ 固有成本 |
| `vk_swiftshader.dll` | 5.25 MB | Vulkan 软件渲染 | ❌ 固有成本 |
| `d3dcompiler_47.dll` | 4.52 MB | DirectX 编译器 | ❌ 固有成本 |
| `ffmpeg.dll` | 2.93 MB | 视频/音频解码 | ❌ 固有成本 |
| `dxil.dll` | 1.44 MB | DirectX 中间语言 | ❌ 固有成本 |
| `vulkan-1.dll` | 0.89 MB | Vulkan API | ❌ 固有成本 |
| `v8_context_snapshot.bin` | 0.71 MB | V8 引擎快照 | ❌ 固有成本 |
| `libEGL.dll` | 0.45 MB | EGL 图形接口 | ❌ 固有成本 |
| `snapshot_blob.bin` | 0.35 MB | V8 引擎快照 | ❌ 固有成本 |
| `chrome_200_percent.pak` | 0.19 MB | Chromium UI 高分辨率资源 | ❌ 固有成本 |
| `chrome_100_percent.pak` | 0.11 MB | Chromium UI 标准分辨率资源 | ❌ 固有成本 |
| 其他（`elevate.exe`、`version` 等） | ~0.2 MB | - | - |

## 二、核心结论

**应用自身代码仅约 8MB（`app.asar`），其余 ~348MB 均为 Electron/Chromium 框架的固有成本。**

这是所有 Electron 应用的共同特征：Electron 打包了完整的 Chromium 浏览器引擎，因此安装后最小体积即为 ~250-300MB，与业务代码多少无关。

## 三、可优化项

### 1. locales 语言包（预计节省 ~45MB）⭐ 最大优化点

当前打包了 **55 个语言包**（共 46.65MB），但应用仅需要中文和英文。

**方案**：在 `apps/desktop/electron-builder.yml` 中添加：

```yaml
electronLanguages:
  - zh-CN
  - en-US
```

**预计节省：~45MB**

### 2. app.asar 内的冗余内容（预计节省 ~2-3MB）

`app.asar`（8.41MB）中包含了 workspace 依赖包的完整源码和构建中间产物：

- `@quota-flow/auth/.turbo/` — Turbo 构建日志
- `@quota-flow/auth/src/` — TypeScript 源码（无需运行时）
- `@quota-flow/auth/tsconfig.json`、`tsup.config.ts` — 构建配置
- `@quota-flow/db-supabase/` — 同样的问题
- `@supabase/auth-js/` — `.d.ts.map` sourcemap、`AGENTS.md` 等冗余文件

**方案**：在 `apps/desktop/electron-builder.yml` 的 `files` 中排除这些：

```yaml
files:
  - out/**
  - "!node_modules/@quota-flow/*/src/**"
  - "!node_modules/@quota-flow/*/.turbo/**"
  - "!node_modules/@quota-flow/*/tsconfig.json"
  - "!node_modules/@quota-flow/*/tsup.config.ts"
  - "!node_modules/@quota-flow/*/dist/*.map"
  - "!node_modules/@supabase/**/*.map"
  - "!node_modules/@supabase/**/src/**"
  - "!node_modules/@supabase/**/*.tsbuildinfo"
```

**预计节省：~2-3MB**

## 四、不可优化项（~300MB）

以下为 Electron/Chromium 框架固有成本，无法通过配置缩减：

- `Quota-Flow.exe`（215MB）— Electron 主程序，内嵌完整 Chromium 引擎
- `dxcompiler.dll`（24MB）— DirectX 着色器编译器
- `LICENSES.chromium.html`（19MB）— Chromium 开源许可文本
- `icudtl.dat`（10MB）— Unicode 国际化数据
- `libGLESv2.dll` / `vk_swiftshader.dll` / `d3dcompiler_47.dll`（~18MB）— 图形渲染库
- `resources.pak`（7MB）— Chromium 内置资源
- `ffmpeg.dll`（3MB）— 多媒体解码

## 五、优化后预期

| 项目 | 当前 | 优化后 |
|------|------|--------|
| 安装后程序体积 | ~356 MB | **~306 MB** |
| NSIS 安装包 | ~96 MB | ~90 MB |

> ✅ **已实施优化（2026-08-12）**：实际打包验证结果为 `app.asar` 从 8.41MB 降至 4.76MB（节省 3.65MB），安装后总体积从 356MB 降至 **306.54MB**（节省 ~50MB）。
>
> 修改文件：`apps/desktop/electron-builder.yml`，添加了 `electronLanguages` 配置和 `files` 排除规则。
>
> **安装包实际体积对比**：
>
> | 安装包 | 优化前 | 优化后 | 节省 |
> |--------|--------|--------|------|
> | `Quota-Flow Setup 0.1.0.exe`（NSIS） | ~96 MB | **87.89 MB** | ~8 MB |
> | `Quota-Flow Portable 0.1.0.exe`（便携版） | ~94.86 MB | **87.65 MB** | ~7 MB |
>
> 生成命令：`pnpm run release`（即 `pnpm run build && electron-builder --win`）

## 六、根本性方案：更换框架

如果 300MB 仍然过大，唯一根本方案是更换桌面框架，将体积降至 ~10-25MB：

| 框架 | 技术栈 | 安装后体积 | 迁移成本 |
|------|--------|-----------|----------|
| **Tauri** | Rust + WebView2 | ~10-20 MB | 高：主进程逻辑需用 Rust 重写 |
| **Wails** | Go + WebView2 | ~15-25 MB | 高：主进程逻辑需用 Go 重写 |

### 迁移影响评估

当前项目中依赖 Node.js 生态的部分：

- `apps/desktop/src/main/webview-engine.ts` — WebView 控制逻辑
- `apps/desktop/src/main/providers.ts` — 厂商 Provider 管理
- `packages/db-supabase/` — Supabase 客户端（`@supabase/auth-js`）
- `packages/auth/` — 认证逻辑

这些代码在迁移到 Tauri/Wails 时均需使用对应语言重新实现，**迁移成本较高**。建议当前阶段先执行 locales 和 asar 优化。

## 七、相关文件

- `apps/desktop/electron-builder.yml` — 打包配置（需修改添加优化项）
- `apps/desktop/package.json` — 依赖声明
- `apps/desktop/electron.vite.config.ts` — Vite 构建配置