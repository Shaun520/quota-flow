#!/usr/bin/env node
/**
 * Supabase 项目迁移脚本（新库迁移用）
 * - schema  ：合并 migrations/*.sql 为单文件，供新项目 SQL Editor / Supabase CLI 手动导入
 *              （DDL 无法经 PostgREST 执行，必须先跑这一层）
 * - data    ：用 Service Role 直连，按 FK 依赖顺序复制业务表数据
 * - storage ：复制所有存储桶 + 递归复制对象文件
 * - all     ：schema(生成文件) + data + storage
 *
 * 用法（在仓库根目录）：
 *   pnpm --filter @quota-flow/db-supabase run migrate:all -- --dry-run   # 只统计，不写
 *   pnpm --filter @quota-flow/db-supabase run migrate:all
 *   pnpm --filter @quota-flow/db-supabase run migrate:data
 *
 * 配置：复制 scripts/.env.example 为 scripts/.env.migrate 并填 service role 密钥，
 *       或直接设置同名环境变量（环境变量优先）。
 *
 * 注意：本脚本「只搬业务数据」，不迁移 Auth 用户（密码为 bcrypt 哈希，无法经接口重建）。
 *       provider_keys/quota_ledger/jobs 里的 owner_user_id 指向旧库 auth.users.id，
 *       新库这些用户需重新注册，UUID 对不上是预期的——请自行决定是否保留历史行。
 *       --dry-run 只会读取并打印统计，不会写任何数据。
 */
import { createClient } from '@supabase/supabase-js'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDir = path.dirname(fileURLToPath(import.meta.url))

/* ================= 配置 ================= */
function loadEnv() {
  const env = {}
  const file = path.join(scriptDir, '.env.migrate')
  if (fs.existsSync(file)) {
    for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*)\s*$/)
      if (m) env[m[1]] = m[2].trim()
    }
  }
  return env
}

function makeClient(url, key) {
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } })
}

/* ================= Business 表（按 FK 依赖顺序） =================
 * 元信息/主体先写，其他表外键引用它们；保持原 id 以便跨表引用一致。
 * 若某表在目标库不存在（schema 未导入），跳过并提示。
 */
const TABLE_ORDER = [
  'providers',
  'teams',
  'team_members',
  'team_invitations',
  'provider_keys',
  'quota_ledger',
  'quota_operations',
  'provider_caps',
  'profiles',
  'subscriptions',
  'provider_cost_tables',
  'member_usage',
  'announcements',
  'audit_logs',
  'desktop_permissions',
  'creation_videos',
  'feedback',
  'monitor_alert_rules',
  'jobs'
]

const READ_LIMIT = 1000 // PostgREST 单页上限，分页安全值
const CHUNK_BYTES = 400 * 1024 // 单次 insert 载荷上限，保守低于 Supabase ~900KB

/* ================= schema ================= */
async function generateSchema() {
  const dir = path.resolve(scriptDir, '../../../migrations')
  // 排除历史「一次性组合部署」脚本（如 0007_deploy_combined.sql）：
  // 它们内容与 0005/0006/0007 重复，且含顶层 SET LOCAL search_path='' 会污染后续语句。
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.sql') && !/deploy_combined/i.test(f))
    .sort()
  if (!files.length) throw new Error(`migrations 目录为空：${dir}`)
  const parts = files.map((f) => {
    // 迁移体量小，合并成一个完整文件；文件按文件名数字序拼接保持依赖
    return `-- ============ ${f} ============\n` + fs.readFileSync(path.join(dir, f), 'utf8').trim()
  })
  const sql =
    `-- 合并自 migrations/（${files.length} 个文件）。对新库（空 schema）执行本文件即可。` +
    `\n-- 重复执行幂等（IF NOT EXISTS / ON CONFLICT / DROP POLICY IF EXISTS）。` +
    `\n-- 显式指定 search_path：迁移含大量无 schema 前缀的 DDL，避免依赖执行环境默认值。\n\n` +
    `SET search_path = public, auth;\n\n` +
    parts.join('\n\n') +
    `\n\n-- ===== 迁移用授权（仅新库 schema 导入时追加） =====\n` +
    `-- 业务正常用 authenticated（RLS 拦截）；此处仅给 service_role 补表级权限，` +
    `-- 供数据迁移直连读取（service_role 凭 BYPASSRLS 绕过 RLS 策略，但表级 GRANT 不足仍会被拒）。\n` +
    `GRANT ALL ON ALL TABLES IN SCHEMA public TO service_role;\n` +
    `GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO service_role;\n` +
    `GRANT USAGE ON SCHEMA public TO service_role;\n` +
    `GRANT USAGE ON SCHEMA auth TO service_role;\n` +
    `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO service_role;\n` +
    `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO service_role;\n`
  const out = process.env.MIGRATE_SCHEMA_OUT || path.join(scriptDir, 'schema_combined.sql')
  fs.writeFileSync(out, sql, 'utf8')
  console.log(`[schema] 合并 ${files.length} 个迁移 → ${out}`)
  console.log('[schema] 请用新项目 Supabase SQL Editor 粘贴执行；或若本地装了 supabase CLI：supabase db push')
}

