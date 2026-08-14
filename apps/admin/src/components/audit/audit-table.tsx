"use client";

import type { AuditLog } from "@/lib/api/audit";
import { actionLabel, metadataSummary } from "@/lib/api/audit";
import { formatDateTime } from "@/lib/utils/format";

function actionTone(action: string): "info" | "success" | "warning" | "danger" | "muted" {
  if (action.startsWith("user.ban") || action.startsWith("team.ban") || action.startsWith("provider.delete")) {
    return "danger";
  }
  if (action.startsWith("user.unban") || action.startsWith("team.unban")) {
    return "success";
  }
  if (action.startsWith("quota.")) {
    return "warning";
  }
  if (action.startsWith("provider.")) {
    return "info";
  }
  return "muted";
}

export function AuditTable({
  logs,
  loading,
  error
}: {
  logs: AuditLog[];
  loading: boolean;
  error: string | null;
}) {
  return (
    <div className="card">
      <div className="table-container">
        <table className="table audit-table">
          <thead>
            <tr>
              <th>时间</th>
              <th>操作</th>
              <th>操作人</th>
              <th>团队</th>
              <th>用户</th>
              <th>对象</th>
              <th>详情</th>
            </tr>
          </thead>
          <tbody>
            {loading && logs.length === 0 ? (
              <tr>
                <td colSpan={7} className="empty-state" style={{ textAlign: "center" }}>
                  加载中...
                </td>
              </tr>
            ) : error ? (
              <tr>
                <td
                  colSpan={7}
                  className="empty-state"
                  style={{ textAlign: "center", color: "var(--color-destructive)" }}
                >
                  {error}
                </td>
              </tr>
            ) : logs.length === 0 ? (
              <tr>
                <td colSpan={7} className="empty-state" style={{ textAlign: "center" }}>
                  暂无匹配的审计日志
                </td>
              </tr>
            ) : (
              logs.map((log) => (
                <tr key={log.id}>
                  <td style={{ whiteSpace: "nowrap" }}>{formatDateTime(log.created_at)}</td>
                  <td style={{ whiteSpace: "nowrap" }}>
                    <span className={`badge badge-${actionTone(log.action)}`}>{actionLabel(log.action)}</span>
                  </td>
                  <td>
                    <div>
                      <div className="cell-primary">{log.admin_name ?? "—"}</div>
                      {log.admin_email ? (
                        <div style={{ fontSize: 11, color: "#94A3B8" }}>{log.admin_email}</div>
                      ) : null}
                    </div>
                  </td>
                  <td>
                    {log.team_name ? (
                      <div>
                        <div className="cell-primary">{log.team_name}</div>
                      </div>
                    ) : (
                      "—"
                    )}
                  </td>
                  <td>
                    {log.user_name || log.user_email ? (
                      <div>
                        <div className="cell-primary">{log.user_name ?? "—"}</div>
                        {log.user_email ? (
                          <div style={{ fontSize: 11, color: "#94A3B8" }}>{log.user_email}</div>
                        ) : null}
                      </div>
                    ) : (
                      "—"
                    )}
                  </td>
                  <td className="cell-mono">{log.target ?? "—"}</td>
                  <td style={{ maxWidth: 280 }}>
                    <div
                      style={{
                        fontSize: 12,
                        color: "#475569",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap"
                      }}
                      title={metadataSummary(log.metadata)}
                    >
                      {metadataSummary(log.metadata)}
                    </div>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
