// 参考图上传到 GitHub 公开仓库，经 jsDelivr CDN 提供公网 https URL（替代原 Supabase qf-images 桶）
//
// 目的：智谱等开放平台 API 要求 image_url 为可公网访问的 http(s) 地址，
//       本地文件无法直传，因此选图即上传到公开仓库对应目录，取 jsDelivr CDN 地址透传（免费、0 带宽费）。
//       该公网 URL 仅在生成瞬间透传给厂商 API；历史展示走 userData/images 本地副本，不依赖 CDN 可用性。
// 密钥（GitHub PAT）只存主进程（渲染层只传文件字节），避免暴露写入凭据。
//
// 配置来源（优先环境变量，其次 userData/gh-images.json）：
//   - token   GitHub Personal Access Token（需 repo 写权限）
//   - owner   仓库属主（用户名或组织）
//   - repo    仓库名（必须设为 Public，jsDelivr 只服务公开内容）
//   - branch  可选，默认取仓库默认分支
//   - cdnBase 可选，默认 https://cdn.jsdelivr.net/gh
import { app } from 'electron'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

export interface GhImageConfig {
  token: string
  owner: string
  repo: string
  branch: string
  cdnBase: string
}

const DEFAULT_CDN_BASE = 'https://cdn.jsdelivr.net/gh'

function envOr(key: string, fallback?: string): string | undefined {
  const v = process.env[key]
  return v ? v : fallback
}

/** 读 userData/gh-images.json（可选辅助配置；解析失败按空处理） */
function readConfigFile(): Partial<GhImageConfig> | null {
  try {
    const file = join(app.getPath('userData'), 'gh-images.json')
    if (!existsSync(file)) return null
    // 兼容带 UTF-8 BOM 的配置文件：JSON.parse 不认 BOM，先剥掉
    const raw = readFileSync(file, 'utf8').replace(/^\uFEFF/, '')
    return JSON.parse(raw) as Partial<GhImageConfig>
  } catch {
    return null
  }
}

/** 解析配置：环境变量优先。token/owner/repo 缺失即为未配置。 */
function resolveConfig(): GhImageConfig | null {
  const fromFile = readConfigFile() ?? {}
  const token = envOr('GH_TOKEN', fromFile.token) ?? envOr('GITHUB_TOKEN', fromFile.token)
  const owner = envOr('GH_OWNER', fromFile.owner)
  const repo = envOr('GH_REPO', fromFile.repo)
  const branch = envOr('GH_BRANCH', fromFile.branch)
  const cdnBase = envOr('GH_CDN_BASE', fromFile.cdnBase) ?? DEFAULT_CDN_BASE
  if (!token || !owner || !repo) return null
  // 经守卫后 token/owner/repo 必为非空；此处显式断言以交给 TS 推断
  return { token, owner, repo, branch: branch ?? '', cdnBase: cdnBase.replace(/\/+$/, '') } as GhImageConfig
}

let config: GhImageConfig | null | undefined
let defaultBranchCache: string | undefined

/** 已上传参考图 → GitHub 对象位置登记：公网 URL 只在生成瞬间给厂商用，用完即删。 */
const uploadedPaths = new Map<string, { owner: string; repo: string; branch: string; path: string }>()

/** 解析配置；已配置则缓存，未配置不缓存（每次重新解析，便于运行时补配后直接生效）。 */
function getConfig(): GhImageConfig | null {
  if (config !== undefined) return config
  const resolved = resolveConfig()
  if (resolved) config = resolved
  return resolved
}

async function githubFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const cfg = config as GhImageConfig
  const res = await fetch(`https://api.github.com${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${cfg.token}`,
      'X-GitHub-Api-Version': '2022-11-28',
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
      ...(init?.headers ?? {})
    }
  })
  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    throw new Error(`GitHub API ${res.status}: ${detail.slice(0, 300)}`)
  }
  return res.json() as Promise<T>
}

/** 解析仓库默认分支（首次调用缓存，避免每次上传多一次请求）。 */
async function resolveDefaultBranch(cfg: GhImageConfig): Promise<string> {
  if (defaultBranchCache) return defaultBranchCache
  const repo = await githubFetch<{ default_branch: string }>(`/repos/${cfg.owner}/${cfg.repo}`)
  defaultBranchCache = repo.default_branch
  return repo.default_branch
}

const EXT_RE = /^[a-z0-9]{1,8}$/