/* ================= data ================= */
async function readAll(src, table) {
  const rows = []
  let offset = 0
  for (;;) {
    const { data, error } = await src.from(table).select('*').range(offset, offset + READ_LIMIT - 1)
    if (error) throw new Error(`读取 ${table} 失败: ${error.message}`)
    rows.push(...(data ?? []))
    if (!data || data.length < READ_LIMIT) break
    offset += READ_LIMIT
  }
  return rows
}

async function insertRows(dst, table, rows, dryRun) {
  if (!rows.length) return 0
  let inserted = 0
  let chunk = []
  let size = 0
  const flush = async () => {
    if (!chunk.length) return
    if (dryRun) {
      inserted += chunk.length
      chunk = []
      size = 0
      return
    }
    const { error } = await dst.from(table).insert(chunk, { defaultToNull: true })
    if (error) throw new Error(`写入 ${table} 失败: ${error.message}`)
    inserted += chunk.length
    chunk = []
    size = 0
  }
  for (const row of rows) {
    const rowBytes = Buffer.byteLength(JSON.stringify(row))
    if (size + rowBytes > CHUNK_BYTES && chunk.length) await flush()
    chunk.push(row)
    size += rowBytes
  }
  await flush()
  return inserted
}

async function migrateData(src, dst, dryRun) {
  console.log(`[data] ${dryRun ? '[DRY-RUN] ' : ''}开始迁移业务表（${TABLE_ORDER.length} 张）`)
  let total = 0
  const seen = new Set()
  for (const table of TABLE_ORDER) {
    try {
      const rows = await readAll(src, table)
      const inserted = await insertRows(dst, table, rows, dryRun)
      total += inserted
      console.log(`  · ${table.padEnd(22)} ${rows.length} 行`)
      seen.add(true)
    } catch (e) {
      if (/does not exist/.test(e.message)) {
        console.warn(`  · ${table.padEnd(22)} 目标库无此表，跳过（请先跑 schema）`)
      } else {
        console.error(`  · ${table.padEnd(22)} 复制失败: ${e.message}`)
      }
    }
  }
  if (!seen.size) console.warn('[data] 没有成功复制任何表，请先完成 schema 导入。')
  console.log(`[data] ${dryRun ? '[DRY-RUN] 统计（未写入），共' : '完成，共写入'} ${total} 行`)
}

/* ================= storage ================= */
async function copyStorage(src, dst, dryRun) {
  console.log(`[storage] ${dryRun ? '[DRY-RUN] ' : ''}开始复制存储桶与对象`)
  const { data: buckets, error: be } = await src.storage.listBuckets()
  if (be) throw new Error(`读取源存储桶失败: ${be.message}`)
  for (const b of buckets ?? []) {
    if (b.id === 'bucket_placeholder' && !b.metadata) continue
    const { error: cErr } = await dst.storage.createBucket(b.id, {
      public: !!b.public,
      fileSizeLimit: b.file_size_limit ?? undefined
    })
    if (cErr && !/already exists/i.test(cErr.message)) {
      console.warn(`[storage] 创建桶 ${b.id} 失败: ${cErr.message}`)
    }
    await walkObjects(src, dst, b.id, '', dryRun)
  }
}

