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

  async listProviderKeys(userId: string): Promise<ProviderKey[]> {
    const { data, error } = await this.client
      .from('provider_keys')
      .select('*')
      .eq('owner_user_id', userId)
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

  /** 设为默认账号：先把同厂商所有账号置否，再置目标为默认（每厂商至多一个） */
  async setDefaultKey(userId: string, providerId: string, keyId: string): Promise<void> {
    const { error: clearError } = await this.client
      .from('provider_keys')
      .update({ is_default: false })
      .eq('owner_user_id', userId)
      .eq('provider_id', providerId)
    if (clearError) throw clearError
    const { error } = await this.client
      .from('provider_keys')
      .update({ is_default: true })
      .eq('id', keyId)
      .eq('owner_user_id', userId)
    if (error) throw error
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

    const { data: created, error: insertError } = await this.client
      .from('quota_ledger')
      .insert(insertPayload)
      .select()
      .single()
    if (insertError) throw insertError
    return (created ?? null) as unknown as QuotaLedgerRow
  }

  /** 扣减今日额度：确保当日 ledger 行存在后累加 used / 扣减 remaining */
  async consumeLedger(
    userId: string,
    providerId: string,
    amount: number,
    opts: { unitName?: string; keyId?: string | null; teamId?: string | null } = {}
  ): Promise<QuotaLedgerRow> {
    const today = todayKey()
    let row: QuotaLedgerRow | null = null
    if (opts.keyId) {
      const { data, error } = await this.client
        .from('quota_ledger')
        .select('*')
        .eq('date', today)
        .eq('owner_user_id', userId)
        .eq('provider_id', providerId)
        .eq('account_key_id', opts.keyId)
        .maybeSingle()
      if (error) throw error
      row = (data ?? null) as unknown as QuotaLedgerRow | null
    }
    if (!row) {
      row = await this.getOrInitLedger({
        userId,
        providerId,
        unitName: opts.unitName ?? '',
        dailyTotal: 0,
        keyId: opts.keyId ?? null,
        teamId: opts.teamId ?? null
      })
    }
    const used = Number(row.used ?? 0) + amount
    const remaining = Math.max(Number(row.remaining ?? 0) - amount, 0)
    const { data, error } = await this.client
      .from('quota_ledger')
      .update({ used, remaining })
      .eq('id', row.id)
      .select()
      .single()
    if (error) throw error
    return (data ?? null) as unknown as QuotaLedgerRow
  }
}

/* ================= 生成任务历史（P2：数据库为真相源） ================= */

export type JobStatus = 'pending' | 'running' | 'success' | 'failed' | 'not_generated'

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

  /** 列出当前用户可见的任务（RLS 已按本人/团队隔离，无需显式过滤），最新在前 */
  async listJobs(): Promise<JobRow[]> {
    const { data, error } = await this.client
      .from('jobs')
      .select('*')
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
