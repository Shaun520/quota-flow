import { useState } from 'react'

export default function App() {
  const [pong, setPong] = useState('')

  return (
    <main className="app">
      <h1>Quota-Flow Desktop</h1>
      <p className="subtitle">Electron + Vite + React 最小壳已启动</p>

      <section className="panel">
        <h2>运行时版本</h2>
        <ul>
          <li>Electron：{window.api.versions.electron}</li>
          <li>Chromium：{window.api.versions.chrome}</li>
          <li>Node.js：{window.api.versions.node}</li>
        </ul>
      </section>

      <section className="panel">
        <h2>IPC 测试</h2>
        <button onClick={() => void window.api.ping().then(setPong)}>ping 主进程</button>
        {pong && <p>主进程返回：{pong}</p>}
      </section>
    </main>
  )
}
