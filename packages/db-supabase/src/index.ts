import { createClient } from '@supabase/supabase-js'
import type { SupabaseClient } from '@supabase/supabase-js'

export interface SupabaseConfig {
  supabaseUrl: string
  supabaseAnonKey: string
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
    if (input.teamId) payload.team_id = input.teamId
    if (input.accountName) payload.account_name = input.accountName
    if (input.expiresAt) payload.cookie_expires_at = input.expiresAt
    if (input.accountFingerprint) payload.account_fingerprint = input.accountFingerprint

    const { data, error } = await this.client
      .from('provider_keys')
      .insert(payload)
      .select()
      .single()
    if (error) throw error
    return (data ?? null) as unknown as ProviderKey | null
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
    const today = new Date().toISOString().slice(0, 10)
    const { data: existing, error: queryError } = await this.client
      .from('quota_ledger')
      .select('*')
      .eq('date', today)
      .eq('owner_user_id', input.userId)
      .eq('provider_id', input.providerId)
      .is('account_key_id', null)
      .maybeSingle()
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
}