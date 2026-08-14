import { createClient } from '@supabase/supabase-js'
import type { SupabaseClient } from '@supabase/supabase-js'

export interface SupabaseConfig {
  supabaseUrl: string
  supabaseAnonKey: string
}

/** 按北京时间（Asia/Shanghai）计算日期键，保证每日额度 0 点重置 */
export function todayKey(): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(new Date())
  const get = (t: string): string => parts.find((p) => p.type === t)?.value ?? ''
  return `${get('year')}-${get('month')}-${get('day')}`
}

export type TeamRole = 'admin' | 'member'

export type ViewScope = 'personal' | 'team' | 'global'
export type UsageScope = 'personal' | 'team'

export interface TeamContext {
  id: string
  role: TeamRole
}

export function createSupabaseClient(config: SupabaseConfig): SupabaseClient {
  return createClient(config.supabaseUrl, config.supabaseAnonKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false
    }
  })
}

export async function getTeamContext(
  client: SupabaseClient,
  userId: string
): Promise<TeamContext | null> {
  const { data, error } = await client
    .from('team_members')
    .select('team_id, role')
    .eq('user_id', userId)
    .maybeSingle()

  if (error || !data) return null
  return { id: data.team_id as string, role: data.role as TeamRole }
}

export interface TeamDetail {
  id: string
  name: string
  owner_id: string
  owner_email: string | null
  owner_name: string | null
  owner_status: string | null
  plan: string
  seats_limit: number
  status: string
  created_at: string
  member_count: number
  active_member_count: number
  subscription: {
    plan: string | null
    status: string | null
    seats: number | null
    current_period_start: string | null
    current_period_end: string | null
  } | null
  month_usage: number
  total_usage: number
  key_count: number
  current_user_role: TeamRole
  quota: TeamQuota | null
}

export interface TeamQuota {
  provider_id: string
  daily_total: number
  used: number
  remaining: number
  reserved: number
}

export interface TeamQuotaSummary {
  team_id: string
  quota: TeamQuota
  member_used: number
  member_limit: number | null
}

export interface TeamMemberView {
  team_id: string
  user_id: string
  email: string | null
  display_name: string | null
  status: string | null
  role: TeamRole
  daily_quota_limit_equivalent: number | null
  joined_at: string
  today_usage: number
  month_usage: number
  total_usage: number
}

export interface TeamInvitation {
  id: string
  team_id: string
  email: string | null
  role: TeamRole | string
  token: string
  expires_at: string
  created_at: string
}

export interface CreateTeamInviteOptions {
  email?: string | null
  role?: TeamRole | string
  expiresAt?: string
}

export class TeamService {
  constructor(private readonly client: SupabaseClient) {}

  async createTeam(name: string): Promise<TeamContext> {
    const { data, error } = await this.client.rpc('create_team', { p_name: name })
    if (error) throw error
    const raw = data as { ok?: boolean; team?: { id?: string; role?: string } } | null
    if (!raw?.team?.id) throw new Error('create_team RPC returned no team')
    return {
      id: raw.team.id,
      role: (raw.team.role === 'admin' ? 'admin' : 'member') as TeamRole
    }
  }

  async joinTeam(token: string): Promise<TeamContext> {
    const { data, error } = await this.client.rpc('join_team_by_invite', { p_token: token })
    if (error) throw error
    const raw = data as { ok?: boolean; team?: { id?: string; role?: string } } | null
    if (!raw?.team?.id) throw new Error('join_team_by_invite RPC returned no team')
    return {
      id: raw.team.id,
      role: (raw.team.role === 'admin' ? 'admin' : 'member') as TeamRole
    }
  }

  async getTeamDetail(teamId: string): Promise<TeamDetail | null> {
    const { data, error } = await this.client.rpc('get_team_detail', { p_team_id: teamId })
    if (error) throw error
    const raw = data as { team?: Record<string, unknown> } | null
    if (!raw?.team) return null
    return normalizeTeamDetail(raw.team)
  }

  async getQuota(teamId: string, providerId = 'doubao'): Promise<TeamQuotaSummary | null> {
    const { data, error } = await this.client.rpc('get_team_quota', {
      p_team_id: teamId,
      p_provider_id: providerId
    })
    if (error) throw error
    if (!data) return null
    return normalizeTeamQuotaSummary(data as Record<string, unknown>)
  }

