import { useCallback, useEffect, useState } from 'react'
import type { TeamContext, TeamDetail, TeamInvitation, TeamMemberView } from '@quota-flow/db-supabase'
import { getTeamService } from '../auth/service'
import { IconUsers } from './icons'
import { EmptyState } from './EmptyState'

interface TeamProps {
  active: boolean
  fresh: boolean
  userId: string
  team: TeamContext | null
  onTeamChanged: () => Promise<void>
}

function formatDate(iso: string | null): string {
  if (!iso) return '-'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function formatCount(n: number | null | undefined): string {
  const value = Number(n ?? 0)
  return `${Math.round(value).toLocaleString('zh-CN')} 次`
}

function memberName(member: TeamMemberView): string {
  return member.display_name || member.email || '成员'
}

function statusLabel(status: string | null): string {
  if (status === 'active') return '正常'
  if (status === 'banned') return '已封禁'
  if (status === 'exhausted') return '额度耗尽'
  if (status === 'expired') return '已过期'
  return status ?? '-'
}

function statusTone(status: string | null): string {
  if (status === 'active') return 'badge badge-success'
  if (status === 'banned') return 'badge badge-danger'
  if (status === 'exhausted' || status === 'expired') return 'badge badge-warning'
  return 'badge badge-muted'
}

export default function Team({ active, userId, team, onTeamChanged }: TeamProps) {
  const [detail, setDetail] = useState<TeamDetail | null>(null)
  const [members, setMembers] = useState<TeamMemberView[]>([])
  const [invitations, setInvitations] = useState<TeamInvitation[]>([])
  const [inviteCode, setInviteCode] = useState('')
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [teamName, setTeamName] = useState('')
  const [joinToken, setJoinToken] = useState('')
  const [limitDrafts, setLimitDrafts] = useState<Record<string, string>>({})

  const isOwner = team?.role === 'admin'

  const load = useCallback(async () => {
    if (!team) {
      setDetail(null)
      setMembers([])
      setInvitations([])
      return
    }

    const service = getTeamService()
    if (!service) {
      setError('Supabase 未配置')
      setLoading(false)
      return
    }

    setLoading(true)
    setError(null)
    try {
      const owner = team.role === 'admin'
      const [nextDetail, nextMembers, nextInvitations] = await Promise.all([
        service.getTeamDetail(team.id),
        service.listMembers(team.id),
        owner ? service.listInvitations(team.id) : Promise.resolve([])
      ])
      setDetail(nextDetail)
      setMembers(nextMembers)
      setInvitations(nextInvitations)
      setInviteCode((prev) => prev || nextInvitations[0]?.token || '')
      setLimitDrafts((prev) => {
        const next = { ...prev }
        for (const member of nextMembers) {
          if (next[member.user_id] === undefined) {
            next[member.user_id] = member.daily_quota_limit_equivalent == null
              ? ''
              : String(member.daily_quota_limit_equivalent)
          }
        }
        return next
      })
    } catch (e) {
      setError(e instanceof Error ? e.message : '加载失败')
    } finally {
      setLoading(false)
    }
  }, [team])

  useEffect(() => {
    if (active) void load()
  }, [active, load])

  useEffect(() => {
    if (!notice) return
    const timer = window.setTimeout(() => setNotice(null), 2400)
    return () => window.clearTimeout(timer)
  }, [notice])

  async function handleCreate(): Promise<void> {
    if (!teamName.trim()) {
      setError('请输入团队名称')
      return
    }
    const service = getTeamService()
    if (!service) return
    setBusy(true)
    setError(null)
    try {
      await service.createTeam(teamName.trim())
      setTeamName('')
      await onTeamChanged()
      setNotice('团队创建成功')
    } catch (e) {
      setError(e instanceof Error ? e.message : '创建失败')
    } finally {
      setBusy(false)
    }
  }

  async function handleJoin(): Promise<void> {
    if (!joinToken.trim()) {
      setError('请输入邀请码')
      return
    }
    const service = getTeamService()
    if (!service) return
    setBusy(true)
    setError(null)
    try {
      await service.joinTeam(joinToken.trim().toUpperCase())
      setJoinToken('')
      await onTeamChanged()
      setNotice('已加入团队')
    } catch (e) {
      setError(e instanceof Error ? e.message : '加入失败')
    } finally {
      setBusy(false)
    }
  }

  async function handleGenerateInvite(): Promise<void> {
    if (!team) return
    const service = getTeamService()
    if (!service) return
    setBusy(true)
    setError(null)
    try {
      const invite = await service.createInvite(team.id)
      setInviteCode(invite.token)
      await load()
      setNotice('邀请码已生成')
    } catch (e) {
      setError(e instanceof Error ? e.message : '生成失败')
    } finally {
      setBusy(false)
    }
  }

  async function handleCopyInvite(): Promise<void> {
    if (!inviteCode) return
    try {
      await navigator.clipboard?.writeText(inviteCode)
      setNotice('邀请码已复制')
    } catch {
      setNotice('复制失败，请手动复制')
    }
  }

  async function handleRemoveMember(member: TeamMemberView): Promise<void> {
    if (!team || member.user_id === userId) return
    if (!window.confirm(`确定移除 ${memberName(member)} 吗？`)) return
    const service = getTeamService()
    if (!service) return
    setBusy(true)
    setError(null)
    try {
      await service.removeMember(team.id, member.user_id)
      await load()
      setNotice('成员已移除')
    } catch (e) {
      setError(e instanceof Error ? e.message : '移除失败')
    } finally {
      setBusy(false)
    }
  }

  async function handleSaveLimit(member: TeamMemberView): Promise<void> {
    if (!team) return
    const raw = limitDrafts[member.user_id] ?? ''
    const next = raw.trim() === '' ? null : Number(raw)
    if (next != null && (Number.isNaN(next) || next < 0)) {
      setError('日限额必须是非负数字')
      return
    }
    const service = getTeamService()
    if (!service) return
    setBusy(true)
    setError(null)
    try {
      await service.updateMemberLimit(team.id, member.user_id, next)
      await load()
      setNotice('成员日限额已更新')
    } catch (e) {
      setError(e instanceof Error ? e.message : '更新失败')
    } finally {
      setBusy(false)
    }
  }

  async function handleLeave(): Promise<void> {
    if (!team || isOwner) return
    if (!window.confirm('退出团队后，你自己共享给该团队的账号会变回个人账号。确定退出吗？')) return
    const service = getTeamService()
    if (!service) return
    setBusy(true)
    setError(null)
    try {
      await service.leaveTeam(team.id)
      await onTeamChanged()
      setNotice('已退出团队')
    } catch (e) {
      setError(e instanceof Error ? e.message : '退出失败')
    } finally {
      setBusy(false)
    }
  }

  if (!team) {
    return (
      <div className="tab-wrap">
        <div className="page-header">
          <div className="title-group">
            <div>
              <h1>团队</h1>
              <div className="divider" />
            </div>
            <p>创建团队或通过邀请码加入</p>
          </div>
        </div>
        <EmptyState
          className="team-empty"
          icon={<IconUsers size={20} />}
          title="你还没有加入任何团队"
          description="创建团队后可以集中管理成员、邀请码和团队额度。"
          action={
            <div className="team-empty-actions">
              <input
                className="team-input"
                type="text"
                placeholder="团队名称"
                value={teamName}
                onChange={(e) => setTeamName(e.target.value)}
              />
              <button className="btn-sm primary" disabled={busy} onClick={() => void handleCreate()}>
                创建团队
              </button>
              <input
                className="team-input"
                type="text"
                placeholder="邀请码"
                value={joinToken}
                onChange={(e) => setJoinToken(e.target.value.toUpperCase())}
              />
              <button className="btn-sm" disabled={busy} onClick={() => void handleJoin()}>
                加入团队
              </button>
            </div>
          }
        />
        {error && <div className="team-message team-message-error">{error}</div>}
      </div>
    )
  }

  return (
    <div className="tab-wrap">
      <div className="page-header">
        <div className="title-group">
          <div>
            <h1>团队</h1>
            <div className="divider" />
          </div>
          <p>{detail?.name ?? '团队管理'}</p>
        </div>
      </div>

      {error && <div className="team-message team-message-error">{error}</div>}

      <div className="team-grid">
        <div className="team-panel">
          <div className="panel-header">
            <h2>成员列表</h2>
            <span className="panel-meta">
              {members.length}/{detail?.seats_limit ?? '-'} 席位
            </span>
          </div>
          <div className={'history-table-wrap' + (loading && members.length > 0 ? ' table-wrap-loading' : '')} style={{ flex: 1, minHeight: 0 }}>
            {loading && members.length > 0 ? <div className="table-refresh-overlay">刷新中...</div> : null}
            <div className="table-scroll">
              <table className="team-table">
                <thead>
                  <tr>
                    <th>成员</th>
                    <th>角色</th>
                    <th>状态</th>
                    <th>今日用量</th>
                    <th>日限额</th>
                    <th>加入时间</th>
                    {isOwner ? <th style={{ textAlign: 'right' }}>操作</th> : null}
                  </tr>
                </thead>
                <tbody>
                  {loading && members.length === 0 ? (
                    <tr>
                      <td colSpan={isOwner ? 7 : 6} style={{ textAlign: 'center', color: 'var(--fg-muted)' }}>
                        加载中...
                      </td>
                    </tr>
                  ) : members.length === 0 ? (
                    <tr>
                      <td colSpan={isOwner ? 7 : 6} style={{ textAlign: 'center', color: 'var(--fg-muted)' }}>
                        暂无成员
                      </td>
                    </tr>
                  ) : (
                    members.map((member) => (
                      <tr key={member.user_id}>
                        <td>
                          <strong>{memberName(member)}</strong>
                          {member.user_id === userId ? <span style={{ marginLeft: 6, color: 'var(--fg-muted)' }}>我</span> : null}
                          <div style={{ fontSize: 11, color: 'var(--fg-muted)' }}>{member.email ?? ''}</div>
                        </td>
                        <td>{member.role === 'admin' ? '管理员' : '成员'}</td>
                        <td>
                          <span className={statusTone(member.status)}>{statusLabel(member.status)}</span>
                        </td>
                        <td className="cell-mono">{formatCount(member.today_usage)}</td>
                        <td className="cell-mono">{member.daily_quota_limit_equivalent == null ? '不限' : formatCount(member.daily_quota_limit_equivalent)}</td>
                        <td>{formatDate(member.joined_at)}</td>
                        {isOwner ? (
                          <td>
                            <div className="team-row-actions">
                              <input
                                className="team-limit-input"
                                type="number"
                                min={0}
                                value={limitDrafts[member.user_id] ?? ''}
                                placeholder="不限"
                                onChange={(e) =>
                                  setLimitDrafts((prev) => ({ ...prev, [member.user_id]: e.target.value }))
                                }
                              />
                              <button className="btn-sm" disabled={busy} onClick={() => void handleSaveLimit(member)}>
                                保存
                              </button>
                              {member.user_id !== userId ? (
                                <button className="btn-sm danger" disabled={busy} onClick={() => void handleRemoveMember(member)}>
                                  移除
                                </button>
                              ) : null}
                            </div>
                          </td>
                        ) : null}
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>

        <div className="team-panel">
          <div className="panel-header">
            <h2>团队配置</h2>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div className="config-card">
              <div className="config-label">团队名称</div>
              <div className="config-val">{detail?.name ?? '-'}</div>
            </div>
            <div className="config-card">
              <div className="config-label">当前套餐</div>
              <div className="config-val">{detail?.plan ?? '-'}</div>
            </div>
            <div className="config-card">
              <div className="config-label">席位上限</div>
              <div className="config-val">{detail?.seats_limit ?? '-'} 人</div>
            </div>
            <div className="config-card">
              <div className="config-label">状态</div>
              <div className="config-val">{detail ? statusLabel(detail.status) : '-'}</div>
            </div>
            <div className="config-card">
              <div className="config-label">本月用量</div>
              <div className="config-val">{detail ? formatCount(detail.month_usage) : '-'}</div>
            </div>
            <div className="config-card">
              <div className="config-label">累计用量</div>
              <div className="config-val">{detail ? formatCount(detail.total_usage) : '-'}</div>
            </div>
            <div className="config-card">
              <div className="config-label">团队共享额度</div>
              <div className="config-val">
                {detail?.quota ? `${Math.round(detail.quota.used)}/${Math.round(detail.quota.daily_total)}` : '-'}
              </div>
            </div>
          </div>

          {isOwner ? (
            <div className="team-invite-box">
              <div className="config-label">邀请码</div>
              <input
                className="team-input"
                type="text"
                readOnly
                value={inviteCode}
                placeholder="点击生成"
              />
              <div style={{ display: 'flex', gap: 6 }}>
                <button className="btn-sm" style={{ flex: 1 }} disabled={busy || !inviteCode} onClick={() => void handleCopyInvite()}>
                  复制
                </button>
                <button className="btn-sm primary" style={{ flex: 1 }} disabled={busy} onClick={() => void handleGenerateInvite()}>
                  生成邀请码
                </button>
              </div>
              {invitations.length > 0 ? (
                <div className="team-invite-list">
                  {invitations.map((invite) => (
                    <div key={invite.id} className="team-invite-item">
                      <span>{invite.token}</span>
                      <span>{invite.email ?? '不限邮箱'}</span>
                    </div>
                  ))}
                </div>
              ) : null}
            </div>
          ) : null}

          <div style={{ marginTop: 'auto', display: 'flex', gap: 6 }}>
            <button className="btn-sm" style={{ flex: 1 }} disabled={loading} onClick={() => void load()}>
              刷新
            </button>
            {!isOwner ? (
              <button className="btn-sm danger" style={{ flex: 1 }} disabled={busy} onClick={() => void handleLeave()}>
                退出团队
              </button>
            ) : null}
          </div>
        </div>
      </div>

      {notice && <div className="app-toast">{notice}</div>}
    </div>
  )
}