/**
 * 上传一张参考图到公开仓库的 qf-images/ 目录，返回 jsDelivr CDN 公网 https URL。
 * 对象路径同旧 Supabase 语义，仅为可读性；jsDelivr 上公开非敏感内容。
 */
export async function uploadImage(params: {
  bytes: Uint8Array
  contentType: string
  ext: string
}): Promise<{ url: string }> {
  const cfg = getConfig()
  if (!cfg) {
    throw new Error('GitHub 图床未配置：请在 userData/gh-images.json 或环境变量 GH_* 填写 token/owner/repo')
  }
  const ext = (params.ext || 'png').toLowerCase()
  if (!EXT_RE.test(ext)) throw new Error('非法的图片扩展名')
  if (!params.bytes || params.bytes.byteLength === 0) throw new Error('图片内容为空')

  const branch = cfg.branch || (await resolveDefaultBranch(cfg))
  const path = `qf-images/${Date.now()}-${Math.random().toString(36).slice(2, 10)}.${ext}`
  // GitHub Contents API 单文件上限 100MB（推荐 <50MB），参考图经渲染层压缩后为 KB~几 MB 级，安全
  await githubFetch<unknown>(`/repos/${cfg.owner}/${cfg.repo}/contents/${path}`, {
    method: 'PUT',
    body: JSON.stringify({
      message: `add ${path}`,
      content: Buffer.from(params.bytes).toString('base64')
    })
  })

  const url = `${cfg.cdnBase}/${cfg.owner}/${cfg.repo}@${branch}/${path}`
  uploadedPaths.set(url, { owner: cfg.owner, repo: cfg.repo, branch, path })
  return { url }
}

/** 删除一张已上传的参考图（按登记的对象位置；公网 URL 用完即删，控制仓库体积）。 */
export async function deleteImage(url: string): Promise<void> {
  const loc = uploadedPaths.get(url)
  if (!loc) return // 未登记/已删：无需处理
  // Contents API 删除需文件当前 sha；先取再删，404 视为已删，忽略即可
  let sha = ''
  try {
    const file = await githubFetch<{ sha: string }>(`/repos/${loc.owner}/${loc.repo}/contents/${loc.path}?ref=${loc.branch}`)
    sha = file.sha
  } catch (e) {
    const status = (e as { message?: string })?.message
    if (/404/i.test(status ?? '')) {
      uploadedPaths.delete(url)
      return
    }
    throw e
  }
  await githubFetch<unknown>(`/repos/${loc.owner}/${loc.repo}/contents/${loc.path}`, {
    method: 'DELETE',
    body: JSON.stringify({ message: `remove ${loc.path}`, sha })
  })
  uploadedPaths.delete(url)
}

/** 删除一批已上传参考图（并行，失败单张忽略）。 */
export async function deleteImages(urls: string[]): Promise<void> {
  await Promise.allSettled((urls ?? []).map((u) => deleteImage(u)))
}

/**
 * 清理 qf-images/ 目录下超过 maxAgeMs 的旧参考图（兜底：失败/崩溃任务残留未能按「用完即删」清理的图）。
 * 返回删除个数。
 */
export async function cleanupOldImages(maxAgeMs: number): Promise<number> {
  const cfg = getConfig()
  if (!cfg) return 0
  const branch = cfg.branch || (await resolveDefaultBranch(cfg))
  let entries: Array<{ name: string; type: string; sha: string }> = []
  try {
    entries = await githubFetch<Array<{ name: string; type: string; sha: string }>>(
      `/repos/${cfg.owner}/${cfg.repo}/contents/qf-images?ref=${branch}`
    )
  } catch {
    return 0 // 目录不存在/无权限：跳过
  }
  const cutoff = Date.now() - maxAgeMs
  let removed = 0
  await Promise.allSettled(
    entries
      .filter((e) => e.type === 'file')
      .map((e) => {
        const ts = Number(e.name.split('-')[0])
        if (!Number.isFinite(ts) || ts > cutoff) return Promise.resolve()
        const path = `qf-images/${e.name}`
        return githubFetch<unknown>(`/repos/${cfg.owner}/${cfg.repo}/contents/${path}`, {
          method: 'DELETE',
          body: JSON.stringify({ message: `remove stale ${path}`, sha: e.sha })
        }).then(() => {
          removed += 1
        })
      })
  )
  return removed
}