  async listMembers(teamId: string): Promise<TeamMemberView[]> {
    const { data, error } = await this.client.rpc('get_team_members', { p_team_id: teamId })
    if (error) throw error
    const raw = data as { items?: Array<Record<string, unknown>> } | null
    return (raw?.items ?? []).map((it) => normalizeTeamMember(it))
  }

  async createInvite(teamId: string, opts: CreateTeamInviteOptions = {}): Promise<TeamInvitation> {
    const { data, error } = await this.client.rpc('create_team_invite', {
      p_team_id: teamId,
      p_email: opts.email ?? null,
      p_role: opts.role ?? 'member',
      p_expires_at: opts.expiresAt ?? null
    })
    if (error) throw error
    const raw = data as { invite?: Record<string, unknown> } | null
    if (!raw?.invite) throw new Error('create_team_invite RPC returned no invite')
    return normalizeInvitation(raw.invite)
  }

  async listInvitations(teamId: string): Promise<TeamInvitation[]> {
    const { data, error } = await this.client
      .from('team_invitations')
      .select('id, team_id, email, role, token, expires_at, created_at')
      .eq('team_id', teamId)
      .order('created_at', { ascending: false })
    if (error) throw error
    return (data ?? []).map((it) => normalizeInvitation(it as Record<string, unknown>))
  }

  async removeMember(teamId: string, targetUserId: string): Promise<boolean> {
    const { error, count } = await this.client
      .from('team_members')
      .delete({ count: 'exact' })
      .eq('team_id', teamId)
      .eq('user_id', targetUserId)
    if (error) throw error
    return (count ?? 0) > 0
  }

  async updateMemberLimit(teamId: string, targetUserId: string, limit: number | null): Promise<void> {
    const { error } = await this.client
      .from('team_members')
      .update({ daily_quota_limit_equivalent: limit })
      .eq('team_id', teamId)
      .eq('user_id', targetUserId)
    if (error) throw error
  }

  async leaveTeam(teamId: string): Promise<void> {
    const { error } = await this.client.rpc('team_leave', { p_team_id: teamId })
    if (error) throw error
  }

  async disbandTeam(teamId: string): Promise<void> {
    const { error } = await this.client.rpc('team_disband', { p_team_id: teamId })
    if (error) throw error
  }
}

function normalizeTeamDetail(it: Record<string, unknown>): TeamDetail {
  return {
    id: String(it.id ?? ''),
    name: String(it.name ?? ''),
    owner_id: String(it.owner_id ?? ''),
    owner_email: (it.owner_email as string | null) ?? null,
    owner_name: (it.owner_name as string | null) ?? null,
    owner_status: (it.owner_status as string | null) ?? null,
    plan: String(it.plan ?? ''),
    seats_limit: Number(it.seats_limit ?? 0),
    status: String(it.status ?? ''),
    created_at: String(it.created_at ?? ''),
    member_count: Number(it.member_count ?? 0),
    active_member_count: Number(it.active_member_count ?? 0),
    subscription: normalizeSubscription(it.subscription as Record<string, unknown> | null),
    month_usage: Number(it.month_usage ?? 0),
    total_usage: Number(it.total_usage ?? 0),
    key_count: Number(it.key_count ?? 0),
    current_user_role: (it.current_user_role === 'admin' ? 'admin' : 'member') as TeamRole,
    quota: normalizeTeamQuota(it.quota as Record<string, unknown> | null)
  }
}

function normalizeTeamQuota(it: Record<string, unknown> | null | undefined): TeamQuota | null {
  if (!it) return null
  return {
    provider_id: String(it.provider_id ?? ''),
    daily_total: Number(it.daily_total ?? 0),
    used: Number(it.used ?? 0),
    remaining: Number(it.remaining ?? 0),
    reserved: Number(it.reserved ?? 0)
  }
}

function normalizeTeamQuotaSummary(it: Record<string, unknown>): TeamQuotaSummary | null {
  const quota = normalizeTeamQuota(it.quota as Record<string, unknown> | null)
  if (!quota) return null
  return {
    team_id: String(it.team_id ?? ''),
    quota,
    member_used: Number(it.member_used ?? 0),
    member_limit: it.member_limit == null ? null : Number(it.member_limit)
  }
}

