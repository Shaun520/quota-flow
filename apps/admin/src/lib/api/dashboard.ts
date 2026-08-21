import { createAdminBrowserClient } from "@/lib/supabase/client";
import { insertAuditLog } from "@/lib/utils/audit";

/* ============ 类型定义 ============ */

export interface DashboardKpis {
  active_teams: number;
  registered_users: number;
  today_calls: number;
  avg_response_ms: number | null;
}

export interface SupabaseUsage {
  db_size_bytes: number | null;
  mau: number;
  storage_bytes: number | null;
}

export interface TrendPoint {
  date: string;
  success: number;
  failed: number;
}

export interface ProviderHealth {
  provider_id: string;
  name: string;
  total: number;
  success: number;
  failed: number;
  success_rate: number | null;
}

export type AlertType = "failure_rate" | "cost_deviation" | "cron_delay";

export interface DashboardAlert {
  type: AlertType;
  provider_id: string | null;
  provider_name: string | null;
  level: "danger" | "warning" | "info";
  value: number;
  threshold: number;
  created_at: string;
}

export interface AlertRule {
  id: string;
  alert_type: AlertType;
  provider_id: string | null;
  threshold: number;
  enabled: boolean;
}

/* ============ RPC 调用 ============ */

export async function getDashboardKpis(): Promise<DashboardKpis> {
  const supabase = createAdminBrowserClient();
  const { data, error } = await supabase.rpc("admin_dashboard_kpis");
  if (error) throw error;
  const raw = (data ?? {}) as Record<string, unknown>;
  return {
    active_teams: Number(raw.active_teams ?? 0),
    registered_users: Number(raw.registered_users ?? 0),
    today_calls: Number(raw.today_calls ?? 0),
    avg_response_ms: raw.avg_response_ms == null ? null : Number(raw.avg_response_ms)
  };
}

export async function getDashboardTrends(days: number): Promise<TrendPoint[]> {
  const supabase = createAdminBrowserClient();
  const { data, error } = await supabase.rpc("admin_dashboard_trends", { p_days: days });
  if (error) throw error;
  return (data ?? []).map((it: Record<string, unknown>) => ({
    date: String(it.date ?? ""),
    success: Number(it.success ?? 0),
    failed: Number(it.failed ?? 0)
  }));
}

export async function getSupabaseUsage(): Promise<SupabaseUsage> {
  const supabase = createAdminBrowserClient();
  const { data, error } = await supabase.rpc("admin_dashboard_supabase_usage");
  if (error) throw error;
  const raw = (data ?? {}) as Record<string, unknown>;
  return {
    db_size_bytes: raw.db_size_bytes == null ? null : Number(raw.db_size_bytes),
    mau: Number(raw.mau ?? 0),
    storage_bytes: raw.storage_bytes == null ? null : Number(raw.storage_bytes)
  };
}

export async function getProviderHealth(hours = 24): Promise<ProviderHealth[]> {
  const supabase = createAdminBrowserClient();
  const { data, error } = await supabase.rpc("admin_dashboard_provider_health", { p_hours: hours });
  if (error) throw error;
  return (data ?? []).map((it: Record<string, unknown>) => ({
    provider_id: String(it.provider_id ?? ""),
    name: String(it.name ?? ""),
    total: Number(it.total ?? 0),
    success: Number(it.success ?? 0),
    failed: Number(it.failed ?? 0),
    success_rate: it.success_rate == null ? null : Number(it.success_rate)
  }));
}

export async function getDashboardAlerts(): Promise<DashboardAlert[]> {
  const supabase = createAdminBrowserClient();
  const { data, error } = await supabase.rpc("admin_dashboard_alerts");
  if (error) throw error;
  return (data ?? []).map((it: Record<string, unknown>) => ({
    type: (it.type as AlertType) ?? "failure_rate",
    provider_id: (it.provider_id as string) ?? null,
    provider_name: (it.provider_name as string) ?? null,
    level: (it.level as DashboardAlert["level"]) ?? "info",
    value: Number(it.value ?? 0),
    threshold: Number(it.threshold ?? 0),
    created_at: String(it.created_at ?? "")
  }));
}

export async function getAlertRules(): Promise<AlertRule[]> {
  const supabase = createAdminBrowserClient();
  const { data, error } = await supabase.rpc("admin_get_alert_rules");
  if (error) throw error;
  return (data ?? []).map((it: Record<string, unknown>) => ({
    id: String(it.id ?? ""),
    alert_type: (it.alert_type as AlertType) ?? "failure_rate",
    provider_id: (it.provider_id as string) ?? null,
    threshold: Number(it.threshold ?? 0),
    enabled: Boolean(it.enabled)
  }));
}

export async function upsertAlertRule(input: {
  alert_type: AlertType;
  provider_id: string | null;
  threshold: number;
  enabled: boolean;
}): Promise<void> {
  const supabase = createAdminBrowserClient();
  const { error } = await supabase.rpc("admin_upsert_alert_rule", {
    p_alert_type: input.alert_type,
    p_provider_id: input.provider_id,
    p_threshold: input.threshold,
    p_enabled: input.enabled
  });
  if (error) throw error;

  await insertAuditLog("monitor.alert_rule", {
    metadata: {
      alert_type: input.alert_type,
      provider_id: input.provider_id,
      threshold: input.threshold,
      enabled: input.enabled
    }
  });
}

/* ============ 展示辅助 ============ */

export const ALERT_TYPE_LABELS: Record<AlertType, string> = {
  failure_rate: "失败率告警",
  cost_deviation: "消耗偏离告警",
  cron_delay: "cron 任务告警"
};

/** 成功率 → 健康等级（展示阈值，非告警阈值）。 */
export function healthLevel(rate: number | null): {
  dot: "green" | "yellow" | "red" | "gray";
  label: string;
  badge: "success" | "warning" | "danger" | "muted";
} {
  if (rate == null) return { dot: "gray", label: "无数据", badge: "muted" };
  if (rate >= 90) return { dot: "green", label: "健康", badge: "success" };
  if (rate >= 80) return { dot: "yellow", label: "需关注", badge: "warning" };
  return { dot: "red", label: "异常", badge: "danger" };
}