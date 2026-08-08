import { useEffect, useRef, useState } from 'react'
import type { ProviderId, WebviewTestEvent } from '../../preload'

interface LogLine {
  id: number
  ts: number
  provider: ProviderId
  type: WebviewTestEvent['type']
  message: string
}

const PROVIDER_LABEL: Record<ProviderId, string> = {
  yuanbao: '元宝',
  qwenwan: '千问'
}

let nextId = 1

export default function App() {
  const [provider, setProvider] = useState<ProviderId>('yuanbao')
  const [prompt, setPrompt] = useState('生成5秒视频：一只猫在阳光下跳跃')
  const [logs, setLogs] = useState<LogLine[]>([])
  const [busy, setBusy] = useState(false)
  const logRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const unsubscribe = window.api.webviewTest.onEvent((event) => {
      setLogs((prev) =>
        [
          ...prev,
          { id: nextId++, ts: event.ts, provider: event.provider, type: event.type, message: event.message }
        ].slice(-500)
      )
    })
    return unsubscribe
  }, [])

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight })
  }, [logs])

  const run = async (label: string, action: () => Promise<unknown>): Promise<void> => {
    setBusy(true)
    try {
      const result = (await action()) as {
        ok?: boolean
        message?: string
        reason?: string
        error?: string
      }
      const text =
        result?.message ??
        result?.reason ??
        (result?.error ? `失败：${result.error}` : result?.ok === false ? '操作未成功' : '完成')
      setLogs((prev) => [
        ...prev,
        { id: nextId++, ts: Date.now(), provider, type: 'log', message: `${label}: ${text}` }
      ])
    } catch (err) {
      setLogs((prev) => [
        ...prev,
        {
          id: nextId++,
          ts: Date.now(),
          provider,
          type: 'error',
          message: `${label} 异常：${err instanceof Error ? err.message : String(err)}`
        }
      ])
    } finally {
      setBusy(false)
    }
  }

  const formatTime = (ts: number): string =>
    new Date(ts).toLocaleTimeString('zh-CN', { hour12: false })

  return (
    <div className="app">
      <aside className="sidebar">
        <header className="sidebar-header">
          <h1>Quota-Flow WebView 测试台</h1>
          <p>验证元宝 / 千问 WebView 视频生成可行性</p>
        </header>

        <section className="panel">
          <div className="provider-switch">
            {(Object.keys(PROVIDER_LABEL) as ProviderId[]).map((p) => (
              <button
                key={p}
                className={provider === p ? 'active' : ''}
                onClick={() => setProvider(p)}
                disabled={busy}
              >
                {PROVIDER_LABEL[p]}
              </button>
            ))}
          </div>
          <div className="actions">
            <button
              onClick={() => void run(`打开 ${PROVIDER_LABEL[provider]}`, () => window.api.webviewTest.open(provider))}
              disabled={busy}
            >
              打开 WebView
            </button>
            <button
              onClick={() => void run('注入 Cookie', () => window.api.webviewTest.injectCookies(provider))}
              disabled={busy}
            >
              注入本地 Cookie
            </button>
            <button
              onClick={async () => {
                setBusy(true)
                try {
                  const info = await window.api.webviewTest.inspect(provider)
                  setLogs((prev) => [
                    ...prev,
                    {
                      id: nextId++,
                      ts: Date.now(),
                      provider,
                      type: 'log',
                      message: `DOM 诊断：输入框=${info.inputFound ? info.inputTag : '未找到'}，候选按钮：${JSON.stringify(info.candidates)}`
                    }
                  ])
                } finally {
                  setBusy(false)
                }
              }}
              disabled={busy}
            >
              诊断 DOM
            </button>
            <button onClick={() => void window.api.webviewTest.openDevTools(provider)} disabled={busy}>
              打开 DevTools
            </button>
          </div>
        </section>

        <section className="panel">
          <label htmlFor="prompt">生成 Prompt</label>
          <textarea
            id="prompt"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            rows={3}
            disabled={busy}
          />
          <div className="actions">
            <button
              className="primary"
              onClick={() => void run('自动填写并发送', () => window.api.webviewTest.autoSend(provider, prompt))}
              disabled={busy}
            >
              自动填写并发送
            </button>
            <button
              onClick={() => void run('轮询视频结果', () => window.api.webviewTest.poll(provider))}
              disabled={busy}
            >
              {busy ? '处理中…' : '轮询结果'}
            </button>
            <button
              onClick={() => void run('关闭', () => window.api.webviewTest.close(provider))}
              disabled={busy}
            >
              关闭视图
            </button>
          </div>
        </section>

        <section className="panel tips">
          <h2>操作提示</h2>
          <ul>
            <li>先“注入 Cookie”，再打开 WebView；也可以直接在右侧手动登录</li>
            <li>自动填写失败时，可手动在右侧输入并发送，DevTools 里能看到真实网络请求</li>
            <li>发送后等待“捕获生成请求”日志出现，再点“轮询结果”取视频 URL</li>
            <li>每次真实发送都会消耗当日 1 次免费额度（两家各 5 次/天）</li>
          </ul>
        </section>

        <section className="panel log-panel">
          <h2>运行日志</h2>
          <div className="log" ref={logRef}>
            {logs.length === 0 && <p className="empty">暂无日志</p>}
            {logs.map((l) => (
              <p key={l.id} className={`log-line ${l.type}`}>
                <span className="log-time">{formatTime(l.ts)}</span>
                <span className="log-provider">{PROVIDER_LABEL[l.provider]}</span>
                <span className="log-msg">{l.message}</span>
              </p>
            ))}
          </div>
        </section>
      </aside>
    </div>
  )
}
