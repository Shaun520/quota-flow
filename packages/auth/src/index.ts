import { AuthService } from './service'
import type { AuthConfig } from './service'

export { AuthService } from './service'
export type { AuthConfig, AuthResult, AuthTokens } from './service'

export function createAuthService(
  mode: 'hosted' | 'selfhosted',
  config: AuthConfig
): AuthService {
  void mode
  return new AuthService(config)
}