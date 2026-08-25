# 计划：让 `quota-flow` CLI 可作为全局 npm/pnpm 包安装并发布到 npm 公开源

## Summary

把当前只能在 monorepo 内 `pnpm --filter @quota-flow/cli dev` 运行的 CLI，改造成**可 `npm install -g` / `pnpm add -g` 安装后直接用 `quota-flow` 命令**的独立 npm 包，并执行发布到 npmjs.com 公开源。

包含三部分：
1. **打包** —— 用 tsup 把 CLI 及其 workspace 依赖打成单一 ESM 可执行文件，发布只需一个包，零运行时依赖。
2. **数据路径** —— 账本、任务日志、cookie 凭据统一从“相对包目录”改为“用户主目录 `~/.quota-flow/`”（支持 `QUOTA_FLOW_DATA_DIR` 覆盖），否则全局安装后写不进 node_modules。
3. **发布** —— 处理 npm 账号/发包权限，执行 `npm publish`。

---

## Current State Analysis（现状）

- `apps/cli` 是 workspace 私有包（`"private": true`），`bin` 已指到 `./dist/cli.mjs`，但**无 shebang**，即使 build 后全局链上也跑不起来。
- 依赖 `@quota-flow/core`、`@quota-flow/providers`、`@quota-flow/auth`、`@quota-flow/db-supabase`（均 workspace:*），未做 bundle，全局安装无法独立工作。
- tsup 配置：`format: ['cjs','esm']`，未 external/noExternal 声明，workspace 包按依赖链接而非打进产物。
- 运行时数据路径全部硬编码相对包编译目录，全局安装后不可用：
  | 路径 | 位置 | 文件 |
  |---|---|---|
  | LEDGER_PATH | `packages/core/src/ledger.ts:7` | `../../data/ledger.json` |
  | JOBS_PATH | `apps/cli/src/cli.ts:24` | `../../data/jobs.jsonl` |
  | AUTH_PATH(千问) | `packages/providers/src/qwen.ts:29` | `../../data/qwen-auth.json` |
  | AUTH_PATH(元宝) | `packages/providers/src/yuanbao.ts:21` | `../../data/yuanbao-auth.json` |
- 根 `.npmrc` 只有 `enable-pre-post-scripts = true`，无 registry 覆盖；根 `package.json` 无 publish 相关配置。
- 当前 `createAllProviders()` 只实例化 QwenWanProvider + YuanbaoProvider（cookie 型），需对应 auth 文件才能真实生成；未配置时降级 dry-run（不会阻塞安装与运行）。

---

## Proposed Changes（改动清单）

### 1）统一数据根目录辅助函数（新逻辑放 `packages/core`）

**文件**：`packages/core/src/dataDir.ts`（新增，最小工具）并 `packages/core/src/index.ts` 导出

- 功能：`dataDir(): string`
  - 若已设 `process.env.QUOTA_FLOW_DATA_DIR` 且非空，返回之；
  - 否则返回 `path.join(os.homedir(), ".quota-flow")`。
- 导出 `dataFile(name): string` = `path.join(dataDir(), name)`，供各调用方拼具体文件。

> 放在 core 是因为 CLI 与 providers 都要复用，core 是它们的共同依赖，无循环依赖。

### 2）`packages/core/src/ledger.ts` —— 账本路径改用户目录

- `LEDGER_PATH` 从 `path.resolve(__dirname, "..","..","..","data","ledger.json")`
  改为 `dataFile("ledger.json")`（上调第 7 行，改 import 引入 dataFile）。
- 其余 `loadLedger/saveLedger` 逻辑不变。

### 3）`packages/providers` —— cookie/auth 路径改用户目录（千问、元宝）

- `src/qwen.ts:29`：`AUTH_PATH = dataFile("qwen-auth.json")`
- `src/yuanbao.ts:21`：`AUTH_PATH = dataFile("yuanbao-auth.json")`
- 两个文件顶部日志提示语（`data/qwen-auth.json 未配置` / `data/yuanbao-auth.json 未配置`）同步改为 `~/.quota-flow/…`，避免误导。
- 变更说明写进计划假设：桌面端主进程走的是 WebView cookie 注入引擎（`apps/desktop/src/main/*-webview.ts`），不直接调用这两个 provider 的 `AUTH_PATH`，故不影响桌面端；发布后需回归验证一次 desktop 构建/启动不受影响。

### 4）`apps/cli/src/cli.ts`

- **顶部加 shebang**：第一行 `#!/usr/bin/env node`（tsup 会保留）。
- `JOBS_PATH`（第 24 行）改为 `dataFile("jobs.jsonl")`。
- 其余命令逻辑不变。

### 5）`apps/cli/package.json` —— 变为可发布的独立包

- 去掉 `"private": true`。
- `"name"` 保持 `@quota-flow/cli`（scope 保留，最低侵入；不影响 README / CI 里的 `pnpm --filter @quota-flow/cli`）。
- 保留 `bin: { "quota-flow": "./dist/cli.mjs" }`，全局命令即 `quota-flow`。
- 保留 `engines.node >= 20`。
- 新增 `"type": "module"`（产物为 ESM）、`"main"/"module"` 指向 `dist/cli.mjs`（发布元数据完整）。
- 新增 `"files": ["dist", "README.md"]` 与 `"publishConfig": { "access": "public" }`。
- `scripts.prepublishOnly: "pnpm build"`。

### 6）`apps/cli/tsup.config.ts` —— 打进全部依赖、单 ESM 可执行