function normalizeSubscription(
  it: Record<string, unknown> | null | undefined
): TeamDetail['subscription'] {
  if (!it) return null
  return {
    plan: (it.plan as string | null) ?? null,
    status: (it.status as string | null) ?? null,
    seats: it.seats == null ? null : Number(it.seats),
    current_period_start: (it.current_period_start as string | null) ?? null,
    current_period_end: (it.current_period_end as string | null) ?? null
  }
}

function normalizeTeamMember(it: Record<string, unknown>): TeamMemberView {
  return {
    team_id: String(it.team_id ?? ''),
    user_id: String(it.user_id ?? ''),
    email: (it.email as string | null) ?? null,
    display_name: (it.display_name as string | null) ?? null,
    status: (it.status as string | null) ?? null,
    role: (it.role === 'admin' ? 'admin' : 'member') as TeamRole,
    daily_quota_limit_equivalent: it.daily_quota_limit_equivalent == null
      ? null
      : Number(it.daily_quota_limit_equivalent),
    joined_at: String(it.joined_at ?? ''),
    today_usage: Number(it.today_usage ?? 0),
    month_usage: Number(it.month_usage ?? 0),
    total_usage: Number(it.total_usage ?? 0)
  }
}

function normalizeInvitation(it: Record<string, unknown>): TeamInvitation {
  return {
    id: String(it.id ?? ''),
    team_id: String(it.team_id ?? ''),
    email: (it.email as string | null) ?? null,
    role: String(it.role ?? 'member'),
    token: String(it.token ?? ''),
    expires_at: String(it.expires_at ?? ''),
    created_at: String(it.created_at ?? '')
  }
}

/* ================= 数据一致性：错误码 + Quota Operation ================= */

export type LedgerErrorCode =
  | 'CONSUMED'
  | 'RELEASED'
  | 'QUOTA_EXHAUSTED'
  | 'LEDGER_NOT_FOUND'
  | 'INVALID_AMOUNT'
  | 'DB_ERROR'
  | 'KEY_NOT_FOUND'
  | 'DEFAULT_SET'

export interface LedgerResult {
  ok: boolean
  code: LedgerErrorCode | string
  message: string
  row?: QuotaLedgerRow | null
}

export type QuotaOperationType = 'reserve' | 'finalize' | 'release'

export interface QuotaOperationRow {
  id: string
  job_id: string
  ledger_id: string
  operation_type: QuotaOperationType
  amount: number
  created_at: string
}

/** 判断错误是否为唯一约束冲突（PostgreSQL error code 23505） */
function isDuplicateKeyError(e: unknown): boolean {
  if (e == null) return false
  const msg = String((e as { message?: string }).message ?? '')
  return msg.includes('23505') || msg.includes('duplicate key') || msg.includes('unique') || msg.includes('already exists')
}

/* ================= 厂商与绑定（Section P1） ================= */

export interface ProviderMeta {
  id: string
  name: string
  logo: string
  capabilities: Record<string, unknown> | null
  auth_type: string
  enabled: boolean
  unit_name: string
  default_daily_quota: number
}

export interface ProviderKey {
  id: string
  team_id: string | null
  owner_user_id: string
  provider_id: string
  account_name: string | null
  encrypted_key: string
  auth_type: string
  cookie_expires_at: string | null
  last_health_check: string | null
  health_status: string
  account_fingerprint: string | null
  enabled: boolean
  is_default: boolean
  created_at: string
}

export interface QuotaLedgerRow {
  id: string
  date: string
  team_id: string | null
  owner_user_id: string | null
  account_key_id: string | null
  provider_id: string
  unit_name: string
  daily_total: number
  used: number
  remaining: number
  reserved: number
  refreshed_at: string
}

export interface AddProviderKeyInput {
  providerId: string
  ownerUserId: string
  teamId?: string | null
  accountName?: string
  encryptedKey: string
  authType?: 'cookie' | 'apikey'
  expiresAt?: string | null
  accountFingerprint?: string | null
  /** 自定义记录 id（UUID）：用于「登录分区 = 生成分区」方案，让 DB id 与登录时的 partition keyId 一致 */
  id?: string
  /** 初始健康状态；默认 'unknown' */
  healthStatus?: string
}

export class ProviderService {
  constructor(private readonly client: SupabaseClient) {}

