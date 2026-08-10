import { useState } from 'react'
import { IconClose } from './icons'

const WELCOME_DISMISS_KEY = 'quota-flow:welcome-dismissed'

interface WelcomeBannerProps {
  displayName: string
  step: 1 | 2 | 3
  onGoProviders: () => void
  onGoDashboard: () => void
  onStep3Done: () => void
}

const STEP_DEFS = [
  { title: '绑定厂商账号', desc: '选择一个厂商并完成账号绑定' },
  { title: '生成第一条视频', desc: '填写描述，点击「开始生成」' },
  { title: '完成新手引导', desc: '点击下方按钮开始使用' }
]

export default function WelcomeBanner({
  displayName,
  step,
  onGoProviders,
  onGoDashboard,
  onStep3Done
}: WelcomeBannerProps) {
  const [dismissed, setDismissed] = useState(() => {
    try {
      return localStorage.getItem(WELCOME_DISMISS_KEY) === '1'
    } catch {
      return false
    }
  })

  if (dismissed) return null

  const dismiss = (): void => {
    try {
      localStorage.setItem(WELCOME_DISMISS_KEY, '1')
    } catch {
      // ignore
    }
    setDismissed(true)
  }

  return (
    <div className="welcome-banner">
      <div className="welcome-main">
        <div className="welcome-title">欢迎，{displayName}！只需几步，开始你的第一个 AI 视频</div>
        <div className="welcome-steps">
          {STEP_DEFS.map((s, i) => {
            const n = (i + 1) as 1 | 2 | 3
            const done = n < step
            const active = n === step
            return (
              <div
                className={'welcome-step' + (done ? ' done' : '') + (active ? ' active' : '')}
                key={n}
              >
                <span className="welcome-step-num">{done ? '✓' : n}</span>
                <div>
                  <strong>{s.title}</strong>
                  <p>{s.desc}</p>
                </div>
              </div>
            )
          })}
        </div>
        <div className="welcome-actions">
          {step === 1 && (
            <button className="btn-sm primary" onClick={onGoProviders}>
              去绑定账号 →
            </button>
          )}
          {step === 2 && (
            <button className="btn-sm primary" onClick={onGoDashboard}>
              去生成视频 →
            </button>
          )}
          {step === 3 && (
            <button className="btn-sm primary" onClick={onStep3Done}>
              完成，开始使用 ✓
            </button>
          )}
          <button className="btn-sm" onClick={dismiss}>
            稍后再说
          </button>
        </div>
      </div>
      <button className="welcome-close" onClick={dismiss} aria-label="关闭引导">
        <IconClose size={14} />
      </button>
    </div>
  )
}