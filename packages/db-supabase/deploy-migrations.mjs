/**
 * 部署 migration 到 Supabase PostgreSQL (逐条执行版)
 */
import pg from 'pg'
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '..', '..')
const MIGRATIONS_DIR = resolve(ROOT, 'migrations')

const { Pool } = pg

const POOLER_HOST = 'aws-0-ap-northeast-2.pooler.supabase.com'
const POOLER_PORT = 6543
const DB_NAME = 'postgres'
const DB_PASSWORD = process.env.DB_PASSWORD || process.argv[2]

if (!DB_PASSWORD) {
  console.error('❌ 缺少数据库密码')
  process.exit(1)
}

const pool = new Pool({
  connectionString: `postgresql://postgres.pnhvyjyexiwmecblfwly:${encodeURIComponent(DB_PASSWORD)}@${POOLER_HOST}:${POOLER_PORT}/${DB_NAME}`,
  ssl: { rejectUnauthorized: false },
  connectionTimeoutMillis: 10000
})

function splitSQL(sql) {
  // Split on semicolons, but not inside dollar-quoted strings
  const statements = []
  let current = ''
  let dollarTag = null
  let i = 0
  while (i < sql.length) {
    const ch = sql[i]
    if (dollarTag) {
      // Inside dollar-quoted string, look for closing tag
      const rest = sql.slice(i)
      const endIdx = rest.indexOf(dollarTag)
      if (endIdx === -1) {
        current += rest
        break
      }
      current += rest.slice(0, endIdx + dollarTag.length)
      i += endIdx + dollarTag.length
      dollarTag = null
      continue
    }
    // Check for dollar quote start
    const dollarMatch = sql.slice(i).match(/^\$(\w*)\$/)
    if (dollarMatch) {
      dollarTag = dollarMatch[0]
      current += dollarTag
      i += dollarTag.length
      continue
    }
    if (ch === ';') {
      const stmt = current.trim()
      if (stmt) statements.push(stmt)
      current = ''
      i++
      continue
    }
    current += ch
    i++
  }
  const stmt = current.trim()
  if (stmt) statements.push(stmt)
  return statements
}

async function main() {
  console.log('  Host:', POOLER_HOST + ':' + POOLER_PORT)

  let client
  try {
    client = await pool.connect()
    console.log('  ✅ 已连接')
  } catch (e) {
    console.error('  ❌ 连接失败:', e.message)
    process.exit(1)
  }

  // 执行 0005
  console.log('\n── 执行 0005_quota_consistency.sql ──')
  const sql5 = readFileSync(resolve(MIGRATIONS_DIR, '0005_quota_consistency.sql'), 'utf8')
  const stmts5 = splitSQL(sql5)
  for (const stmt of stmts5) {
    const firstLine = stmt.split('\n')[0].slice(0, 80)
    try {
      await client.query(stmt)
      console.log(`  ✅ ${firstLine}...`)
    } catch (e) {
      if (e.message.includes('already exists') || e.message.includes('does not exist')) {
        console.log(`  ⚠️  skip: ${firstLine}...`)
      } else {
        console.error(`  ❌ ${firstLine}...\n     ${e.message.split('\n')[0]}`)
      }
    }
  }

  // 执行 0006
  console.log('\n── 执行 0006_quota_rpc.sql ──')
  let sql6 = readFileSync(resolve(MIGRATIONS_DIR, '0006_quota_rpc.sql'), 'utf8')
  // Strip SET LOCAL search_path = '' (function attrs keep their own)
  sql6 = sql6.replace(/^SET LOCAL search_path = '';\s*$/gm, '')
  const stmts6 = splitSQL(sql6)
  let rpcOk = 0, rpcFail = 0
  for (const stmt of stmts6) {
    const firstLine = stmt.split('\n')[0].slice(0, 80)
    try {
      await client.query(stmt)
      console.log(`  ✅ ${firstLine}...`)
      rpcOk++
    } catch (e) {
      rpcFail++
      console.error(`  ❌ ${firstLine}...\n     ${e.message.split('\n')[0]}`)
    }
  }

  // 验证
  console.log('\n── 验证 ──')
  const checks = [
    { name: 'partial unique index', query: "SELECT indexname FROM pg_indexes WHERE indexname = 'idx_quota_ledger_unique_personal'" },
    { name: 'quota_operations 表', query: "SELECT tablename FROM pg_tables WHERE tablename = 'quota_operations'" },
    { name: 'atomic_consume_ledger RPC', query: "SELECT proname FROM pg_proc WHERE proname = 'atomic_consume_ledger'" },
    { name: 'reconcile_consume_and_finalize RPC', query: "SELECT proname FROM pg_proc WHERE proname = 'reconcile_consume_and_finalize'" },
    { name: 'set_default_key RPC', query: "SELECT proname FROM pg_proc WHERE proname = 'set_default_key'" },
    { name: 'atomic_release_ledger RPC', query: "SELECT proname FROM pg_proc WHERE proname = 'atomic_release_ledger'" },
  ]
  let allOk = true
  for (const check of checks) {
    const { rows } = await client.query(check.query)
    const ok = rows.length > 0
    if (!ok) allOk = false
    console.log(`  ${ok ? '✅' : '❌'} ${check.name}`)
  }

  client.release()
  await pool.end()
  if (allOk) {
    console.log('\n✅ 全部部署成功！')
  } else {
    console.log('\n⚠️  部分项目未就绪，请检查')
    process.exit(1)
  }
}

main().catch(e => {
  console.error('❌', e.message)
  process.exit(1)
})
