import { createAdminBrowserClient } from "@/lib/supabase/client";

export interface AuditLogInput {
  teamId?: string | null;
  userId?: string | null;
  target?: string | null;
  metadata?: Record<string, unknown>;
}

/**
 * 统一写入审计日志入口。
 * 通过 SECURITY DEFINER RPC 写入，服务端强制使用 auth.uid() 作为操作人，
 * 失败时静默忽略，不阻断主业务操作。
 */
export async function insertAuditLog(action: string, input: AuditLogInput = {}): Promise<void> {
  try {
    const supabase = createAdminBrowserClient();
    const { error } = await supabase.rpc("admin_write_audit_log", {
      p_action: action,
      p_team_id: input.teamId ?? null,
      p_user_id: input.userId ?? null,
      p_target: input.target ?? null,
      p_metadata: input.metadata ?? {}
    });
    if (error) {
      // eslint-disable-next-line no-console
      console.warn("audit log write failed:", error.message);
    }
  } catch {
    // 审计日志失败不阻断主操作。
  }
}