  async listProviders(): Promise<ProviderMeta[]> {
    const { data, error } = await this.client
      .from('providers')
      .select('*')
      .eq('enabled', true)
      .order('name')
    if (error) throw error
    return (data ?? []) as unknown as ProviderMeta[]
  }

  async listAllProviders(): Promise<ProviderMeta[]> {
    const { data, error } = await this.client
      .from('providers')
      .select('*')
      .order('name')
    if (error) throw error
    return (data ?? []) as unknown as ProviderMeta[]
  }

  async listProviderKeys(userId: string): Promise<ProviderKey[]> {
    const { data, error } = await this.client
      .from('provider_keys')
      .select('*')
      .eq('owner_user_id', userId)
      .order('created_at', { ascending: false })
    if (error) throw error
    return (data ?? []) as unknown as ProviderKey[]
  }

  async listTeamProviderKeys(teamId: string): Promise<ProviderKey[]> {
    const { data, error } = await this.client
      .from('provider_keys')
      .select('*')
      .eq('team_id', teamId)
      .order('created_at', { ascending: false })
    if (error) throw error
    return (data ?? []) as unknown as ProviderKey[]
  }

  async addProviderKey(input: AddProviderKeyInput): Promise<ProviderKey | null> {
    const payload: Record<string, unknown> = {
      owner_user_id: input.ownerUserId,
      provider_id: input.providerId,
      encrypted_key: input.encryptedKey,
      auth_type: input.authType ?? 'cookie'
    }
    if (input.id) payload.id = input.id
    if (input.teamId) payload.team_id = input.teamId
    if (input.accountName) payload.account_name = input.accountName
    if (input.expiresAt) payload.cookie_expires_at = input.expiresAt
    if (input.accountFingerprint) payload.account_fingerprint = input.accountFingerprint
    payload.health_status = input.healthStatus ?? 'unknown'
    // 登录刚成功即视为已检查（标记 healthy 时），避免页面加载后立刻重复开窗复查
    payload.last_health_check = new Date().toISOString()

    const { data, error } = await this.client
      .from('provider_keys')
      .insert(payload)
      .select()
      .single()
    if (error) throw error
    return (data ?? null) as unknown as ProviderKey | null
  }

  /** 重新登录后刷新已有账号的 cookie（保留 keyId，不丢额度归属） */
  async refreshProviderKey(
    userId: string,
    keyId: string,
    input: { encryptedKey: string; expiresAt?: string | null; healthStatus?: string }
  ): Promise<void> {
    const payload: Record<string, unknown> = {
      encrypted_key: input.encryptedKey,
      last_health_check: new Date().toISOString()
    }
    payload.cookie_expires_at = input.expiresAt ?? null
    payload.health_status = input.healthStatus ?? 'unknown'
    const { error } = await this.client
      .from('provider_keys')
      .update(payload)
      .eq('id', keyId)
      .eq('owner_user_id', userId)
    if (error) throw error
  }

  async findDuplicateFingerprint(
    userId: string,
    providerId: string,
    fingerprint: string
  ): Promise<ProviderKey | null> {
    const { data, error } = await this.client
      .from('provider_keys')
      .select('*')
      .eq('owner_user_id', userId)
      .eq('provider_id', providerId)
      .eq('account_fingerprint', fingerprint)
      .maybeSingle()
    if (error) throw error
    return (data ?? null) as unknown as ProviderKey | null
  }

  async removeProviderKey(userId: string, keyId: string): Promise<void> {
    const { error } = await this.client
      .from('provider_keys')
      .delete()
      .eq('id', keyId)
      .eq('owner_user_id', userId)
    if (error) throw error
  }

  async updateHealth(userId: string, keyId: string, status: string): Promise<void> {
    const { error } = await this.client
      .from('provider_keys')
      .update({
        health_status: status,
        last_health_check: new Date().toISOString()
      })
      .eq('id', keyId)
      .eq('owner_user_id', userId)
    if (error) throw error
  }

  async updateAccountName(userId: string, keyId: string, name: string): Promise<void> {
    const { error } = await this.client
      .from('provider_keys')
      .update({ account_name: name })
      .eq('id', keyId)
      .eq('owner_user_id', userId)
    if (error) throw error
  }

