"use client";

import type { AdminTeam } from "@/lib/api/teams";
import { planLabel, statusLabel, subscriptionLabel } from "@/lib/api/teams";
import { formatCount, formatDate } from "@/lib/utils/format";

function statusTone(status: AdminTeam["status"]): "success" | "danger" | "warning" | "muted" {
  if (status === "banned") return "danger";
  if (status === "exhausted" || status === "expired") return "warning";
  return "success";
}

function planClass(plan: string): string {
  const normalized = (plan || "free").toLowerCase();
  if (normalized === "pro") return "plan-pro";
  if (normalized === "business") return "plan-business";
  return "plan-free";
}

export function TeamTable({
  teams,
  loading,
  error,
  onDetail
}: {
  teams: AdminTeam[];
  loading: boolean;
  error: string | null;
  onDetail: (team: AdminTeam) => void;
}) {
  return (
    <div className="card">
      <div className="table-container">
        <table className="table">
          <thead>
            <tr>
              <th>团队</th>
              <th>负责人</th>
              <th>席位</th>
              <th>套餐</th>
              <th>订阅</th>
              <th>本月用量</th>
              <th>累计用量</th>
              <th>绑定账号</th>
              <th>状态</th>
              <th style={{ textAlign: "right" }}>操作</th>
            </tr>
          </thead>
          <tbody>
            {loading && teams.length === 0 ? (
              <tr>
                <td colSpan={10} className="empty-state" style={{ textAlign: "center" }}>
                  加载中...
                </td>
              </tr>
            ) : error ? (
              <tr>
                <td colSpan={10} className="empty-state" style={{ textAlign: "center", color: "var(--color-destructive)" }}>
                  {error}
                </td>
              </tr>
            ) : teams.length === 0 ? (
              <tr>
                <td colSpan={10} className="empty-state" style={{ textAlign: "center" }}>
                  暂无匹配的团队
                </td>
              </tr>
            ) : (
              teams.map((team) => (
                <tr key={team.id}>
                  <td>
                    <div className="cell-primary">{team.name}</div>
                    <div style={{ fontSize: 11, color: "#94A3B8" }}>{team.id.slice(0, 8)}</div>
                  </td>
                  <td>
                    <div>{team.owner_name ?? team.owner_email ?? "未知"}</div>
                    {team.owner_email ? (
                      <div style={{ fontSize: 11, color: "#94A3B8" }}>{team.owner_email}</div>
                    ) : null}
                  </td>
                  <td className="cell-mono">
                    {team.active_member_count}/{team.seats_limit}
                  </td>
                  <td>
                    <span className={`plan-badge ${planClass(team.plan)}`}>{planLabel(team.plan)}</span>
                  </td>
                  <td>
                    {team.subscription ? (
                      <>
                        <div>{planLabel(team.subscription.plan)}</div>
                        <div style={{ fontSize: 11, color: "#94A3B8" }}>
                          {subscriptionLabel(team.subscription.status)}
                        </div>
                      </>
                    ) : (
                      <div>无订阅</div>
                    )}
                  </td>
                  <td className="cell-mono">{formatCount(team.month_usage)}</td>
                  <td className="cell-mono">{formatCount(team.total_usage)}</td>
                  <td className="cell-mono">{team.key_count}</td>
                  <td>
                    <span className={`badge badge-${statusTone(team.status)}`}>
                      <span className="badge-dot" />
                      {statusLabel(team.status)}
                    </span>
                  </td>
                  <td>
                    <div className="cell-actions">
                      <button className="btn btn-secondary btn-sm" onClick={() => onDetail(team)}>
                        详情
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
