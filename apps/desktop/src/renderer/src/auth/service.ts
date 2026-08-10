import { createAuthService } from '@quota-flow/auth'
import type { AuthService, AuthTokens } from '@quota-flow/auth'
import { JobService, ProviderService } from '@quota-flow/db-supabase'

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY

let service: AuthService | null = null
let providerService: ProviderService | null = null
let jobService: JobService | null = null

export interface PlainSession {
  access_token: string
  refresh_token: string
  expires_at?: number
}

export function isAuthConfigured(): boolean {
  return Boolean(SUPABASE_URL && SUPABASE_ANON_KEY)
}

export function getSupabaseConfig(): { url: string; anonKey: string } | null {
  return SUPABASE_URL && SUPABASE_ANON_KEY ? { url: SUPABASE_URL, anonKey: SUPABASE_ANON_KEY } : null
}

export function getAuthService(): AuthService | null {
  if (!isAuthConfigured()) return null
  if (!service) {
    service = createAuthService('hosted', {
      supabaseUrl: SUPABASE_URL as string,
      supabaseAnonKey: SUPABASE_ANON_KEY as string
    })
  }
  return service
}

export function getProviderService(): ProviderService | null {
  const auth = getAuthService()
  if (!auth) return null
  if (!providerService) {
    providerService = new ProviderService(auth.getClient())
  }
  return providerService
}

export function getJobService(): JobService | null {
  const auth = getAuthService()
  if (!auth) return null
  if (!jobService) {
    jobService = new JobService(auth.getClient())
  }
  return jobService
}

export function toTokens(session: PlainSession): AuthTokens {
  return {
    accessToken: session.access_token,
    refreshToken: session.refresh_token,
    expiresAt: session.expires_at ?? 0
  }
}