```ts
export default defineConfig({
  entry: ['src/cli.ts'],
  format: ['esm'],
  dts: false,
  splitting: false,
  sourcemap: false,
  clean: true,
  platform: 'node',
  target: 'node20',
  // 打进 workspace 包 + commander + dotenv，发布单包零运行时依赖
  noExternal: [/.*/],
  banner: { js: '#!/usr/bin/env node' },
  outExtension: () => ({ js: '.mjs' }),
});
```

- 用 `noExternal: [/.*/]` 把 core/providers/auth/db-supabase/commander/dotenv 全部打进单文件，node 内置模块（fs/path/os/http）自动 external。
- 全部路径已改用 `os.homedir()`，规避 ESM bundle 中 `__dirname` 的兼容问题（无残留的 `__dirname` 用法）。
- `dist/cli.mjs` 自带可执行 shebang。

### 7）文档更新

- `README.md` 快速开始新增「全局安装 CLI」小节：
  - `npm install -g @quota-flow/cli`（或 `pnpm add -g @quota-flow/cli`）；
  - 数据目录默认 `~/.quota-flow/`，可用 `QUOTA_FLOW_DATA_DIR` 覆盖；
  - cookie 型厂商凭据放 `~/.quota-flow/qwen-auth.json` / `yuanbao-auth.json`；
  - 使用示例 `quota-flow check-quota` / `quota-flow generate --mode text2video --prompt "..."` / `quota-flow refresh`。
- `apps/cli/.env.example` 补充 `QUOTA_FLOW_DATA_DIR` 说明（可选，非必需）。

---

## 发布：npm 账号与发包权限（针对提问，含步骤）

npm 公开源发包**免费**，只需一个 npm 个人账号（无需付费、无需企业组织才能公开发；只有发**私有**包才要付费订阅）。

获取账号 + 发包权限流程：

1. **注册账号**：浏览器打开 https://www.npmjs.com/signup 注册（邮箱 + 密码 + 用户名），完成邮箱验证。
2. **登录 CLI**：仓库根目录执行 `npm login`（或 `npm adduser`）。
   - 较新 npm 会打开浏览器完成 Web 授权，`~/.npmrc` 会写入 `//registry.npmjs.org/:_authToken=…`。
   - 若账号开启二步验证（2FA/OTP），登录与发布时需输入一次性 token。
3. **scope 归属**：包名为 `@quota-flow/cli`，需要你名下拥有 `quota-flow` 组织。注册后在 npm 网站创建组织 `quota-flow`（免费），并把账号设为可发布成员；或命令行 `npm org create quota-flow <your-username>`。
   发布时命令会校验该 scope 是否有发布权限。
4. **首次发布**：仓库根 `pnpm publish` 或 `cd apps/cli && npm publish --access public`（`prepublishOnly` 会自动先 build）。确认包名未被他人占用；`@quota-flow/cli` 若被占用则需改包名。
5. **验证**：另开终端 `npm install -g @quota-flow/cli`，再 `quota-flow check-quota` 命中已打包产物。

> 交互点：`npm login`（含 OTP）与 `npm publish` 需要账号凭证，无法由进程全自动代跑。实践中：我完成 1–6 节代码改造并本机 `pnpm link --global` 验证；随后与你一起走上面注册/登录（你提供凭证交互），再执行 `pnpm publish`。

---

## Assumptions & Decisions（假设与取舍）

- **包名保留 `@quota-flow/cli`**（带 scope），避免破坏 `pnpm --filter`、CI、README 里的既有引用；全局 bin 名仍是 `quota-flow`，两者不冲突。
- **发布依赖全部 bundle 进单文件**，npm 只下 `@quota-flow/cli` 一个包（0 运行时依赖），安装即用。
- **数据路径统一到 `~/.quota-flow/`**（`QUOTA_FLOW_DATA_DIR` 可覆盖）——符合全局 CLI 惯例，且避免写 node_modules。
- **桌面端不受影响**：桌面端用 WebView cookie 引擎，不调用 qwen/yuanbao provider 的 `AUTH_PATH`；发布前跑一次 desktop 构建/启动回归确认。
- cookie 型厂商（千问/元宝）需用户自行在 `~/.quota-flow/` 放置 auth 文件才会真实扣额生成；未配置时按现有逻辑降级 dry-run，不阻塞安装/运行。
- 每次发布都需手动 `npm publish`（加上自动 2FA 时的 OTP），不涉及 `quota-flow serve`/Skill/MCP 那部分（本次范围外）。

---

## Verification（验证）

1. `pnpm --filter @quota-flow/core build` 与 `pnpm --filter @quota-flow/providers build` 通过，无 TS 报错（typecheck 通过）。
2. `pnpm --filter @quota-flow/cli build` 产出 `dist/cli.mjs` 且首行为 `#!/usr/bin/env node`；用 `file` 或直接执行确认可执行。
3. 本机全局链验证（无账号也能做）：仓库根 `pnpm --filter @quota-flow/cli link --global`（或 `cd apps/cli && pnpm link --global`），任意目录执行 `quota-flow check-quota`、`quota-flow refresh`、`quota-flow generate --mode text2video --prompt "test" --json`，确认正常出表/JSON、并在 `~/.quota-flow/` 生成 `ledger.json` / `jobs.jsonl`，而非写入仓库 `data/`。
4. 注册/登录 npm 后 `pnpm publish --access public`，成功推送。
5. 干净机器/新终端 `npm install -g @quota-flow/cli`，执行 `quota-flow --help` 与 `check-quota` 命中线上包。
6. （回归）桌面端 `pnpm --filter @quota-flow/desktop dev` 或构建一次，确认未因 provider 路径改动受影响。