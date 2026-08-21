"use client";

import type { TrendPoint } from "@/lib/api/dashboard";

const DAY_OPTIONS = [7, 30, 90];

/** 过去 days 天（含今天）的 YYYY-MM-DD 序列，用于补零对齐。 */
function dateSequence(days: number): string[] {
  const out: string[] = [];
  const now = new Date();
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const dd = String(d.getDate()).padStart(2, "0");
    out.push(`${d.getFullYear()}-${mm}-${dd}`);
  }
  return out;
}

/** 上取整到整齐的 y 轴上限。 */
function niceMax(v: number): number {
  if (v <= 4) return 4;
  const magnitude = 10 ** Math.floor(Math.log10(v));
  const norm = v / magnitude;
  const step = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10;
  return step * magnitude;
}

function shortLabel(date: string): string {
  const parts = date.split("-");
  return `${parts[1]}-${parts[2]}`;
}

export function TrendChart({
  trends,
  days,
  onDaysChange,
  loading
}: {
  trends: TrendPoint[];
  days: number;
  onDaysChange: (d: number) => void;
  loading: boolean;
}) {
  const seq = dateSequence(days);
  const byDate = new Map(trends.map((t) => [t.date, t]));
  const rows = seq.map((date) => ({
    date,
    success: byDate.get(date)?.success ?? 0,
    failed: byDate.get(date)?.failed ?? 0
  }));

  const rawMax = Math.max(1, ...rows.map((r) => Math.max(r.success, r.failed)));
  const maxY = niceMax(rawMax);

  const W = 600;
  const H = 200;
  const plotL = 44;
  const plotR = 584;
  const plotT = 20;
  const plotB = 168;
  const x = (i: number) => (days <= 1 ? plotL : plotL + (i * (plotR - plotL)) / (days - 1));
  const y = (v: number) => plotB - (v / maxY) * (plotB - plotT);

  const successPts = rows.map((r, i) => `${x(i)},${y(r.success)}`).join(" ");
  const failedPts = rows.map((r, i) => `${x(i)},${y(r.failed)}`).join(" ");

  const ticks = [0, 1, 2, 3, 4].map((i) => Math.round((maxY * i) / 4));
  const xStep = days <= 7 ? 1 : days <= 30 ? 5 : 15;

  return (
    <div className="card">
      <div className="card-header">
        <div>
          <div className="card-title">调用量趋势</div>
          <div className="card-subtitle">近 {days} 天成功 / 失败调用量</div>
        </div>
        <div className="tabs" style={{ borderBottom: "none", marginBottom: 0 }}>
          {DAY_OPTIONS.map((d) => (
            <button
              key={d}
              type="button"
              className={`tab-item${days === d ? " active" : ""}`}
              style={{ padding: "4px 12px", fontSize: 12 }}
              onClick={() => onDaysChange(d)}
            >
              {d}天
            </button>
          ))}
        </div>
      </div>
      <div className="card-body">
        {loading ? (
          <div className="empty-state">加载中...</div>
        ) : (
          <>
            <svg className="svg-chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="调用量趋势图">
              {[0, 1, 2, 3, 4].map((i) => {
                const yy = plotT + (i * (plotB - plotT)) / 4;
                return (
                  <g key={i}>
                    <line x1={plotL} y1={yy} x2={plotR} y2={yy} stroke="#E9EEF6" strokeWidth="1" />
                    <text x={10} y={yy + 3} fontSize="10" fill="#94A3B8" fontFamily="monospace">
                      {ticks[i]}
                    </text>
                  </g>
                );
              })}

              {rows.map((r, i) =>
                i % xStep === 0 || i === rows.length - 1 ? (
                  <text key={r.date} x={x(i)} y={plotB + 16} fontSize="10" fill="#94A3B8" textAnchor="middle">
                    {shortLabel(r.date)}
                  </text>
                ) : null
              )}

              <polyline points={failedPts} fill="none" stroke="#3B82F6" strokeWidth="2" strokeDasharray="6,4" strokeLinecap="round" />
              <polyline points={successPts} fill="none" stroke="#1E40AF" strokeWidth="2.5" strokeLinecap="round" />
            </svg>

            <div style={{ display: "flex", gap: 20, marginTop: 12, fontSize: 12, color: "#64748B" }}>
              <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <span style={{ width: 12, height: 3, background: "#1E40AF", borderRadius: 2, display: "inline-block" }} />
                成功调用
              </span>
              <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <span style={{ width: 12, height: 0, borderTop: "2px dashed #3B82F6", display: "inline-block" }} />
                失败调用
              </span>
            </div>
          </>
        )}
      </div>
    </div>
  );
}