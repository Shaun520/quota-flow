import { createAdminBrowserClient } from "@/lib/supabase/client";
import { formatDate } from "@/lib/utils/format";

export type UserStatus = "active" | "banned" | "exhausted";
export type TeamRole = "admin" | "member";
export type RoleFilter = "" | TeamRole | "none";
export type StatusFilter = "" | UserStatus;

export interface AdminUser {
  id: string;
  email: string | null;
  display_name: string | null;
  avatar_url: string | null;
  is_admin: boolean;
  status: UserStatus;
  created_at: string;
  team_name: string | null;
  team_role: TeamRole | null;
  month_usage: number;
  total_usage: number;
}

export interface UserListResult {
  total: number;
  items: AdminUser[];
}

export interface UserListParams {
  search?: string;
  role?: RoleFilter;
  status?: StatusFilter;
  page?: number;
  pageSize?: number;
}

export interface RecentJob {
  id: string;
  status: string;
  provider_id: string | null;
  mode: string;
  cost_unit: string | null;
  cost_amount: number | null;
  equivalent_count: number | null;
  created_at: string;
}

export async function listUsers(params: UserListParams = {}): Promise<UserListResult> {
  const supabase = createAdminBrowserClient();
  const page = params.page ?? 1;
  const pageSize = params.pageSize ?? 20;

  const { data, error } = await supabase.rpc("admin_list_users", {
    p_search: params.search?.trim() || null,
    p_role: params.role || null,
    p_status: params.status || null,
    p_limit: pageSize,
    p_offset: (page - 1) * pageSize
  });
  if (error) throw error;

  const raw = (data ?? { total: 0, items: [] }) as { total: number; items: unknown[] };
  return {
    total: Number(raw.total ?? 0),
    items: (raw.items ?? []).map((it) => normalizeUser(it as Record<string, unknown>))
  };
}

export async function setUserStatus(userId: string, status: UserStatus): Promise<void> {
  const supabase = createAdminBrowserClient();

  const { error } = await supabase
    .from("profiles")
    .update({ status, updated_at: new Date().toISOString() })
    .eq("id", userId);
  if (error) throw error;

  // 写审计日志（失败不阻断主操作，仅静默忽略）
  const { data: authData } = await supabase.auth.getUser();
  const adminUserId = authData.user?.id;
  if (adminUserId) {
    await supabase.from("audit_logs").insert({
      admin_user_id: adminUserId,
      user_id: userId,
      action: status === "banned" ? "user.ban" : "user.unban",
      target: userId,
      metadata: {}
    });
  }
}

export async function listRecentJobs(userId: string, limit = 10): Promise<RecentJob[]> {
  const supabase = createAdminBrowserClient();
  const { data, error } = await supabase
    .from("jobs")
    .select("id, status, provider_id, mode, cost_unit, cost_amount, equivalent_count, created_at")
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw error;
  return (data ?? []) as RecentJob[];
}

/** 用户状态 → 中文标签。 */
export function statusLabel(status: UserStatus): string {
  if (status === "banned") return "已封禁";
  if (status === "exhausted") return "额度耗尽";
  return "正常";
}

/** 团队角色 → 中文标签；无团队返回「—」。 */
export function roleLabel(role: TeamRole | null): string {
  if (role === "admin") return "Admin";
  if (role === "member") return "Member";
  return "—";
}

export function toCsv(users: AdminUser[]): string {
  const header = ["邮箱", "姓名", "所属团队", "角色", "注册时间", "本月消费", "累计消费", "状态"];
  const rows = users.map((u) => [
    u.email ?? "",
    u.display_name ?? "",
    u.team_name ?? "个人",
    u.team_role === "admin" ? "Admin" : u.team_role === "member" ? "Member" : "—",
    formatDate(u.created_at),
    String(u.month_usage),
    String(u.total_usage),
    statusLabel(u.status)
  ]);
  const csv = [header, ...rows]
    .map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(","))
    .join("\n");
  return "﻿" + csv; // BOM，便于 Excel 正确识别 UTF-8
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

function normalizeUser(it: Record<string, unknown>): AdminUser {
  return {
    id: String(it.id ?? ""),
    email: (it.email as string) ?? null,
    display_name: (it.display_name as string) ?? null,
    avatar_url: (it.avatar_url as string) ?? null,
    is_admin: Boolean(it.is_admin),
    status: (it.status as UserStatus) ?? "active",
    created_at: String(it.created_at ?? ""),
    team_name: (it.team_name as string) ?? null,
    team_role: (it.team_role as TeamRole) ?? null,
    month_usage: Number(it.month_usage ?? 0),
    total_usage: Number(it.total_usage ?? 0)
  };
}
