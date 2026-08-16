import { createAdminBrowserClient } from "@/lib/supabase/client";

export type TeamStatus = "active" | "banned" | "exhausted" | "expired";
export type TeamStatusFilter = "" | TeamStatus;
export type TeamRole = "admin" | "member";

export interface AdminTeamSubscription {
  plan: string | null;
  status: string | null;
  seats: number | null;
  current_period_start: string | null;
  current_period_end: string | null;
}

export interface AdminTeamQuota {
  provider_id: string;
  daily_total: number;
  used: number;
  remaining: number;
  reserved: number;
}

export interface AdminTeam {
  id: string;
  name: string;
  owner_id: string;
  owner_email: string | null;
  owner_name: string | null;
  owner_status: string | null;
  plan: string;
  seats_limit: number;
  status: TeamStatus;
  created_at: string;
  member_count: number;
  active_member_count: number;
  subscription: AdminTeamSubscription | null;
  quota: AdminTeamQuota | null;
  month_usage: number;
  total_usage: number;
  key_count: number;
}

export interface AdminTeamMember {
  team_id: string;
  user_id: string;
  email: string | null;
  display_name: string | null;
  status: string | null;
  role: TeamRole;
  daily_quota_limit_equivalent: number | null;
  joined_at: string;
  today_usage: number;
  month_usage: number;
  total_usage: number;
}

export interface TeamListResult {
  total: number;
  items: AdminTeam[];
}

export interface TeamListParams {
  search?: string;
  status?: TeamStatusFilter;
  page?: number;
  pageSize?: number;
}

export interface TeamSettingsInput {
  plan?: string;
  seats_limit?: number;
  status?: TeamStatus;
}

export interface TeamOption {
  id: string;
  name: string;
}

export async function listTeams(params: TeamListParams = {}): Promise<TeamListResult> {
  const supabase = createAdminBrowserClient();
  const page = params.page ?? 1;
  const pageSize = params.pageSize ?? 20;

  const { data, error } = await supabase.rpc("admin_list_teams", {
    p_search: params.search?.trim() || null,
    p_status: params.status || null,
    p_limit: pageSize,
    p_offset: (page - 1) * pageSize
  });
  if (error) throw error;

  const raw = (data ?? { total: 0, items: [] }) as { total: number; items: unknown[] };
  return {
    total: Number(raw.total ?? 0),
    items: (raw.items ?? []).map((it) => normalizeTeam(it as Record<string, unknown>))
  };
}

export async function listTeamOptions(): Promise<TeamOption[]> {
  const supabase = createAdminBrowserClient();
  const { data, error } = await supabase
    .from("teams")
    .select("id, name")
    .order("name");
  if (error) throw error;
  return (data ?? []) as TeamOption[];
}

export async function listTeamMembers(teamId: string): Promise<AdminTeamMember[]> {
  const supabase = createAdminBrowserClient();
  const { data, error } = await supabase.rpc("admin_list_team_members", {
    p_team_id: teamId
  });
  if (error) throw error;

  const raw = (data ?? { items: [] }) as { items: unknown[] };
  return (raw.items ?? []).map((it) => normalizeTeamMember(it as Record<string, unknown>));
}

export async function updateTeamSettings(teamId: string, input: TeamSettingsInput): Promise<void> {
  const supabase = createAdminBrowserClient();

  const payload: Record<string, unknown> = {};
  if (input.plan !== undefined) payload.plan = input.plan;
  if (input.seats_limit !== undefined) payload.seats_limit = input.seats_limit;
  if (input.status !== undefined) payload.status = input.status;

  if (Object.keys(payload).length === 0) return;

  const { error } = await supabase
    .from("teams")
    .update(payload)
    .eq("id", teamId);
  if (error) throw error;
}

export async function resetTeamQuota(teamId: string): Promise<void> {
  const supabase = createAdminBrowserClient();
  const { data, error } = await supabase.rpc("admin_reset_team_quota", {
    p_team_id: teamId
  });
  if (error) throw error;

  const raw = (data ?? { ok: false }) as { ok?: boolean };
  if (!raw.ok) throw new Error("重置团队额度失败");
}

export function statusLabel(status: TeamStatus | string): string {
  if (status === "banned") return "已封禁";
  if (status === "exhausted") return "额度耗尽";
  if (status === "expired") return "已过期";
  return "正常";
}

export function planLabel(plan: string | null | undefined): string {
  const value = plan || "free";
  const map: Record<string, string> = {
    free: "Free",
    pro: "Pro",
    business: "Business",
    team: "Team"
  };
  return map[value] ?? value;
}

export function subscriptionLabel(status: string | null | undefined): string {
  if (status === "active") return "生效中";
  if (status === "expired") return "已过期";
  if (status === "cancelled") return "已取消";
  return status ?? "无订阅";
}

function normalizeTeam(it: Record<string, unknown>): AdminTeam {
  return {
    id: String(it.id ?? ""),
    name: String(it.name ?? ""),
    owner_id: String(it.owner_id ?? ""),
    owner_email: (it.owner_email as string) ?? null,
    owner_name: (it.owner_name as string) ?? null,
    owner_status: (it.owner_status as string) ?? null,
    plan: String(it.plan ?? "free"),
    seats_limit: Number(it.seats_limit ?? 0),
    status: (it.status as TeamStatus) ?? "active",
    created_at: String(it.created_at ?? ""),
    member_count: Number(it.member_count ?? 0),
    active_member_count: Number(it.active_member_count ?? 0),
    subscription: normalizeSubscription(it.subscription as Record<string, unknown> | null),
    quota: normalizeQuota(it.quota as Record<string, unknown> | null),
    month_usage: Number(it.month_usage ?? 0),
    total_usage: Number(it.total_usage ?? 0),
    key_count: Number(it.key_count ?? 0)
  };
}

function normalizeQuota(it: Record<string, unknown> | null | undefined): AdminTeamQuota | null {
  if (!it) return null;
  return {
    provider_id: String(it.provider_id ?? ""),
    daily_total: Number(it.daily_total ?? 0),
    used: Number(it.used ?? 0),
    remaining: Number(it.remaining ?? 0),
    reserved: Number(it.reserved ?? 0)
  };
}

function normalizeSubscription(it: Record<string, unknown> | null | undefined): AdminTeamSubscription | null {
  if (!it) return null;
  return {
    plan: (it.plan as string) ?? null,
    status: (it.status as string) ?? null,
    seats: it.seats == null ? null : Number(it.seats),
    current_period_start: (it.current_period_start as string) ?? null,
    current_period_end: (it.current_period_end as string) ?? null
  };
}

function normalizeTeamMember(it: Record<string, unknown>): AdminTeamMember {
  return {
    team_id: String(it.team_id ?? ""),
    user_id: String(it.user_id ?? ""),
    email: (it.email as string) ?? null,
    display_name: (it.display_name as string) ?? null,
    status: (it.status as string) ?? null,
    role: (it.role as TeamRole) ?? "member",
    daily_quota_limit_equivalent: it.daily_quota_limit_equivalent == null
      ? null
      : Number(it.daily_quota_limit_equivalent),
    joined_at: String(it.joined_at ?? ""),
    today_usage: Number(it.today_usage ?? 0),
    month_usage: Number(it.month_usage ?? 0),
    total_usage: Number(it.total_usage ?? 0)
  };
}