  /** 启用/停用账号：停用后智能调度（生成视频等）自动跳过该账号 */
  async setEnabled(userId: string, keyId: string, enabled: boolean): Promise<void> {
    const { error } = await this.client
      .from('provider_keys')
      .update({ enabled })
      .eq('id', keyId)
      .eq('owner_user_id', userId)
    if (error) throw error
  }

  async setProviderKeyScope(keyId: string, teamId: string | null): Promise<void> {
    const { error } = await this.client.rpc('set_provider_key_scope', {
      p_key_id: keyId,
      p_team_id: teamId ?? null
    })
    if (error) throw error
  }

  /** 设为默认账号：通过 RPC 事务化完成清旧+设新，消除中间态空窗 */
  async setDefaultKey(userId: string, providerId: string, keyId: string): Promise<LedgerResult> {
    const { data, error } = await this.client.rpc('set_default_key', {
      p_user_id: userId,
      p_provider_id: providerId,
      p_key_id: keyId
    })
    if (error) throw error
    return (data ?? { ok: false, code: 'DB_ERROR', message: 'RPC 返回空' }) as unknown as LedgerResult
  }

  async listLedger(userId: string): Promise<QuotaLedgerRow[]> {
    // RLS 在服务端隔离数据；按 account_key_id 归属过滤 + 全量个人行
    const { data, error } = await this.client
      .from('quota_ledger')
      .select('*')
      .eq('owner_user_id', userId)
      .order('date', { ascending: false })
    if (error) throw error
    return (data ?? []) as unknown as QuotaLedgerRow[]
  }

  async listTeamLedger(teamId: string): Promise<QuotaLedgerRow[]> {
    const { data, error } = await this.client
      .from('quota_ledger')
      .select('*')
      .eq('team_id', teamId)
      .order('date', { ascending: false })
    if (error) throw error
    return (data ?? []) as unknown as QuotaLedgerRow[]
  }

  async listTodayLedger(userId: string): Promise<QuotaLedgerRow[]> {
    const today = todayKey()
    const { data, error } = await this.client
      .from('quota_ledger')
      .select('*')
      .eq('owner_user_id', userId)
      .eq('date', today)
      .order('date', { ascending: false })
    if (error) throw error
    return (data ?? []) as unknown as QuotaLedgerRow[]
  }

  async listTeamTodayLedger(teamId: string): Promise<QuotaLedgerRow[]> {
    const today = todayKey()
    const { data, error } = await this.client
      .from('quota_ledger')
      .select('*')
      .eq('team_id', teamId)
      .eq('date', today)
      .order('date', { ascending: false })
    if (error) throw error
    return (data ?? []) as unknown as QuotaLedgerRow[]
  }

  /** 批量初始化缺失的今日额度行，避免厂商列表/调度前对每个账号逐个请求。 */
  async ensureProviderLedgerRows(
    userId: string,
    teamId: string | null,
    keyIds: string[]
  ): Promise<QuotaLedgerRow[]> {
    if (keyIds.length === 0) return []
    const { data, error } = await this.client.rpc('ensure_provider_ledger_rows', {
      p_user_id: userId,
      p_team_id: teamId ?? null,
      p_key_ids: keyIds
    })
    if (error) throw error
    return (data ?? []) as unknown as QuotaLedgerRow[]
  }

