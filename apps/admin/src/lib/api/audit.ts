import { createAdminBrowserClient } from "@/lib/supabase/client";
import { formatDateTime } from "@/lib/utils/format";

export type AuditLogActionCategory = "" | "team" | "user" | "provider" | "announcement" | "quota";
export type AuditLogTimeRange = "24h" | "7d" | "30d" | "all";

export interface AuditLog {
  id: string;
  admin_user_id: string;
  admin_name: string | null;
  admin_email: string | null;
  team_id: string | null;
  team_name: string | null;
  user_id: string | null;
  user_name: string | null;
  user_email: string | null;
  action: string;
  target: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
}

export interface AuditLogListParams {
  action?: AuditLogActionCategory;
  teamId?: string;
  userId?: string;
  timeRange?: AuditLogTimeRange;
  search?: string;
  page?: number;
  pageSize?: number;
}

export interface AuditLogListResult {
  total: number;
  items: AuditLog[];
}

export interface ActionGroup {
  value: AuditLogActionCategory;
  label: string;
  actions: { value: string; label: string }[];
}

/** action → 中文标签。 */
export function actionLabel(action: string): string {
  const map: Record<string, string> = {
    "team.update": "团队更新",
    "team.ban": "团队封禁",
    "team.unban": "团队解封",
    "user.ban": "用户封禁",
    "user.unban": "用户解封",
    "provider.create": "创建 Provider",
    "provider.update": "更新 Provider",
    "provider.delete": "删除 Provider",
    "provider.toggle_enabled": "启用/停用 Provider",
    "announcement.create": "创建公告",
    "announcement.update": "更新公告",
    "announcement.delete": "删除公告",
    "announcement.publish": "发布公告",
    "announcement.unpublish": "下架公告",
    "quota.reset": "重置额度",
    "key.bind": "绑定账号",
    "key.unbind": "解绑账号",
    "sub.update": "订阅变更",
    "cost.update": "消耗表更新"
  };
  return map[action] ?? action;
}

/** 按资源类型分组的 action 白名单，供筛选下拉使用。 */
export const AUDIT_ACTION_GROUPS: ActionGroup[] = [
  {
    value: "team",
    label: "团队",
    actions: [
      { value: "team.update", label: "团队更新" },
      { value: "team.ban", label: "团队封禁" },
      { value: "team.unban", label: "团队解封" }
    ]
  },
  {
    value: "user",
    label: "用户",
    actions: [
      { value: "user.ban", label: "用户封禁" },
      { value: "user.unban", label: "用户解封" }
    ]
  },
  {
    value: "provider",
    label: "Provider",
    actions: [
      { value: "provider.create", label: "创建 Provider" },
      { value: "provider.update", label: "更新 Provider" },
      { value: "provider.delete", label: "删除 Provider" },
      { value: "provider.toggle_enabled", label: "启用/停用 Provider" }
    ]
  },
  {
    value: "announcement",
    label: "公告",
    actions: [
      { value: "announcement.create", label: "创建公告" },
      { value: "announcement.update", label: "更新公告" },
      { value: "announcement.delete", label: "删除公告" },
      { value: "announcement.publish", label: "发布公告" },
      { value: "announcement.unpublish", label: "下架公告" }
    ]
  },
  {
    value: "quota",
    label: "额度",
    actions: [
      { value: "quota.reset", label: "重置额度" }
    ]
  }
];

/** 全部 action 条目（平铺），用于按具体 action 筛选。 */
export const AUDIT_ACTIONS = AUDIT_ACTION_GROUPS.flatMap((g) => g.actions);

function timeRangeToDates(range: AuditLogTimeRange): { from: Date | null; to: Date | null } {
  const now = new Date();
  switch (range) {
    case "24h":
      return { from: new Date(now.getTime() - 24 * 60 * 60 * 1000), to: null };
    case "7d":
      return { from: new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000), to: null };
    case "30d":
      return { from: new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000), to: null };
    default:
      return { from: null, to: null };
  }
}

export async function listAuditLogs(params: AuditLogListParams = {}): Promise<AuditLogListResult> {
  const supabase = createAdminBrowserClient();
  const page = params.page ?? 1;
  const pageSize = params.pageSize ?? 20;
  const { from, to } = timeRangeToDates(params.timeRange ?? "all");

  const { data, error } = await supabase.rpc("admin_list_audit_logs", {
    p_action: params.action || null,
    p_team_id: params.teamId || null,
    p_user_id: params.userId || null,
    p_from: from?.toISOString() || null,
    p_to: to?.toISOString() || null,
    p_search: params.search?.trim() || null,
    p_limit: pageSize,
    p_offset: (page - 1) * pageSize
  });
  if (error) throw error;

  const raw = (data ?? { total: 0, items: [] }) as { total: number; items: unknown[] };
  return {
    total: Number(raw.total ?? 0),
    items: (raw.items ?? []).map((it) => normalizeAuditLog(it as Record<string, unknown>))
  };
}

export function toCsv(logs: AuditLog[]): string {
  const header = ["时间", "操作", "操作人", "操作人邮箱", "团队", "用户", "用户邮箱", "对象", "详情"];
  const rows = logs.map((log) => [
    formatDateTime(log.created_at),
    actionLabel(log.action),
    log.admin_name ?? log.admin_email ?? "—",
    log.admin_email ?? "—",
    log.team_name ?? "—",
    log.user_name ?? log.user_email ?? "—",
    log.user_email ?? "—",
    log.target ?? "—",
    metadataSummary(log.metadata)
  ]);
  const csv = [header, ...rows]
    .map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(","))
    .join("\n");
  return "\ufeff" + csv;
}

export function downloadCsv(filename: string, csv: string): void {
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

/** metadata 摘要：取前 3 个非内部字段，以 key=value 形式展示。 */
export function metadataSummary(metadata: Record<string, unknown> | null | undefined): string {
  if (!metadata || typeof metadata !== "object") return "—";
  const entries = Object.entries(metadata)
    .filter(([key]) => key !== "id" && key !== "created_at" && key !== "updated_at")
    .slice(0, 3)
    .map(([key, value]) => `${key}=${String(value ?? "")}`);
  return entries.length ? entries.join(", ") : "—";
}

function normalizeAuditLog(it: Record<string, unknown>): AuditLog {
  return {
    id: String(it.id ?? ""),
    admin_user_id: String(it.admin_user_id ?? ""),
    admin_name: (it.admin_name as string) ?? null,
    admin_email: (it.admin_email as string) ?? null,
    team_id: (it.team_id as string) ?? null,
    team_name: (it.team_name as string) ?? null,
    user_id: (it.user_id as string) ?? null,
    user_name: (it.user_name as string) ?? null,
    user_email: (it.user_email as string) ?? null,
    action: String(it.action ?? ""),
    target: (it.target as string) ?? null,
    metadata: (it.metadata as Record<string, unknown>) ?? {},
    created_at: String(it.created_at ?? "")
  };
}
