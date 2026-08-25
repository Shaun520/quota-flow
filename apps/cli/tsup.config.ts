import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/cli.ts'],
  format: ['cjs'],
  dts: false,
  splitting: false,
  sourcemap: false,
  clean: true,
  platform: 'node',
  target: 'node20',
  // 只把 workspace 包打进单文件；commander/dotenv/playwright-core 作为真正的运行时依赖
  // （playwright-core 体量大且有动态 require，不适合打包；npm -g 安装时会自动装）
  noExternal: [/@quota-flow/],
  external: ['commander', 'dotenv', 'playwright-core'],
  banner: { js: '#!/usr/bin/env node' },
  outExtension: () => ({ js: '.cjs' }),
});