  async getOrInitLedger(
    input: {
      userId: string
      providerId: string
      unitName: string
      dailyTotal: number
      keyId?: string | null
      teamId?: string | null
    }
  ): Promise<QuotaLedgerRow> {
    const today = todayKey()
    let query = this.client
      .from('quota_ledger')
      .select('*')
      .eq('date', today)
      .eq('owner_user_id', input.userId)
      .eq('provider_id', input.providerId)
    // 有 keyId 时按账号精确匹配；无 keyId 时才匹配聚合行（IS NULL）
    query = input.keyId ? query.eq('account_key_id', input.keyId) : query.is('account_key_id', null)
    const { data: existing, error: queryError } = await query.maybeSingle()
    if (queryError) throw queryError
    if (existing) return existing as unknown as QuotaLedgerRow

    const insertPayload: Record<string, unknown> = {
      date: today,
      owner_user_id: input.userId,
      provider_id: input.providerId,
      unit_name: input.unitName,
      daily_total: input.dailyTotal,
      used: 0,
      remaining: input.dailyTotal
    }
    if (input.teamId) insertPayload.team_id = input.teamId
    if (input.keyId) insertPayload.account_key_id = input.keyId

    // 无法用 ON CONFLICT DO NOTHING + RETURNING：
    // - 个人账号原 UNIQUE 约束无效 (NULL team_id != NULL)
    // - partial unique index 带 WHERE 子句，PostgREST 不支持 ON CONFLICT 指定
    // - 团队行 (team_id NOT NULL) 可用 ON CONFLICT，但混合场景无统一方案
    // 因此采用 SELECT → INSERT → catch duplicate → SELECT 的 TOCTOU 重试模式
    try {
      const { data: created, error: insertError } = await this.client
        .from('quota_ledger')
        .insert(insertPayload)
        .select()
        .single()
      if (insertError) throw insertError
      return (created ?? null) as unknown as QuotaLedgerRow
    } catch (e) {
      // TOCTOU 保护：并发 INSERT 可能触发 duplicate key → 重查返回已有行
      if (isDuplicateKeyError(e)) {
        const { data: retry, error: retryError } = await query.maybeSingle()
        if (retryError) throw retryError
        if (retry) return retry as unknown as QuotaLedgerRow
      }
      throw e
    }
  }

  /** 原子扣减今日额度（统一走 RPC，消除 SELECT→JS计算→UPDATE 竞态）。
   *  RPC 在 WHERE 中用 daily_total - used - reserved >= amount 判断，
   *  不依赖 remaining 字段，避免手动改表 / 旧路径写入导致的不一致。
   *  失败时抛出 Error，message 中包含错误码。 */
  async consumeLedger(
    userId: string,
    providerId: string,
    amount: number,
    opts: { unitName?: string; keyId?: string | null; teamId?: string | null } = {}
  ): Promise<QuotaLedgerRow> {
    const today = todayKey()
    const keyId = opts.keyId ?? null

    const callRpc = async (): Promise<LedgerResult> => {
      const { data, error } = await this.client.rpc('atomic_consume_ledger', {
        p_user_id: userId,
        p_provider_id: providerId,
        p_amount: amount,
        p_key_id: keyId,
        p_date: today
      })
      if (error) throw error
      return (data ?? { ok: false, code: 'DB_ERROR', message: 'RPC 返回空' }) as unknown as LedgerResult
    }

    const result = await callRpc()
    if (result.ok && result.row) {
      return result.row as QuotaLedgerRow
    }

    // LEDGER_NOT_FOUND → 初始化后重试一次
    if (result.code === 'LEDGER_NOT_FOUND') {
      await this.getOrInitLedger({
        userId,
        providerId,
        unitName: opts.unitName ?? '',
        dailyTotal: 0,
        keyId,
        teamId: opts.teamId ?? null
      })
      const retryResult = await callRpc()
      if (retryResult.ok && retryResult.row) {
        return retryResult.row as QuotaLedgerRow
      }
      throw new Error(`[${retryResult.code || 'UNKNOWN'}] ${retryResult.message || '额度扣减失败'}`)
    }

    throw new Error(`[${result.code || 'UNKNOWN'}] ${result.message || '额度扣减失败'}`)
  }

  async consumeTeamQuotaAndFinalize(
    input: {
      teamId: string
      userId: string
      providerId: string
      amount: number
      keyId?: string | null
      date?: string
      jobId?: string | null
    }
  ): Promise<{ ok: boolean; code?: string; message?: string; row?: QuotaLedgerRow | null; quota?: TeamQuota | null }> {
    const { data, error } = await this.client.rpc('team_consume_quota_and_finalize', {
      p_team_id: input.teamId,
      p_user_id: input.userId,
      p_provider_id: input.providerId,
      p_amount: input.amount,
      p_account_key_id: input.keyId ?? null,
      p_date: input.date ?? todayKey(),
      p_job_id: input.jobId ?? null
    })
    if (error) throw error
    const raw = (data ?? { ok: false, code: 'DB_ERROR', message: 'RPC 返回空' }) as {
      ok?: boolean
      code?: string
      message?: string
      row?: Record<string, unknown> | null
      quota?: Record<string, unknown> | null
    }
    return {
      ok: !!raw.ok,
      code: raw.code,
      message: raw.message,
      row: raw.row ? (raw.row as unknown as QuotaLedgerRow) : null,
      quota: normalizeTeamQuota(raw.quota)
    }
  }

