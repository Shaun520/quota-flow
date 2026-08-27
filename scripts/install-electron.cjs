// Electron 43+ 采用 lazy download（electron/rfcs#0022），npm 包内不再带 postinstall 钩子，
// pnpm install 后二进制不会自动下载，electron-vite dev 会报 "Electron uninstall"。
// 本脚本作为根 postinstall 钩子：每次 pnpm install 后补齐二进制（幂等，已安装则秒退）。

const { execFileSync } = require('node:child_process')
const path = require('node:path')

// 未显式设置时默认走 npmmirror 镜像（实测可用）；可用环境变量 ELECTRON_MIRROR 覆盖
process.env.ELECTRON_MIRROR ||= 'https://npmmirror.com/mirrors/electron/'

try {
  const installJs = require.resolve('electron/install.js', {
    paths: [path.join(__dirname, '..', 'apps', 'desktop')],
  })
  execFileSync(process.execPath, [installJs], { stdio: 'inherit' })
} catch (err) {
  // 选择性安装（如 --filter 只装 web）时 electron 可能未安装，跳过即可，不阻断安装
  console.warn('[install-electron] 跳过：', err.message)
}