async function walkObjects(src, dst, bucket, prefix, dryRun) {
  let offset = 0
  for (;;) {
    const { data, error } = await src.storage
      .from(bucket)
      .list(prefix || '', { limit: READ_LIMIT, offset, sortBy: { column: 'name', order: 'asc' } })
    if (error) throw new Error(`列出 ${bucket}/${prefix} 失败: ${error.message}`)
    const files = (data ?? []).filter((x) => !x.name.endsWith('/'))
    const folders = (data ?? []).filter((x) => x.name.endsWith('/'))
    for (const f of files) {
      const objPath = prefix ? `${prefix}/${f.name}` : f.name
      if (dryRun) {
        console.log(`  · [dry] ${bucket}/${objPath}`)
        continue
      }
      const dl = await src.storage.from(bucket).download(objPath)
      if (dl.error) throw new Error(`下载 ${bucket}/${objPath} 失败: ${dl.error.message}`)
      const buf = await dl.data.arrayBuffer()
      const { error: upErr } = await dst.storage.from(bucket).upload(objPath, buf, {
        contentType: f.metadata?.mimetype || 'application/octet-stream',
        cacheControl: '3600',
        upsert: true
      })
      if (upErr) throw new Error(`上传 ${bucket}/${objPath} 失败: ${upErr.message}`)
      console.log(`    ${bucket}/${objPath}`)
    }
    for (const d of folders) {
      await walkObjects(src, dst, bucket, prefix ? `${prefix}/${d.name.slice(0, -1)}` : d.name.slice(0, -1), dryRun)
    }
    if (!data || data.length < READ_LIMIT) break
    offset += READ_LIMIT
  }
}

/* ================= CLI ================= */
function usage() {
  console.log(`用法: node supabase-migrate.mjs <schema|data|storage|all> [--dry-run]`)
  console.log(`  schema   生成合并 schema SQL（写 scripts/schema_combined.sql）`)
  console.log(`  data     复制业务表数据（Service Role）`)
  console.log(`  storage  复制存储桶 + 对象文件`)
  console.log(`  all      schema + data + storage`)
  console.log(`  --dry-run 只读取并统计，不写入（仅 data/storage 生效）`)
}

async function main() {
  const args = process.argv.slice(2)
  if (args[0] === '-h' || args[0] === '--help' || !args[0]) {
    usage()
    return
  }
  const cmd = args[0]
  const dryRun = args.includes('--dry-run')
  const env = { ...loadEnv(), ...process.env }

  if (cmd === 'schema') {
    return generateSchema()
  }

  const srcUrl = env.SRC_SUPABASE_URL
  const srcKey = env.SRC_SERVICE_ROLE
  const dstUrl = env.DST_SUPABASE_URL
  const dstKey = env.DST_SERVICE_ROLE
  if (!srcUrl || !srcKey || !dstUrl || !dstKey) {
    console.error('缺少配置：请在 scripts/.env.migrate 或环境变量中设置 SRC_SUPABASE_URL / SRC_SERVICE_ROLE / DST_SUPABASE_URL / DST_SERVICE_ROLE')
    process.exit(1)
  }

  const src = makeClient(srcUrl, srcKey)
  const dst = makeClient(dstUrl, dstKey)

  if (cmd === 'data') {
    await migrateData(src, dst, dryRun)
  } else if (cmd === 'storage') {
    await copyStorage(src, dst, dryRun)
  } else if (cmd === 'all') {
    await generateSchema()
    await migrateData(src, dst, dryRun)
    await copyStorage(src, dst, dryRun)
  } else {
    usage()
    process.exit(1)
  }
}

main().catch((e) => {
  console.error('[migrate] 失败：', e.message)
  process.exit(1)
})