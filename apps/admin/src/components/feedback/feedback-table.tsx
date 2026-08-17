"use client";

import type { FeedbackItem } from "@/lib/api/feedback";
import { statusLabel } from "@/lib/api/feedback";
import { formatDateTime } from "@/lib/utils/format";

function statusTone(status: FeedbackItem["status"]): "success" | "warning" {
  return status === "resolved" ? "success" : "warning";
}

export function FeedbackTable({
  items,
  loading,
  error,
  onToggleStatus
}: {
  items: FeedbackItem[];
  loading: boolean;
  error: string | null;
  onToggleStatus: (item: FeedbackItem) => void;
}) {
  return (
    <div className="card">
      <div className="table-container">
        <table className="table">
          <thead>
            <tr>
              <th>时间</th>
              <th>类型</th>
              <th>提出者</th>
              <th>标题</th>
              <th>详细描述</th>
              <th>联系方式</th>
              <th>状态</th>
              <th style={{ textAlign: "right" }}>操作</th>
            </tr>
          </thead>
          <tbody>
            {loading && items.length === 0 ? (
              <tr>
                <td colSpan={8} className="empty-state" style={{ textAlign: "center" }}>
                  加载中...
                </td>
              </tr>
            ) : error ? (
              <tr>
                <td
                  colSpan={8}
                  className="empty-state"
                  style={{ textAlign: "center", color: "var(--color-destructive)" }}
                >
                  {error}
                </td>
              </tr>
            ) : items.length === 0 ? (
              <tr>
                <td colSpan={8} className="empty-state" style={{ textAlign: "center" }}>
                  暂无反馈
                </td>
              </tr>
            ) : (
              items.map((item) => (
                <tr key={item.id}>
                  <td style={{ whiteSpace: "nowrap" }}>{formatDateTime(item.created_at)}</td>
                  <td>
                    <span className="badge badge-muted">{item.type}</span>
                  </td>
                  <td>
                    <div>
                      <div className="cell-primary">{item.user_name ?? "—"}</div>
                      {item.user_email ? (
                        <div style={{ fontSize: 11, color: "#94A3B8" }}>{item.user_email}</div>
                      ) : null}
                    </div>
                  </td>
                  <td className="cell-primary">{item.title}</td>
                  <td style={{ maxWidth: 260 }}>
                    <div
                      style={{
                        fontSize: 12,
                        color: "#475569",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap"
                      }}
                      title={item.description ?? ""}
                    >
                      {item.description || "—"}
                    </div>
                  </td>
                  <td>{item.contact || "—"}</td>
                  <td>
                    <span className={`badge badge-${statusTone(item.status)}`}>
                      <span className="badge-dot" />
                      {statusLabel(item.status)}
                    </span>
                  </td>
                  <td>
                    <div className="cell-actions">
                      <button
                        className={`btn ${item.status === "resolved" ? "btn-outline" : "btn-secondary"} btn-sm`}
                        onClick={() => onToggleStatus(item)}
                      >
                        {item.status === "resolved" ? "标记待处理" : "标记已处理"}
                      </button>
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
