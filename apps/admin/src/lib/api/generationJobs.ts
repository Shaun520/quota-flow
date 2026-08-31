import { createAdminBrowserClient } from "@/lib/supabase/client";

export type GenerationJobStatusFilter = "" | "pending" | "running" | "success" | "failed" | "not_generated";
export type GenerationJobTimeRange = "24h" | "7d" | "30d" | "all";

export interface AdminGenerationJob {
  id: string;
  user_id: string | null;
  user_name: string | null;
  user_email: string | null;
  team_id: string | null;
  team_name: string | null;
  provider_id: string | null;
  provider_name: string | null;
  provider_logo: string | null;
  mode: string | null;
  prompt: string | null;
  status: string;
  trace_id: string | null;
  result_url: string | null;
  quality_score: number | null;
  error: string | null;
  cost_unit: string | null;
  cost_amount: number | null;
  equivalent_count: number | null;
  created_at: string;
  completed_at: string | null;
}

export interface GenerationJobListParams {
  providerId?: string;
  status?: GenerationJobStatusFilter;
  mode?: string;
  userId?: string;
  timeRange?: GenerationJobTimeRange;
  search?: string;
  page?: number;
  pageSize?: number;
}

export interface GenerationJobListResult {
  total: number;
  items: AdminGenerationJob[];
}

function timeRangeToDates(range: GenerationJobTimeRange): { from: Date | null; to: Date | null } {
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

export async function listGenerationJobs(params: GenerationJobListParams = {}): Promise<GenerationJobListResult> {
  const supabase = createAdminBrowserClient();
  const page = params.page ?? 1;
  const pageSize = params.pageSize ?? 20;
  const { from, to } = timeRangeToDates(params.timeRange ?? "all");

  const { data, error } = await supabase.rpc("admin_list_generation_jobs", {
    p_provider_id: params.providerId?.trim() || null,
    p_status: params.status || null,
    p_mode: params.mode?.trim() || null,
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
    items: (raw.items ?? []).map((it) => normalizeGenerationJob(it as Record<string, unknown>))
  };
}

export async function deleteGenerationJob(id: string): Promise<void> {
  const supabase = createAdminBrowserClient();
  const { error } = await supabase.from("jobs").delete().eq("id", id);
  if (error) throw error;
}

export async function deleteGenerationJobs(ids: string[]): Promise<void> {
  const supabase = createAdminBrowserClient();
  const { error } = await supabase.from("jobs").delete().in("id", ids);
  if (error) throw error;
}

/** 状态 → 中文标签 + badge 样式。值来自 jobs.status 的 CHECK 约束。 */
export const JOB_STATUS_LABELS: Record<string, { label: string; badge: string }> = {
  pending: { label: "排队中", badge: "badge-warning" },
  running: { label: "生成中", badge: "badge-info" },
  success: { label: "成功", badge: "badge-success" },
  failed: { label: "失败", badge: "badge-danger" },
  not_generated: { label: "无可用厂商", badge: "badge-muted" }
};

export function statusBadge(status: string): string {
  return JOB_STATUS_LABELS[status]?.label ?? status;
}

/** 已知模式 → 中文，未知回退原文。 */
export function modeLabel(mode: string | null): string {
  if (!mode) return "—";
  const map: Record<string, string> = {
    t2v: "文生视频",
    img: "图生视频",
    first_last: "首尾帧",
    multi_ref: "多参考图",
    image: "图生视频"
  };
  return map[mode] ?? mode;
}

/** 费用展示：cost_amount + cost_unit，无则 "—"。 */
export function formatCost(job: AdminGenerationJob): string {
  if (job.cost_amount == null) return "—";
  return `${job.cost_amount}${job.cost_unit ?? ""}`;
}

function normalizeGenerationJob(it: Record<string, unknown>): AdminGenerationJob {
  return {
    id: String(it.id ?? ""),
    user_id: (it.user_id as string) ?? null,
    user_name: (it.user_name as string) ?? null,
    user_email: (it.user_email as string) ?? null,
    team_id: (it.team_id as string) ?? null,
    team_name: (it.team_name as string) ?? null,
    provider_id: (it.provider_id as string) ?? null,
    provider_name: (it.provider_name as string) ?? null,
    provider_logo: (it.provider_logo as string) ?? null,
    mode: (it.mode as string) ?? null,
    prompt: (it.prompt as string) ?? null,
    status: String(it.status ?? ""),
    trace_id: (it.trace_id as string) ?? null,
    result_url: (it.result_url as string) ?? null,
    quality_score: it.quality_score as number | null,
    error: (it.error as string) ?? null,
    cost_unit: (it.cost_unit as string) ?? null,
    cost_amount: it.cost_amount as number | null,
    equivalent_count: it.equivalent_count as number | null,
    created_at: String(it.created_at ?? ""),
    completed_at: (it.completed_at as string) ?? null
  };
}