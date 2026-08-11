// 风控探针逻辑单测：mock fetch 响应体，验证 verify/limit/ok 检测（不碰豆包）
// 运行：cd apps/desktop && npx --no-install electron scripts/risk-probe-test.cjs

const { app, BrowserWindow } = require('electron')
const fs = require('fs')
const os = require('os')
const path = require('path')

const html = `<!doctype html><html><body>
<script>
  window.__mockCalls = 0
  window.fetch = async (u) => {
    window.__mockCalls++
    if (String(u).includes('chat/completion')) {
      return new Response(window.__mockBody || '{}', { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
    }
    return new Response('{}', { status: 200 })
  }
</script>
</body></html>`

const file = path.join(os.tmpdir(), 'qf-risk-test.html')
fs.writeFileSync(file, html, 'utf8')

// 与 webview-engine.ts riskProbeScript / readRiskScript 同逻辑（复制用于单测）
const riskProbeScript = () => {
  if (window.__qfRiskProbeHooked) return { ok: true, already: true }
  window.__qfRisk = { type: 'none', detail: null, at: 0 }
  const setRisk = (type, detail) => { window.__qfRisk = { type, detail: detail ? detail.slice(-400) : null, at: Date.now() } }
  const analyze = (acc) => {
    if (!acc) return
    if (/async_task|"task_id"/.test(acc)) {
      if (window.__qfRisk.type !== 'verify') setRisk('ok', null)
      return
    }
    if (/710022002|710022004/.test(acc)) { setRisk('limit', acc.slice(-400)); return }
    if (/verify_scene|decision[^}]{0,80}verify/i.test(acc)) setRisk('verify', acc.slice(-400))
  }
  const grab = (url, p) => {
    p.then((resp) => {
      try {
        if (!resp || !resp.body || !resp.clone || !resp.body.getReader) return
        const clone = resp.clone()
        if (!clone.body) return
        const reader = clone.body.getReader()
        const decoder = new TextDecoder()
        let acc = ''
        const pump = () => {
          reader.read().then(({ done, value }) => {
            if (done) return
            acc += decoder.decode(value, { stream: true })
            if (acc.length > 300000) acc = acc.slice(-200000)
            analyze(acc)
            pump()
          }).catch(() => {})
        }
        pump()
      } catch {}
    }).catch(() => {})
  }
  const origFetch = window.fetch
  if (origFetch && !window.__qfFetchHooked) {
    window.fetch = function (...args) {
      let u = ''
      try { u = typeof args[0] === 'string' ? args[0] : (args[0] && (args[0].url || '')) || '' } catch {}
      const p = origFetch.apply(this, args)
      if (/chat\/completion|samantha\/chat/.test(u)) grab(u, p)
      return p
    }
    window.__qfFetchHooked = true
  }
  return { ok: true }
}

const readRiskScript = () => {
  const w = window.__qfRisk || { type: 'none' }
  return { type: w.type, detail: w.detail || null }
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 800, height: 600, webPreferences: { sandbox: false, contextIsolation: false } })
  await win.loadFile(file)
  await new Promise((r) => setTimeout(r, 300))
  await win.webContents.executeJavaScript('(' + riskProbeScript.toString() + ')()', true)

  const cases = [
    { name: 'verify', body: '{"verify_scene":"doubao_message_web","detail":"xxxx"}\n\nevent: SSE_REPLY_END\ndata: {"end_type":3}' },
    { name: 'limit', body: '{"error_code":710022002,"msg":"too frequent"}' },
    { name: 'ok', body: '{"fin_reason":{"async_task":{"id":"abc123"}}}' },
    { name: 'plain', body: '{"ack":"1"}\n\nevent: SSE_REPLY_END\ndata: {"end_type":3}' }
  ]
  const results = []
  for (const c of cases) {
    await win.webContents.executeJavaScript('window.__qfRisk = { type: "none", detail: null, at: 0 }; window.__mockBody = ' + JSON.stringify(c.body) + '; fetch("/chat/completion")', true)
    await new Promise((r) => setTimeout(r, 500))
    const risk = await win.webContents.executeJavaScript('(' + readRiskScript.toString() + ')()', true)
    results.push({ case: c.name, detected: risk.type })
    console.log(JSON.stringify({ case: c.name, expected: c.name === 'plain' ? 'none' : c.name, detected: risk.type }))
  }
  console.log(JSON.stringify({ results }))
  app.exit(0)
})

setTimeout(() => app.exit(3), 30000)
