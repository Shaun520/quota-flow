import { createAdminBrowserClient } from "@/lib/supabase/client";
import { insertAuditLog } from "@/lib/utils/audit";

export type FeedbackType = "使用问题" | "额度异常" | "账号绑定" | "团队功能" | "建议";
export type FeedbackStatus = "pending" | "resolved";
export type FeedbackTypeFilter = "" | FeedbackType;
export type FeedbackStatusFilter = "" | FeedbackStatus;

export interface FeedbackItem {
  id: string;
  user_id: string;
  type: FeedbackType;
  title: string;
  description: string | null;
  contact: string | null;
  status: FeedbackStatus;
  created_at: string;
  user_name: string | null;
  user_email: string | null;
}

export interface FeedbackListParams {
  type?: FeedbackTypeFilter;
  status?: FeedbackStatusFilter;
  search?: string;
  page?: number;
  pageSize?: number;
}

export interface FeedbackListResult {
  total: number;
  items: FeedbackItem[];
}

export const FEEDBACK_TYPES: FeedbackType[] = ["使用问题", "额度异常", "账号绑定", "团队功能", "建议"];

/** 类型 → 中文标签（与值一致，保留映射便于后续扩展）。 */
export function typeLabel(type: FeedbackType | string): string {
  return type;
}

/** 处理状态 → 中文标签。 */
export function statusLabel(status: FeedbackStatus): string {
  return status === "resolved" ? "已处理" : "待处理";
}

export async function listFeedback(params: FeedbackListParams = {}): Promise<FeedbackListResult> {
  const supabase = createAdminBrowserClient();
  const page = params.page ?? 1;
  const pageSize = params.pageSize ?? 20;

  const { data, error } = await supabase.rpc("admin_list_feedback", {
    p_type: params.type || null,
    p_status: params.status || null,
    p_search: params.search?.trim() || null,
    p_limit: pageSize,
    p_offset: (page - 1) * pageSize
  });
  if (error) throw error;

  const raw = (data ?? { total: 0, items: [] }) as { total: number; items: unknown[] };
  return {
    total: Number(raw.total ?? 0),
    items: (raw.items ?? []).map((it) => normalizeFeedback(it as Record<string, unknown>))
  };
}

/** 切换处理状态（依赖 admin RLS 直更），并写入审计日志。 */
export async function setFeedbackStatus(
  id: string,
  status: FeedbackStatus,
  item: { userId: string; previousStatus: FeedbackStatus }
): Promise<void> {
  const supabase = createAdminBrowserClient();

  const { error } = await supabase
    .from("feedback")
    .update({ status, updated_at: new Date().toISOString() })
    .eq("id", id);
  if (error) throw error;

  await insertAuditLog("feedback.status", {
    userId: item.userId,
    target: id,
    metadata: { previous_status: item.previousStatus, status }
  });
}

function normalizeFeedback(it: Record<string, unknown>): FeedbackItem {
  return {
    id: String(it.id ?? ""),
    user_id: String(it.user_id ?? ""),
    type: (it.type as FeedbackType) ?? "使用问题",
    title: String(it.title ?? ""),
    description: (it.description as string) ?? null,
    contact: (it.contact as string) ?? null,
    status: (it.status as FeedbackStatus) ?? "pending",
    created_at: String(it.created_at ?? ""),
    user_name: (it.user_name as string) ?? null,
    user_email: (it.user_email as string) ?? null
  };
}
