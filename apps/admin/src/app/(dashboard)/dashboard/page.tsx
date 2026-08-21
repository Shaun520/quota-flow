"use client";

import { useCallback, useEffect, useState } from "react";
import type { DashboardAlert, DashboardKpis, ProviderHealth, SupabaseUsage, TrendPoint } from "@/lib/api/dashboard";
import {
  ALERT_TYPE_LABELS,
  getDashboardAlerts,
  getDashboardKpis,
  getDashboardTrends,
  getProviderHealth,
  getSupabaseUsage
} from "@/lib/api/dashboard";
import { downloadCsv } from "@/lib/api/audit";
import { KpiCards } from "@/components/dashboard/kpi-cards";
import { TrendChart } from "@/components/dashboard/trend-chart";
import { ProviderHealthCard } from "@/components/dashboard/provider-health";
import { SupabaseUsageCard } from "@/components/dashboard/supabase-usage";
import { AlertList } from "@/components/dashboard/alert-list";

export default function DashboardPage() {
  const [days, setDays] = useState(7);

  const [kpis, setKpis] = useState<DashboardKpis | null>(null);
  const [health, setHealth] = useState<ProviderHealth[]>([]);
  const [usage, setUsage] = useState<SupabaseUsage | null>(null);
  const [alerts, setAlerts] = useState<DashboardAlert[]>([]);
  const [trends, setTrends] = useState<TrendPoint[]>([]);

  const [overviewLoading, setOverviewLoading] = useState(true);
  const [trendsLoading, setTrendsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const loadOverview = useCallback(async () => {
    setOverviewLoading(true);
    setError(null);
    try {
      const [k, h, u, a] = await Promise.all([
        getDashboardKpis(),
        getProviderHealth(24),
        getSupabaseUsage(),
        getDashboardAlerts()
      ]);
      setKpis(k);
      setHealth(h);
      setUsage(u);
      setAlerts(a);
    } catch (e) {
      setError(e instanceof Error ? e.message : "加载失败");
    } finally {
      setOverviewLoading(false);
    }
  }, []);

  const loadTrends = useCallback(async (d: number) => {
    setTrendsLoading(true);
    try {
      setTrends(await getDashboardTrends(d));
    } catch (e) {
      setError(e instanceof Error ? e.message : "加载趋势失败");
    } finally {
      setTrendsLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadOverview();
  }, [loadOverview]);

  useEffect(() => {
    void loadTrends(days);
  }, [days, loadTrends]);

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), 3000);
    return () => clearTimeout(timer);
  }, [toast]);

  function handleRefresh() {
    void loadOverview();
    void loadTrends(days);
  }

  function handleExport() {
    const lines: string[][] = [];
    lines.push(["系统监控报告"]);
    lines.push([]);
    lines.push(["指标", "值"]);
    lines.push(["活跃团队", kpis ? String(kpis.active_teams) : ""]);
    lines.push(["注册用户", kpis ? String(kpis.registered_users) : ""]);
    lines.push(["今日调用量", kpis ? String(kpis.today_calls) : ""]);
    lines.push([
      "平均响应时长(s)",
      kpis && kpis.avg_response_ms != null ? (kpis.avg_response_ms / 1000).toFixed(1) : ""
    ]);
    lines.push([]);
    lines.push(["告警类型", "对象", "值", "阈值"]);
    for (const a of alerts) {
      lines.push([ALERT_TYPE_LABELS[a.type], a.provider_name ?? "全局", String(a.value), String(a.threshold)]);
    }

    const csv = lines
      .map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(","))
      .join("\n");
    downloadCsv("dashboard-report.csv", "\ufeff" + csv);
  }

  return (
    <div>
      <div className="page-header">
        <div>
          <h1 className="page-title">系统监控</h1>
          <p className="page-subtitle">实时监控官方托管实例的运行状态与用量</p>
        </div>
        <div className="page-actions">
          <button
            className="btn btn-secondary btn-sm"
            type="button"
            disabled={overviewLoading || trendsLoading}
            onClick={handleRefresh}
          >
            {overviewLoading || trendsLoading ? "刷新中..." : "刷新数据"}
          </button>
          <button className="btn btn-primary btn-sm" type="button" onClick={handleExport}>
            导出报告
          </button>
        </div>
      </div>

      {error ? (
        <div className="alert alert-warning">
          <div>{error}</div>
        </div>
      ) : null}

      <KpiCards kpis={kpis} loading={overviewLoading} />

      <div className="dashboard-chart-grid">
        <TrendChart trends={trends} days={days} onDaysChange={setDays} loading={trendsLoading} />
        <ProviderHealthCard items={health} loading={overviewLoading} />
      </div>

      <div className="grid-2">
        <SupabaseUsageCard usage={usage} loading={overviewLoading} />
        <AlertList
          alerts={alerts}
          loading={overviewLoading}
          onRulesSaved={() => {
            setToast("告警阈值已保存");
            void loadOverview();
          }}
        />
      </div>

      {toast ? (
        <div className="toast-container">
          <div className="toast toast-info">
            <div className="toast-content">
              <div className="toast-message">{toast}</div>
            </div>
            <button className="toast-close" onClick={() => setToast(null)} aria-label="关闭">
              <svg className="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}