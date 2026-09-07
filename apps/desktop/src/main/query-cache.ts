import { ProviderService } from '@quota-flow/db-supabase'
import type { ProviderKeySecret } from '@quota-flow/db-supabase'

/** db-supabase 未直接导出 SupabaseClient 类型，改为从 ProviderService 构造参数推导 */
type ProviderServiceClient = ConstructorParameters<typeof ProviderService>[0]

/* ================= 主进程密钥分区缓存 =================
 * 会话内先加载：主进程（dispatch 调度 / cookie 续命等）反复按分区读密钥，
 * 同一分区 TTL 内直接复用，避免反复打 provider_keys 表拉取 encrypted_key 大字段。
 * 重登录/换账号强制失效：signOut 时 clearKeysCache 全清；写点（add/refresh/remove/默认/停用/改名/健康等）
 * 成功后按 keyId（或 owner scope）invalidate，保证缓存与 DB 语义一致，不依赖 TTL 兜新鲜。
 * 注：缓存只存查询结果数据，不持有 SupabaseClient；命中时无需任何请求。
 */

export type KeyScopeKind = 'user' | 'team'

interface KeyCacheEntry {
  at: number
  keys: ProviderKeySecret[]
}

/** 分区缓存键：{kind}:{scopeId}:{providerId} 。与 ProviderService 两类查询一一对应。 */
function partitionKey(kind: KeyScopeKind, scopeId: string, providerId: string | undefined): string {
  return `${kind}:${scopeId}:${providerId ?? ''}`
}

/** 分区缓存 + keyId 反查索引（invalidate by keyId 时定位并清掉所有含该 key 的分区） */
const keyCache = new Map<string, KeyCacheEntry>()
const keyToPartitions = new Map<string, Set<string>>()
const KEY_CACHE_TTL_MS = 5 * 60 * 1000

/** P0：按 keyId 的单行密文缓存（keyId -> encrypted）。
 *  渲染层经 IPC 取单个账号凭证时，若 user 分区缓存未命中，走单行读并缓存于此，
 *  避免「全表带 encrypted_key 拉取再 find」造成的 PostgREST egress 字节大头。
 *  命中零请求；写点失效时随 invalidateKeysByKeyId 同步清理。 */
const encryptedByKeyId = new Map<string, { at: number; encrypted: string }>()
const ENCRYPTED_BY_KEY_ID_TTL_MS = 5 * 60 * 1000

/** 删除某个分区，并同步清理其内所有 key 的反查索引（避免孤儿索引失效不到） */
function evictPartition(pk: string): void {
  const entry = keyCache.get(pk)
  keyCache.delete(pk)
  if (!entry) return
  for (const k of entry.keys) {
    const set = keyToPartitions.get(k.id)
    if (!set) continue
    set.delete(pk)
    if (set.size === 0) keyToPartitions.delete(k.id)
  }
}

/** 登出/换账号全清：退出后旧账号密钥不再驻留内存，也不复用于下一账号 */
export function clearKeysCache(): void {
  keyCache.clear()
  keyToPartitions.clear()
  encryptedByKeyId.clear()
}

/** 按 owner scope 失效：清掉 {kind}:{scopeId}:* 下所有分区（含具体厂商与全量两种） */
export function invalidateKeysByScope(kind: KeyScopeKind, scopeId: string): void {
  const prefix = `${kind}:${scopeId}:`
  for (const pk of [...keyCache.keys()]) {
    if (pk.startsWith(prefix)) evictPartition(pk)
  }
}

/** 按 keyId 失效：清掉反查到的所有含该 key 的分区 + 单行密文缓存 */
export function invalidateKeysByKeyId(keyId: string): void {
  encryptedByKeyId.delete(keyId)
  const partitions = keyToPartitions.get(keyId)
  if (!partitions) return
  for (const pk of [...partitions]) evictPartition(pk)
}

/** IPC 入口的统一失效入口：优先按 keyId，缺省回退按 userId/teamId 整 scope */
export function handleKeysCacheInvalidate(opts: {
  keyId?: string
  userId?: string
  teamId?: string
}): void {
  if (opts.keyId) {
    invalidateKeysByKeyId(opts.keyId)
    return
  }
  if (opts.userId) invalidateKeysByScope('user', opts.userId)
  if (opts.teamId) invalidateKeysByScope('team', opts.teamId)
}

async function cachedKeys(
  client: ProviderServiceClient,
  kind: KeyScopeKind,
  scopeId: string,
  providerId: string | undefined,
  fetch: (svc: ProviderService) => Promise<ProviderKeySecret[]>
): Promise<ProviderKeySecret[]> {
  const pk = partitionKey(kind, scopeId, providerId)
  const hit = keyCache.get(pk)
  if (hit && Date.now() - hit.at < KEY_CACHE_TTL_MS) return hit.keys
  const svc = new ProviderService(client)
  const keys = await fetch(svc)
  keyCache.set(pk, { at: Date.now(), keys })
  for (const k of keys) {
    let set = keyToPartitions.get(k.id)
    if (!set) {
      set = new Set()
      keyToPartitions.set(k.id, set)
    }
    set.add(pk)
  }
  return keys
}

/** 个人维度密钥读取缓存入口（对应 ProviderService.listProviderKeysWithSecrets） */
export function cachedListProviderKeysWithSecrets(
  client: ProviderServiceClient,
  userId: string,
  providerId?: string
): Promise<ProviderKeySecret[]> {
  return cachedKeys(client, 'user', userId, providerId, (svc) =>
    svc.listProviderKeysWithSecrets(userId, providerId)
  )
}

/** 团队维度密钥读取缓存入口（对应 ProviderService.listTeamProviderKeysWithSecrets） */
export function cachedListTeamProviderKeysWithSecrets(
  client: ProviderServiceClient,
  teamId: string,
  providerId?: string
): Promise<ProviderKeySecret[]> {
  return cachedKeys(client, 'team', teamId, providerId, (svc) =>
    svc.listTeamProviderKeysWithSecrets(teamId, providerId)
  )
}

/** 按 userId+keyId 解析某账号 encrypted_key（P0 优化）。
 *  优先命中 keyId 单行密文缓存（TTL 5 分钟，命中零请求）；未命中走 getProviderKeySecret 单行读。
 *  不再通过 listProviderKeysWithSecrets 全表（含 encrypted_key）拉取后 find，
 *  避免「取单个账号凭证却整表回传大字段」造成的 PostgREST egress 字节大头。
 *  单行密文缓存写点失效沿用 invalidateKeysByKeyId；登出/换账号 clearKeysCache 全清。 */
export async function resolveProviderKeyEncrypted(
  client: ProviderServiceClient,
  userId: string,
  keyId: string
): Promise<string | null> {
  // 1) 单行密文缓存命中：零请求
  const hit = encryptedByKeyId.get(keyId)
  if (hit && Date.now() - hit.at < ENCRYPTED_BY_KEY_ID_TTL_MS) return hit.encrypted

  // 2) 未命中：按 keyId 单行读（只回传目标行，含 encrypted_key），写入单行缓存
  const svc = new ProviderService(client)
  const secret = await svc.getProviderKeySecret(userId, keyId)
  if (!secret) return null
  if (secret.encrypted_key) {
    encryptedByKeyId.set(keyId, { at: Date.now(), encrypted: secret.encrypted_key })
    return secret.encrypted_key
  }
  return null
}