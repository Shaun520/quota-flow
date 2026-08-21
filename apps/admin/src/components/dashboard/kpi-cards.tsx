"use client";

import type { DashboardKpis } from "@/lib/api/dashboard";

function formatInt(n: number | null | undefined): string {
  if (n == null) return "—";
  return Math.round(n).toLocaleString("zh-CN");
}

function formatSeconds(ms: number | null | undefined): string {
  if (ms == null) return "—";
  return (ms / 1000).toFixed(1);
}

export function KpiCards({ kpis, loading }: { kpis: DashboardKpis | null; loading: boolean }) {
  const items = [
    {
      label: "活跃团队",
      value: loading || !kpis ? "—" : formatInt(kpis.active_teams),
      unit: "个",
      icon: (
        <svg className="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
          <circle cx="9" cy="7" r="4" />
          <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
          <path d="M16 3.13a4 4 0 0 1 0 7.75" />
        </svg>
      )
    },
    {
      label: "注册用户",
      value: loading || !kpis ? "—" : formatInt(kpis.registered_users),
      unit: "人",
      icon: (
        <svg className="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
          <circle cx="12" cy="7" r="4" />
        </svg>
      )
    },
    {
      label: "今日调用量",
      value: loading || !kpis ? "—" : formatInt(kpis.today_calls),
      unit: "次",
      icon: (
        <svg className="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M22 12h-4l-3 9L9 3l-3 9H2" />
        </svg>
      )
    },
    {
      label: "平均响应时长",
      value: loading || !kpis ? "—" : formatSeconds(kpis.avg_response_ms),
      unit: "s",
      icon: (
        <svg className="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="10" />
          <path d="M12 6v6l4 2" />
        </svg>
      )
    }
  ];

  return (
    <div className="kpi-grid">
      {items.map((item) => (
        <div className="kpi-card" key={item.label}>
          <div className="kpi-label">
            {item.icon}
            {item.label}
          </div>
          <div className="kpi-value">
            {item.value}
            <span className="unit">{item.unit}</span>
          </div>
        </div>
      ))}
    </div>
  );
}