"use client";

import { useEffect, useState } from "react";
import type { AdminTeam, AdminTeamMember, TeamStatus } from "@/lib/api/teams";
import {
  listTeamMembers,
  planLabel,
  resetTeamQuota,
  statusLabel,
  subscriptionLabel,
  updateTeamSettings
} from "@/lib/api/teams";
import { formatCount, formatDate, formatDateTime } from "@/lib/utils/format";

export function TeamDetailModal({
  team,
  onClose,
  onSaved
}: {
  team: AdminTeam | null;
  onClose: () => void;
  onSaved: (team: AdminTeam) => void;
}) {
  const [members, setMembers] = useState<AdminTeamMember[]>([]);
  const [loadingMembers, setLoadingMembers] = useState(false);
  const [membersError, setMembersError] = useState<string | null>(null);

  const [plan, setPlan] = useState("free");
  const [seats, setSeats] = useState("3");
  const [status, setStatus] = useState<TeamStatus>("active");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [resettingQuota, setResettingQuota] = useState(false);
  const [resetNotice, setResetNotice] = useState<string | null>(null);

  useEffect(() => {
    if (!team) return;

    setPlan(team.plan || "free");
    setSeats(String(team.seats_limit || 3));
    setStatus(team.status);
    setSaveError(null);
    setResetNotice(null);

    let cancelled = false;
    setLoadingMembers(true);
    setMembersError(null);
    listTeamMembers(team.id)
      .then((rows) => {
        if (!cancelled) setMembers(rows);
      })
      .catch((e) => {
        if (!cancelled) setMembersError(e instanceof Error ? e.message : "加载成员失败");
      })
      .finally(() => {
        if (!cancelled) setLoadingMembers(false);
      });

    return () => {
      cancelled = true;
    };
  }, [team]);

  if (!team) return null;

  const currentTeam = team;

  async function handleSave() {
    const seatsNumber = Number(seats);
    if (!Number.isInteger(seatsNumber) || seatsNumber < 1) {
      setSaveError("席位必须是大于 0 的整数");
      return;
    }

    setSaving(true);
    setSaveError(null);
    try {
      await updateTeamSettings(currentTeam.id, {
        plan,
        seats_limit: seatsNumber,
        status
      });
      onSaved({
        ...currentTeam,
        plan,
        seats_limit: seatsNumber,
        status
      });
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : "保存失败");
    } finally {
      setSaving(false);
    }
  }

  async function handleResetQuota() {
    if (!currentTeam) return;
    setResettingQuota(true);
    setSaveError(null);
    setResetNotice(null);
    try {
      await resetTeamQuota(currentTeam.id);
      const quota = currentTeam.quota
        ? { ...currentTeam.quota, used: 0, remaining: currentTeam.quota.daily_total }
        : currentTeam.quota;
      const next = {
        ...currentTeam,
        quota,
        status: currentTeam.status === "exhausted" ? "active" : currentTeam.status
      };
      onSaved(next);
      setResetNotice("今日额度已重置");
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : "重置额度失败");
    } finally {
      setResettingQuota(false);
    }
  }

  return (
    <div className="modal-overlay show" onClick={onClose}>
      <div className="modal" style={{ maxWidth: 760 }} onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <div className="modal-title">团队详情</div>
          <button className="modal-close" onClick={onClose} aria-label="关闭">
            <svg className="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        <div className="modal-body">
          <div style={{ marginBottom: 20 }}>
            <div style={{ fontSize: 16, fontWeight: 600, color: "var(--color-foreground)" }}>
              {team.name}
            </div>
            <div style={{ fontSize: 13, color: "#64748B", marginTop: 2 }}>
              负责人：{team.owner_name ?? team.owner_email ?? "未知"} · 创建于 {formatDate(team.created_at)}
            </div>
          </div>

          <div className="form-row" style={{ marginBottom: 20 }}>
            <div className="form-group" style={{ marginBottom: 0 }}>
              <label className="form-label">套餐</label>
              <select
                className="form-select"
                value={plan}
                onChange={(e) => setPlan(e.target.value)}
              >
                <option value="free">Free</option>
                <option value="pro">Pro</option>
                <option value="business">Business</option>
                <option value="team">Team</option>
              </select>
            </div>
            <div className="form-group" style={{ marginBottom: 0 }}>
              <label className="form-label">席位上限</label>
              <input
                type="number"
                min={1}
                value={seats}
                onChange={(e) => setSeats(e.target.value)}
              />
            </div>
          </div>

          <div className="form-row" style={{ marginBottom: 20 }}>
            <div className="form-group" style={{ marginBottom: 0 }}>
              <label className="form-label">团队状态</label>
              <select
                className="form-select"
                value={status}
                onChange={(e) => setStatus(e.target.value as TeamStatus)}
              >
                <option value="active">正常</option>
                <option value="banned">已封禁</option>
                <option value="exhausted">额度耗尽</option>
                <option value="expired">已过期</option>
              </select>
            </div>
            <div className="form-group" style={{ marginBottom: 0 }}>
              <label className="form-label">成员 / 席位</label>
              <div style={{ fontSize: 14, paddingTop: 9 }}>{team.active_member_count}/{team.seats_limit}</div>
            </div>
          </div>

          <div className="form-row" style={{ marginBottom: 20 }}>
            <div className="form-group" style={{ marginBottom: 0 }}>
              <label className="form-label">共享额度</label>
              <div className="cell-mono" style={{ fontSize: 14 }}>
                {team.quota ? `${Math.round(team.quota.used)}/${Math.round(team.quota.daily_total)}` : "-"}
              </div>
            </div>
            <div className="form-group" style={{ marginBottom: 0, display: "flex", alignItems: "flex-end" }}>
              <button className="btn btn-secondary btn-sm" disabled={resettingQuota} onClick={() => void handleResetQuota()}>
                {resettingQuota ? "重置中..." : "重置今日额度"}
              </button>
            </div>
          </div>

          <div className="form-row" style={{ marginBottom: 20 }}>
            <div className="form-group" style={{ marginBottom: 0 }}>
              <label className="form-label">本月用量</label>
              <div className="cell-mono" style={{ fontSize: 14 }}>{formatCount(team.month_usage)}</div>
            </div>
            <div className="form-group" style={{ marginBottom: 0 }}>
              <label className="form-label">累计用量</label>
              <div className="cell-mono" style={{ fontSize: 14 }}>{formatCount(team.total_usage)}</div>
            </div>
          </div>

          <div className="form-group" style={{ marginBottom: 20 }}>
            <label className="form-label">订阅信息</label>
            {team.subscription ? (
              <div className="table-container">
                <table className="table">
                  <tbody>
                    <tr>
                      <td>套餐</td>
                      <td>{planLabel(team.subscription.plan)}</td>
                      <td>状态</td>
                      <td>{subscriptionLabel(team.subscription.status)}</td>
                      <td>订阅席位</td>
                      <td>{team.subscription.seats ?? "-"}</td>
                    </tr>
                    <tr>
                      <td>周期开始</td>
                      <td>{formatDateTime(team.subscription.current_period_start)}</td>
                      <td>周期结束</td>
                      <td>{formatDateTime(team.subscription.current_period_end)}</td>
                      <td>绑定账号</td>
                      <td>{team.key_count}</td>
                    </tr>
                  </tbody>
                </table>
              </div>
            ) : (
              <div style={{ fontSize: 13, color: "#94A3B8" }}>无订阅记录</div>
            )}
          </div>

          <div className="form-group" style={{ marginBottom: 0 }}>
            <label className="form-label">成员</label>
            {loadingMembers ? (
              <div style={{ fontSize: 13, color: "#94A3B8", padding: "12px 0" }}>加载中...</div>
            ) : membersError ? (
              <div style={{ fontSize: 13, color: "var(--color-destructive)", padding: "12px 0" }}>
                {membersError}
              </div>
            ) : members.length === 0 ? (
              <div style={{ fontSize: 13, color: "#94A3B8", padding: "12px 0" }}>暂无成员</div>
            ) : (
              <div className="table-container" style={{ maxHeight: 260, overflowY: "auto" }}>
                <table className="table">
                  <thead>
                    <tr>
                      <th>成员</th>
                      <th>角色</th>
                      <th>状态</th>
                      <th>今日用量</th>
                      <th>本月用量</th>
                      <th>日限额</th>
                      <th>加入时间</th>
                    </tr>
                  </thead>
                  <tbody>
                    {members.map((member) => (
                      <tr key={member.user_id}>
                        <td>
                          <div className="cell-primary">{member.display_name ?? member.email ?? "未命名"}</div>
                          {member.email ? <div style={{ fontSize: 11, color: "#94A3B8" }}>{member.email}</div> : null}
                        </td>
                        <td>{member.role === "admin" ? "Admin" : "Member"}</td>
                        <td>{member.status ? statusLabel(member.status) : "-"}</td>
                        <td className="cell-mono">{formatCount(member.today_usage)}</td>
                        <td className="cell-mono">{formatCount(member.month_usage)}</td>
                        <td className="cell-mono">
                          {member.daily_quota_limit_equivalent == null ? "不限" : formatCount(member.daily_quota_limit_equivalent)}
                        </td>
                        <td>{formatDate(member.joined_at)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {saveError ? (
            <div style={{ marginTop: 12, fontSize: 13, color: "var(--color-destructive)" }}>
              {saveError}
            </div>
          ) : null}
          {resetNotice ? (
            <div style={{ marginTop: 12, fontSize: 13, color: "var(--color-success)" }}>
              {resetNotice}
            </div>
          ) : null}
        </div>

        <div className="modal-footer">
          <button className="btn btn-secondary" onClick={onClose}>
            关闭
          </button>
          <button className="btn btn-primary" disabled={saving} onClick={() => void handleSave()}>
            {saving ? "保存中..." : "保存设置"}
          </button>
        </div>
      </div>
    </div>
  );
}
