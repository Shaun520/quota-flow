"use client";

import { useEffect, useState } from "react";
import type { AdminUser, RecentJob } from "@/lib/api/users";
import { listRecentJobs, roleLabel, statusLabel } from "@/lib/api/users";
import { avatarColor, formatCount, formatDate, formatDateTime, initials } from "@/lib/utils/format";

function JobStatusBadge({ status }: { status: string }) {
  const map: Record<string, { label: string; tone: "success" | "danger" | "warning" | "muted" }> = {
    success: { label: "成功", tone: "success" },
    failed: { label: "失败", tone: "danger" },
    running: { label: "生成中", tone: "warning" },
    pending: { label: "排队中", tone: "muted" },
    not_generated: { label: "未派发", tone: "muted" },
    interrupted: { label: "已中断", tone: "warning" }
  };
  const item = map[status] ?? { label: status, tone: "muted" as const };
  return <span className={`badge badge-${item.tone}`}>{item.label}</span>;
}

export function UserDetailModal({
  user,
  onClose
}: {
  user: AdminUser | null;
  onClose: () => void;
}) {
  const [jobs, setJobs] = useState<RecentJob[]>([]);
  const [jobsLoading, setJobsLoading] = useState(false);

  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    setJobsLoading(true);
    listRecentJobs(user.id)
      .then((rows) => {
        if (!cancelled) setJobs(rows);
      })
      .catch(() => {
        if (!cancelled) setJobs([]);
      })
      .finally(() => {
        if (!cancelled) setJobsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [user]);

  if (!user) return null;

  return (
    <div className="modal-overlay show" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <div className="modal-title">用户详情</div>
          <button className="modal-close" onClick={onClose} aria-label="关闭">
            <svg className="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        <div className="modal-body">
          <div style={{ display: "flex", alignItems: "center", gap: 14, marginBottom: 20 }}>
            <div
              className="admin-avatar"
              style={{ width: 52, height: 52, fontSize: 18, background: avatarColor(user.id) }}
            >
              {initials(user.display_name, user.email)}
            </div>
            <div>
              <div style={{ fontSize: 16, fontWeight: 600, color: "var(--color-foreground)" }}>
                {user.display_name ?? "未命名"}
              </div>
              <div style={{ fontSize: 13, color: "#64748B" }}>{user.email ?? "—"}</div>
            </div>
          </div>

          <div className="form-row" style={{ marginBottom: 20 }}>
            <div className="form-group" style={{ marginBottom: 0 }}>
              <label className="form-label">所属团队</label>
              <div style={{ fontSize: 14 }}>{user.team_name ?? "个人"}</div>
            </div>
            <div className="form-group" style={{ marginBottom: 0 }}>
              <label className="form-label">角色</label>
              <div style={{ fontSize: 14 }}>
                {roleLabel(user.team_role)}
                {user.is_admin ? <span style={{ marginLeft: 8 }} className="badge badge-info">平台管理员</span> : null}
              </div>
            </div>
          </div>

          <div className="form-row" style={{ marginBottom: 20 }}>
            <div className="form-group" style={{ marginBottom: 0 }}>
              <label className="form-label">注册时间</label>
              <div style={{ fontSize: 14 }}>{formatDate(user.created_at)}</div>
            </div>
            <div className="form-group" style={{ marginBottom: 0 }}>
              <label className="form-label">状态</label>
              <div style={{ fontSize: 14 }}>{statusLabel(user.status)}</div>
            </div>
          </div>

          <div className="form-group" style={{ marginBottom: 20 }}>
            <label className="form-label">最近登录</label>
            <div style={{ fontSize: 14 }}>{formatDateTime(user.last_login_at)}</div>
          </div>

          <div className="form-row" style={{ marginBottom: 20 }}>
            <div className="form-group" style={{ marginBottom: 0 }}>
              <label className="form-label">本月消费</label>
              <div className="cell-mono" style={{ fontSize: 14 }}>{formatCount(user.month_usage)}</div>
            </div>
            <div className="form-group" style={{ marginBottom: 0 }}>
              <label className="form-label">累计消费</label>
              <div className="cell-mono" style={{ fontSize: 14 }}>{formatCount(user.total_usage)}</div>
            </div>
          </div>

          <div className="form-group" style={{ marginBottom: 0 }}>
            <label className="form-label">最近任务</label>
            {jobsLoading ? (
              <div style={{ fontSize: 13, color: "#94A3B8", padding: "12px 0" }}>加载中...</div>
            ) : jobs.length === 0 ? (
              <div style={{ fontSize: 13, color: "#94A3B8", padding: "12px 0" }}>暂无任务记录</div>
            ) : (
              <div className="table-container" style={{ maxHeight: 240, overflowY: "auto" }}>
                <table className="table">
                  <thead>
                    <tr>
                      <th>时间</th>
                      <th>厂商</th>
                      <th>模式</th>
                      <th>等效</th>
                      <th>状态</th>
                    </tr>
                  </thead>
                  <tbody>
                    {jobs.map((job) => (
                      <tr key={job.id}>
                        <td>{formatDateTime(job.created_at)}</td>
                        <td>{job.provider_id ?? "—"}</td>
                        <td>{job.mode}</td>
                        <td className="cell-mono">{job.equivalent_count ?? job.cost_amount ?? "—"}</td>
                        <td><JobStatusBadge status={job.status} /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>

        <div className="modal-footer">
          <button className="btn btn-secondary" onClick={onClose}>关闭</button>
        </div>
      </div>
    </div>
  );
}
