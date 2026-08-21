"use client";

import { useEffect, useState } from "react";
import type { AlertType, DashboardAlert } from "@/lib/api/dashboard";
import { ALERT_TYPE_LABELS, getAlertRules, upsertAlertRule } from "@/lib/api/dashboard";
import { formatDateTime } from "@/lib/utils/format";

const RULE_DEFS: Array<{ type: AlertType; label: string; unit: string; fallback: string }> = [
  { type: "failure_rate", label: "失败率阈值", unit: "%", fallback: "30" },
  { type: "cost_deviation", label: "消耗偏离阈值", unit: "%", fallback: "20" },
  { type: "cron_delay", label: "cron 检测窗口", unit: "小时", fallback: "24" }
];

function alertDetail(a: DashboardAlert): string {
  switch (a.type) {
    case "failure_rate":
      return `近 1 小时失败率 ${a.value}%，超过阈值 ${a.threshold}%`;
    case "cost_deviation":
      return `实际扣减与消耗表偏差 ${a.value}%，超过阈值 ${a.threshold}%`;
    case "cron_delay":
      return `cron 任务异常（${a.value} 次失败运行）`;
    default:
      return "";
  }
}

function WarningIcon() {
  return (
    <svg className="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
      <line x1="12" y1="9" x2="12" y2="13" />
      <line x1="12" y1="17" x2="12.01" y2="17" />
    </svg>
  );
}

function InfoIcon() {
  return (
    <svg className="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10" />
      <line x1="12" y1="16" x2="12" y2="12" />
      <line x1="12" y1="8" x2="12.01" y2="8" />
    </svg>
  );
}

export function AlertList({
  alerts,
  loading,
  onRulesSaved
}: {
  alerts: DashboardAlert[];
  loading: boolean;
  onRulesSaved: () => void;
}) {
  const [modalOpen, setModalOpen] = useState(false);

  return (
    <div className="card">
      <div className="card-header">
        <div>
          <div className="card-title">活跃告警</div>
          <div className="card-subtitle">需要处理的系统事件</div>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          {!loading && alerts.length > 0 ? <span className="badge badge-danger">{alerts.length} 条</span> : null}
          <button className="btn btn-secondary btn-sm" type="button" onClick={() => setModalOpen(true)}>
            阈值设置
          </button>
        </div>
      </div>
      <div className="card-body" style={{ paddingTop: "var(--space-3)" }}>
        {loading ? (
          <div className="empty-state">加载中...</div>
        ) : alerts.length === 0 ? (
          <div className="empty-state">当前无活跃告警</div>
        ) : (
          <ul className="alert-list">
            {alerts.map((a, i) => (
              <li className="alert-list-item" key={`${a.type}-${a.provider_id ?? "global"}-${i}`}>
                <div className={`alert-list-icon ${a.level}`}>{a.level === "info" ? <InfoIcon /> : <WarningIcon />}</div>
                <div className="alert-list-content">
                  <div className="alert-list-title">
                    {a.provider_name ? `${a.provider_name} · ` : ""}
                    {ALERT_TYPE_LABELS[a.type]}
                  </div>
                  <div className="alert-list-desc">{alertDetail(a)}</div>
                </div>
                <span className="alert-list-time">{formatDateTime(a.created_at)}</span>
              </li>
            ))}
          </ul>
        )}
      </div>

      {modalOpen ? (
        <RulesModal
          onClose={() => setModalOpen(false)}
          onSaved={() => {
            setModalOpen(false);
            onRulesSaved();
          }}
        />
      ) : null}
    </div>
  );
}

function RulesModal({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [values, setValues] = useState<Record<AlertType, string>>({
    failure_rate: "30",
    cost_deviation: "20",
    cron_delay: "24"
  });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    getAlertRules()
      .then((rules) => {
        if (cancelled) return;
        const next = { ...values };
        for (const def of RULE_DEFS) {
          const global = rules.find((r) => r.alert_type === def.type && r.provider_id === null);
          if (global) next[def.type] = String(global.threshold);
        }
        setValues(next);
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : "加载阈值失败");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleSave() {
    setSaving(true);
    setError(null);
    try {
      for (const def of RULE_DEFS) {
        const n = Number(values[def.type]);
        if (!Number.isFinite(n) || n < 0) {
          throw new Error(`${def.label}必须是大于等于 0 的数字`);
        }
        await upsertAlertRule({ alert_type: def.type, provider_id: null, threshold: n, enabled: true });
      }
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : "保存失败");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="modal-overlay show" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <div className="modal-title">告警阈值设置</div>
          <button className="modal-close" onClick={onClose} aria-label="关闭">
            <svg className="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        <div className="modal-body">
          {loading ? (
            <div className="empty-state">加载中...</div>
          ) : (
            RULE_DEFS.map((def) => (
              <div className="form-group" key={def.type} style={{ marginBottom: 16 }}>
                <label className="form-label">{def.label}</label>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <input
                    type="number"
                    min={0}
                    style={{ width: 160 }}
                    value={values[def.type]}
                    onChange={(e) => setValues((prev) => ({ ...prev, [def.type]: e.target.value }))}
                  />
                  <span style={{ fontSize: 13, color: "#64748B" }}>{def.unit}</span>
                </div>
              </div>
            ))
          )}
          {error ? <div style={{ fontSize: 13, color: "var(--color-destructive)" }}>{error}</div> : null}
        </div>

        <div className="modal-footer">
          <button className="btn btn-secondary" onClick={onClose}>
            取消
          </button>
          <button className="btn btn-primary" disabled={saving || loading} onClick={() => void handleSave()}>
            {saving ? "保存中..." : "保存"}
          </button>
        </div>
      </div>
    </div>
  );
}