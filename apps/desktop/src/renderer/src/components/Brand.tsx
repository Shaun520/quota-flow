interface BrandMarkProps {
  size?: number
  className?: string
}

/** Quota-Flow 品牌标：额度仪表弧 + 视频播放三角 + 三家汇聚节点 */
export function BrandMark({ size = 18, className }: BrandMarkProps) {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 512 512"
      aria-hidden="true"
    >
      <defs>
        <linearGradient id="qf-brand-bg" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#181d24" />
          <stop offset="1" stopColor="#0d1013" />
        </linearGradient>
        <linearGradient id="qf-brand-arc" x1="0" y1="1" x2="1" y2="0">
          <stop offset="0" stopColor="#4ade80" />
          <stop offset="0.55" stopColor="#2dd4bf" />
          <stop offset="1" stopColor="#22d3ee" />
        </linearGradient>
      </defs>
      <rect
        x="24"
        y="24"
        width="464"
        height="464"
        rx="112"
        fill="url(#qf-brand-bg)"
        stroke="#ffffff18"
        strokeWidth="3"
      />
      <path
        d="M127.8 354 A148 148 0 1 0 384.2 354"
        fill="none"
        stroke="url(#qf-brand-arc)"
        strokeWidth="46"
        strokeLinecap="round"
      />
      <circle cx="182" cy="151.8" r="16" fill="#ffffff" />
      <circle cx="256" cy="132" r="16" fill="#ffffff" />
      <circle cx="330" cy="151.8" r="16" fill="#ffffff" />
      <path d="M224 208 L224 352 L320 280 Z" fill="#ffffff" />
    </svg>
  )
}
