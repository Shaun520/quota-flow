const { app, safeStorage } = require('electron')
const fs = require('fs')
const path = require('path')
const LOG = path.join(process.env.TEMP || '.', 'qf-auth-probe.log')
const log = (s) => {
  const line = new Date().toISOString() + ' ' + s
  console.log(line)
  try {
    fs.appendFileSync(LOG, line + '\n')
  } catch {}
}

app.whenReady().then(() => {
  try {
    log('user=' + require('os').userInfo().username)
    log('elevated=' + (process.getuid ? 'n/a' : (require('child_process').execSync('net session >NUL 2>&1 && echo yes || echo no').toString().trim())))
    log('avail=' + safeStorage.isEncryptionAvailable())
    // 1) 控制组：加密→解密
    try {
      const enc = safeStorage.encryptString('marker-' + Date.now())
      const dec = safeStorage.decryptString(enc)
      log('roundtrip=' + (dec.startsWith('marker-') ? 'ok' : 'bad'))
    } catch (e) {
      log('roundtrip-fail ' + (e && e.message))
    }
    // 2) 尝试解密 auth.json（@quota-flow/desktop）
    const f1 = path.join(process.env.APPDATA || '', '@quota-flow', 'desktop', 'auth.json')
    try {
      const raw = fs.readFileSync(f1, 'utf8')
      const json = JSON.parse(safeStorage.decryptString(Buffer.from(raw.trim(), 'base64')))
      log('decrypt-app-auth=ok keys=' + Object.keys(json).join(','))
    } catch (e) {
      log('decrypt-app-auth=fail ' + (e && e.message))
    }
  } catch (e) {
    log('fatal ' + (e && e.stack ? e.stack : String(e)))
  }
  app.exit(0)
})

setTimeout(() => {
  log('timeout')
  app.exit(9)
}, 30000)
