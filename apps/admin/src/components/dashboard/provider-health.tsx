"use client";

import type { ProviderHealth } from "@/lib/api/dashboard";
import { healthLevel } from "@/lib/api/dashboard";

export function ProviderHealthCard({
  items,
  loading
}: {
  items: ProviderHealth[];
  loading: boolean;
}) {
  return (
    <div className="card">
      <div className="card-header">
        <div>
          <div className="card-title">厂商健康状态</div>
          <div className="card-subtitle">近 24 小时成功率与状态</div>
        </div>
      </div>
      <div className="card-body" style={{ paddingTop: "var(--space-3)" }}>
        {loading ? (
          <div className="empty-state">加载中...</div>
        ) : items.length === 0 ? (
          <div className="empty-state">暂无调用数据</div>
        ) : (
          <ul className="provider-health-list">
            {items.map((p) => {
              const lvl = healthLevel(p.success_rate);
              return (
                <li className="provider-health-item" key={p.provider_id}>
                  <span className={`health-dot ${lvl.dot}`} />
                  <span className="provider-health-name">{p.name}</span>
                  <span className="provider-health-rate">
                    {p.success_rate == null ? "—" : `${p.success_rate.toFixed(1)}%`}
                  </span>
                  <span className={`badge badge-${lvl.badge}`}>
                    <span className="badge-dot" />
                    {lvl.label}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}