  /** 释放预占额度（RPC 原子操作） */
  async releaseLedger(
    userId: string,
    providerId: string,
    amount: number,
    keyId: string
  ): Promise<LedgerResult> {
    const { data, error } = await this.client.rpc('atomic_release_ledger', {
      p_user_id: userId,
      p_provider_id: providerId,
      p_amount: amount,
      p_key_id: keyId,
      p_date: todayKey()
    })
    if (error) throw error
    return (data ?? { ok: false, code: 'DB_ERROR', message: 'RPC 返回空' }) as unknown as LedgerResult
  }

  /** 记录 quota operation（幂等：ON CONFLICT DO NOTHING） */
  async insertQuotaOperation(
    jobId: string,
    ledgerId: string,
    operationType: QuotaOperationType,
    amount: number
  ): Promise<QuotaOperationRow | null> {
    // upsert + ignoreDuplicates = INSERT ... ON CONFLICT DO NOTHING
    const { data, error } = await this.client
      .from('quota_operations')
      .upsert(
        { job_id: jobId, ledger_id: ledgerId, operation_type: operationType, amount },
        { onConflict: 'job_id,operation_type', ignoreDuplicates: true }
      )
      .select()
      .single()
    if (error) throw error
    if (data) return data as unknown as QuotaOperationRow

    // ignoreDuplicates 跳过了已存在行 → 读回已有记录
    const { data: existing, error: readErr } = await this.client
      .from('quota_operations')
      .select('*')
      .eq('job_id', jobId)
      .eq('operation_type', operationType)
      .maybeSingle()
    if (readErr) throw readErr
    return (existing ?? null) as unknown as QuotaOperationRow | null
  }

  /** reconciliation：查找已成功但未 finalize 的 job */
  async findUnfinalizedJobs(userId: string): Promise<Array<{ jobId: string; costAmount: number; keyId: string | null; teamId: string | null }>> {
    const { data, error } = await this.client
      .from('jobs')
      .select('id, cost_amount, account_id, team_id')
      .eq('user_id', userId)
      .eq('status', 'success')
      .gt('cost_amount', 0)
    if (error) throw error
    if (!data || data.length === 0) return []

    const jobIds = data.map((j: { id: string }) => j.id)
    const { data: ops, error: opsError } = await this.client
      .from('quota_operations')
      .select('job_id')
      .in('job_id', jobIds)
      .eq('operation_type', 'finalize')
    if (opsError) throw opsError
    const finalizedIds = new Set((ops ?? []).map((o: { job_id: string }) => o.job_id))

    return (data as Array<{ id: string; cost_amount: number; account_id: string | null; team_id: string | null }>)
      .filter((j) => !finalizedIds.has(j.id))
      .map((j) => ({ jobId: j.id, costAmount: Number(j.cost_amount ?? 0), keyId: j.account_id, teamId: j.team_id }))
  }
}

/* ================= 生成任务历史（P2：数据库为真相源） ================= */

export type JobStatus = 'pending' | 'running' | 'success' | 'failed' | 'not_generated' | 'interrupted'

export interface JobRow {
  id: string
  team_id: string | null
  user_id: string | null
  provider_id: string | null
  account_id: string | null
  mode: string
  prompt: string | null
  options: Record<string, unknown> | null
  attempts: Array<Record<string, unknown>> | null
  status: JobStatus
  trace_id: string | null
  result_url: string | null
  quality_score: number | null
  error: string | null
  cost_unit: string | null
  cost_amount: number | null
  cost_breakdown: Record<string, unknown> | null
  equivalent_count: number | null
  created_at: string
  completed_at: string | null
}

export interface InsertJobInput {
  teamId?: string | null
  providerId?: string | null
  accountId?: string | null
  mode: string
  prompt?: string | null
  options?: Record<string, unknown> | null
  attempts?: Array<Record<string, unknown>> | null
  status: JobStatus
  traceId?: string | null
  resultUrl?: string | null
  qualityScore?: number | null
  error?: string | null
  costUnit?: string | null
  costAmount?: number | null
  createdAt?: string | null
  completedAt?: string | null
}

