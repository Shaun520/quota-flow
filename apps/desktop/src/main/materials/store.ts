import { app } from 'electron'
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

/**
 * 素材库：本地优先管理（文件 + 索引），并预留云端后端接口。
 *
 * 接口 MaterialBackend 抽象了素材的持久化方式；当前唯一实现 LocalMaterialBackend
 * 把文件落在 userData/materials，索引落在 userData/materials/index.json。
 * 后续如需云端/团队共享，可新增基于 Supabase 的实现替换单例，上层 IPC 无需改动。
 */

export type MaterialType = 'image' | 'video'

export interface MaterialRecord {
  id: string
  type: MaterialType
  /** 原始文件名（仅展示） */
  name: string
  /** 落盘文件名：<id>.<ext>，用于媒体服务定位与预览 URL */
  fileName: string
  ext: string
  size: number
  createdAt: number
  /** 本地绝对路径，供回填调度台作为生成图片输入 */
  path: string
}

/** 支持的扩展名 → 素材类型（与媒体服务 /materials/ 路由白名单保持一致） */
const EXT_TYPE: Record<string, MaterialType> = {
  png: 'image',
  jpg: 'image',
  jpeg: 'image',
  gif: 'image',
  webp: 'image',
  mp4: 'video'
}

export interface MaterialBackend {
  list(): Promise<MaterialRecord[]>
  importPaths(paths: string[]): Promise<MaterialRecord[]>
  remove(id: string): Promise<{ ok: boolean; error?: string }>
  getFilePath(id: string): string
}

class LocalMaterialBackend implements MaterialBackend {
  private dir: string
  private indexFile: string

  constructor(userData: string) {
    this.dir = join(userData, 'materials')
    this.indexFile = join(this.dir, 'index.json')
    mkdirSync(this.dir, { recursive: true })
  }

  private readIndex(): MaterialRecord[] {
    try {
      if (!existsSync(this.indexFile)) return []
      const raw = readFileSync(this.indexFile, 'utf8')
      const list = JSON.parse(raw) as MaterialRecord[]
      return Array.isArray(list) ? list : []
    } catch {
      return []
    }
  }

  private writeIndex(list: MaterialRecord[]): void {
    writeFileSync(this.indexFile, JSON.stringify(list, null, 2), 'utf8')
  }

  async list(): Promise<MaterialRecord[]> {
    return this.readIndex().sort((a, b) => b.createdAt - a.createdAt)
  }

  async importPaths(paths: string[]): Promise<MaterialRecord[]> {
    const existing = this.readIndex()
    const created: MaterialRecord[] = []
    for (const p of paths) {
      try {
        if (typeof p !== 'string' || !p || !existsSync(p)) continue
        const ext = (p.split('.').pop() || '').toLowerCase()
        const type = EXT_TYPE[ext]
        if (!type) continue
        const id = randomUUID()
        const fileName = `${id}.${ext}`
        const dest = join(this.dir, fileName)
        copyFileSync(p, dest)
        const name = p.replace(/\\/g, '/').split('/').pop() || fileName
        let size = 0
        try {
          size = statSync(dest).size
        } catch {
          // 忽略 stat 失败
        }
        existing.push({
          id,
          type,
          name,
          fileName,
          ext,
          size,
          createdAt: Date.now(),
          path: dest
        })
        created.push(existing[existing.length - 1])
      } catch {
        // 单个文件导入失败不影响其它文件
      }
    }
    if (created.length > 0) this.writeIndex(existing)
    return created
  }

  async remove(id: string): Promise<{ ok: boolean; error?: string }> {
    const existing = this.readIndex()
    const idx = existing.findIndex((m) => m.id === id)
    if (idx === -1) return { ok: false, error: '素材不存在' }
    const [record] = existing.splice(idx, 1)
    try {
      rmSync(join(this.dir, record.fileName), { force: true })
    } catch {
      // 文件已不存在也正常删除索引
    }
    this.writeIndex(existing)
    return { ok: true }
  }

  getFilePath(id: string): string {
    return join(this.dir, this.readIndex().find((m) => m.id === id)?.fileName ?? '')
  }
}

let store: MaterialBackend | null = null

export function getMaterialStore(): MaterialBackend {
  if (!store) store = new LocalMaterialBackend(app.getPath('userData'))
  return store
}