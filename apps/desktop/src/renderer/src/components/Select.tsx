import { useEffect, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import { IconChevron } from './icons'

export interface SelectOption {
  value: string
  label: string
  disabled?: boolean
}

interface SelectProps {
  value: string
  onChange: (value: string) => void
  options: SelectOption[]
  disabled?: boolean
  id?: string
  style?: CSSProperties
}

/** 自绘下拉：替代原生 <select>，避免 Windows 白色系统弹层（软件合成下点击会闪白） */
export default function Select({ value, onChange, options, disabled, id, style }: SelectProps) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDocClick = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDocClick)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDocClick)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const selected = options.find((o) => o.value === value)

  return (
    <div className="qf-select" ref={rootRef} style={style}>
      <button
        type="button"
        id={id}
        className="qf-select-trigger"
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <span className="qf-select-label">{selected?.label ?? value}</span>
        <IconChevron size={12} className={'qf-select-chevron' + (open ? ' open' : '')} />
      </button>
      {open && (
        <div className="qf-select-menu" role="listbox">
          {options.map((o) => (
            <button
              type="button"
              key={o.value}
              role="option"
              aria-selected={o.value === value}
              disabled={o.disabled}
              className={'qf-select-item' + (o.value === value ? ' active' : '') + (o.disabled ? ' disabled' : '')}
              onClick={() => {
                onChange(o.value)
                setOpen(false)
              }}
            >
              <span>{o.label}</span>
              {o.value === value && (
                <svg className="qf-select-check" width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                  <path d="M5 13l4 4 10-10" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