export interface UpdateJobInput {
  status?: JobStatus
  providerId?: string | null
  accountId?: string | null
  resultUrl?: string | null
  qualityScore?: number | null
  error?: string | null
  costUnit?: string | null
  costAmount?: number | null
  costBreakdown?: Record<string, unknown> | null
  equivalentCount?: number | null
  attempts?: Array<Record<string, unknown>> | null
  traceId?: string | null
  options?: Record<string, unknown> | null
  completedAt?: string | null
}

export class JobService {
  constructor(private readonly client: SupabaseClient) {}

  /** 列出当前用户的任务（明确按账号过滤，避免团队/其他记录混入时区），最新在前 */
  async listJobs(userId: string): Promise<JobRow[]> {
    const { data, error } = await this.client
      .from('jobs')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
    if (error) throw error
    return (data ?? []) as unknown as JobRow[]
  }

  async insertJob(userId: string, input: InsertJobInput): Promise<JobRow | null> {
    const payload: Record<string, unknown> = {
      user_id: userId,
      mode: input.mode,
      status: input.status
    }
    if (input.teamId) payload.team_id = input.teamId
    if (input.providerId) payload.provider_id = input.providerId
    if (input.accountId) payload.account_id = input.accountId
    if (input.prompt) payload.prompt = input.prompt
    if (input.options) payload.options = input.options
    if (input.attempts) payload.attempts = input.attempts
    if (input.traceId) payload.trace_id = input.traceId
    if (input.resultUrl) payload.result_url = input.resultUrl
    if (input.qualityScore != null) payload.quality_score = input.qualityScore
    if (input.error) payload.error = input.error
    if (input.costUnit) payload.cost_unit = input.costUnit
    if (input.costAmount != null) payload.cost_amount = input.costAmount
    if (input.createdAt) payload.created_at = input.createdAt
    if (input.completedAt) payload.completed_at = input.completedAt

    const { data, error } = await this.client
      .from('jobs')
      .insert(payload)
      .select()
      .single()
    if (error) throw error
    return (data ?? null) as unknown as JobRow | null
  }

  /** 更新本人任务（RLS 同约束），支持状态流转与结果回写 */
  async updateJob(userId: string, jobId: string, input: UpdateJobInput): Promise<JobRow | null> {
    const payload: Record<string, unknown> = {}
    if (input.status !== undefined) payload.status = input.status
    if (input.providerId !== undefined) payload.provider_id = input.providerId
    if (input.accountId !== undefined) payload.account_id = input.accountId
    if (input.resultUrl !== undefined) payload.result_url = input.resultUrl
    if (input.qualityScore !== undefined) payload.quality_score = input.qualityScore
    if (input.error !== undefined) payload.error = input.error
    if (input.costUnit !== undefined) payload.cost_unit = input.costUnit
    if (input.costAmount !== undefined) payload.cost_amount = input.costAmount
    if (input.costBreakdown !== undefined) payload.cost_breakdown = input.costBreakdown
    if (input.equivalentCount !== undefined) payload.equivalent_count = input.equivalentCount
    if (input.attempts !== undefined) payload.attempts = input.attempts
    if (input.traceId !== undefined) payload.trace_id = input.traceId
    if (input.options !== undefined) payload.options = input.options
    if (input.completedAt !== undefined) payload.completed_at = input.completedAt

    const { data, error } = await this.client
      .from('jobs')
      .update(payload)
      .eq('id', jobId)
      .eq('user_id', userId)
      .select()
      .single()
    if (error) throw error
    return (data ?? null) as unknown as JobRow | null
  }

  /** 仅本人可删除自己的任务（RLS 同约束） */
  async deleteJob(userId: string, jobId: string): Promise<boolean> {
    const { error, count } = await this.client
      .from('jobs')
      .delete({ count: 'exact' })
      .eq('id', jobId)
      .eq('user_id', userId)
    if (error) throw error
    return (count ?? 0) > 0
  }

  /** 批量删除本人任务（RLS 同约束），返回实际删除条数 */
  async deleteJobs(userId: string, ids: string[]): Promise<number> {
    if (ids.length === 0) return 0
    const { error, count } = await this.client
      .from('jobs')
      .delete({ count: 'exact' })
      .eq('user_id', userId)
      .in('id', ids)
    if (error) throw error
    return count ?? 0
  }
}
