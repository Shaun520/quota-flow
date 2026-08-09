import type { AuthChangeEvent, Session, SupabaseClient, User } from '@supabase/supabase-js'
import {
  createSupabaseClient,
  getTeamContext,
  type SupabaseConfig,
  type TeamContext
} from '@quota-flow/db-supabase'

export type AuthConfig = SupabaseConfig

export interface AuthTokens {
  accessToken: string
  refreshToken: string
  expiresAt: number
}

export interface AuthResult {
  user: User | null
  session: Session | null
  error: string | null
}

export class AuthService {
  private readonly client: SupabaseClient

  constructor(config: AuthConfig) {
    this.client = createSupabaseClient(config)
  }

  async signIn(email: string, password: string): Promise<AuthResult> {
    const { data, error } = await this.client.auth.signInWithPassword({ email, password })
    return { user: data.user ?? null, session: data.session ?? null, error: error?.message ?? null }
  }

  async signUpWithOtp(email: string, password: string, displayName: string): Promise<AuthResult> {
    const { data, error } = await this.client.auth.signInWithOtp({ email })
    if (error) {
      return { user: null, session: null, error: error.message }
    }
    return { user: null, session: null, error: null, pendingPassword: password, pendingDisplayName: displayName }
  }

  async completeSignUp(password: string, displayName: string): Promise<AuthResult> {
    const { data, error } = await this.client.auth.updateUser({
      password,
      data: { display_name: displayName }
    })
    return { user: data.user ?? null, session: null, error: error?.message ?? null }
  }

  async sendOtp(email: string): Promise<{ error: string | null }> {
    const { error } = await this.client.auth.signInWithOtp({ email })
    return { error: error?.message ?? null }
  }

  async verifyOtp(email: string, token: string): Promise<AuthResult> {
    const { data, error } = await this.client.auth.verifyOtp({
      email,
      token,
      type: 'email'
    })
    return { user: data.user ?? null, session: data.session ?? null, error: error?.message ?? null }
  }

  async signOut(): Promise<void> {
    await this.client.auth.signOut()
  }

  async getSession(): Promise<Session | null> {
    const { data } = await this.client.auth.getSession()
    return data.session
  }

  async restoreSession(tokens: AuthTokens): Promise<void> {
    await this.client.auth.setSession({
      access_token: tokens.accessToken,
      refresh_token: tokens.refreshToken
    })
  }

  async getTeam(userId: string): Promise<TeamContext | null> {
    return getTeamContext(this.client, userId)
  }

  onAuthStateChange(callback: (event: AuthChangeEvent, session: Session | null) => void): () => void {
    const { data } = this.client.auth.onAuthStateChange(callback)
    return () => data.subscription.unsubscribe()
  }

  async resetPassword(email: string): Promise<string | null> {
    const { error } = await this.client.auth.resetPasswordForEmail(email)
    return error?.message ?? null
  }

  getClient(): SupabaseClient {
    return this.client
  }
}