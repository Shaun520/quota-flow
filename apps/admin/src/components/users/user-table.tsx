"use client";

import type { AdminUser } from "@/lib/api/users";
import { roleLabel, statusLabel } from "@/lib/api/users";
import { avatarColor, formatCount, formatDate, formatDateTime, initials } from "@/lib/utils/format";

function statusTone(status: AdminUser["status"]): "success" | "danger" | "warning" {
  if (status === "banned") return "danger";
  if (status === "exhausted") return "warning";
  return "success";
}

function roleTone(role: AdminUser["team_role"]): "info" | "muted" {
  return role === "admin" ? "info" : "muted";
}

export function UserTable({
  users,
  loading,
  error,
  onDetail,
  onToggleBan
}: {
  users: AdminUser[];
  loading: boolean;
  error: string | null;
  onDetail: (user: AdminUser) => void;
  onToggleBan: (user: AdminUser) => void;
}) {
  return (
    <div className="card">
      <div className="table-container">
        <table className="table">
          <thead>
            <tr>
              <th>用户</th>
              <th>所属团队</th>
              <th>角色</th>
              <th>注册时间</th>
              <th>最近登录</th>
              <th>本月消费</th>
              <th>累计消费</th>
              <th>状态</th>
              <th style={{ textAlign: "right" }}>操作</th>
            </tr>
          </thead>
          <tbody>
            {loading && users.length === 0 ? (
              <tr>
                <td colSpan={9} className="empty-state" style={{ textAlign: "center" }}>
                  加载中...
                </td>
              </tr>
            ) : error ? (
              <tr>
                <td colSpan={9} className="empty-state" style={{ textAlign: "center", color: "var(--color-destructive)" }}>
                  {error}
                </td>
              </tr>
            ) : users.length === 0 ? (
              <tr>
                <td colSpan={9} className="empty-state" style={{ textAlign: "center" }}>
                  暂无匹配的用户
                </td>
              </tr>
            ) : (
              users.map((user) => (
                <tr key={user.id}>
                  <td>
                    <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                      <div
                        className="admin-avatar"
                        style={{ width: 28, height: 28, fontSize: 11, background: avatarColor(user.id) }}
                      >
                        {initials(user.display_name, user.email)}
                      </div>
                      <div>
                        <div className="cell-primary" style={{ display: "flex", alignItems: "center", gap: 6 }}>
                          {user.display_name ?? "未命名"}
                          {user.is_admin ? (
                            <span className="badge badge-info" style={{ padding: "0 6px", fontSize: 10 }}>
                              管理员
                            </span>
                          ) : null}
                        </div>
                        <div style={{ fontSize: 11, color: "#94A3B8" }}>{user.email ?? "—"}</div>
                      </div>
                    </div>
                  </td>
                  <td>{user.team_name ?? "个人"}</td>
                  <td>
                    <span className={`badge badge-${roleTone(user.team_role)}`}>{roleLabel(user.team_role)}</span>
                  </td>
                  <td>{formatDate(user.created_at)}</td>
                  <td>{formatDateTime(user.last_login_at)}</td>
                  <td className="cell-mono">{formatCount(user.month_usage)}</td>
                  <td className="cell-mono">{formatCount(user.total_usage)}</td>
                  <td>
                    <span className={`badge badge-${statusTone(user.status)}`}>
                      <span className="badge-dot" />
                      {statusLabel(user.status)}
                    </span>
                  </td>
                  <td>
                    <div className="cell-actions">
                      <button className="btn btn-secondary btn-sm" onClick={() => onDetail(user)}>
                        详情
                      </button>
                      <button
                        className={`btn ${user.status === "banned" ? "btn-outline" : "btn-danger"} btn-sm`}
                        onClick={() => onToggleBan(user)}
                      >
                        {user.status === "banned" ? "解封" : "封禁"}
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
