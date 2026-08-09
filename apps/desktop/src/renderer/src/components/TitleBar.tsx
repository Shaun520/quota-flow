import { useEffect, useState } from 'react'

export default function TitleBar() {
  const [maximized, setMaximized] = useState(false)

  useEffect(() => {
    if (!window.api?.windowControls?.onMaximizeChange) return
    return window.api.windowControls.onMaximizeChange(setMaximized)
  }, [])

  return (
    <div className="title-bar">
      <div className="title-bar-text">Quota-Flow · Unified LLM Router</div>
      <div className="window-controls">
        <button
          title="最小化"
          aria-label="最小化"
          onClick={() => void window.api?.windowControls?.minimize?.()}
        >
          <svg width="10" height="10" viewBox="0 0 12 12" fill="none" aria-hidden="true">
            <rect x="1" y="5.5" width="10" height="1" fill="currentColor" />
          </svg>
        </button>
        <button
          title={maximized ? '还原' : '最大化'}
          aria-label={maximized ? '还原' : '最大化'}
          onClick={() => void window.api?.windowControls?.toggleMaximize?.()}
        >
          {maximized ? (
            <svg width="10" height="10" viewBox="0 0 12 12" fill="none" aria-hidden="true">
              <rect x="1.5" y="3.5" width="7" height="7" stroke="currentColor" />
              <path d="M3.5 3.5V1.5h7v7h-2" stroke="currentColor" />
            </svg>
          ) : (
            <svg width="10" height="10" viewBox="0 0 12 12" fill="none" aria-hidden="true">
              <rect x="1.5" y="1.5" width="9" height="9" stroke="currentColor" />
            </svg>
          )}
        </button>
        <button
          className="btn-close"
          title="关闭"
          aria-label="关闭"
          onClick={() => void window.api?.windowControls?.close?.()}
        >
          <svg width="10" height="10" viewBox="0 0 12 12" fill="none" aria-hidden="true">
            <path d="M1 1l10 10M11 1L1 11" stroke="currentColor" strokeWidth="1.2" />
          </svg>
        </button>
      </div>
    </div>
  )
}