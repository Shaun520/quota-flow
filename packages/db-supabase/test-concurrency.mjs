/**
 * 并发测试：数据一致性审计修复验证
 *
 * 运行前：
 *   1. 确保 migration 0005 + 0006 已部署到 Supabase
 *   2. 设置环境变量 TEST_EMAIL / TEST_PASSWORD（或 TEST_ACCESS_TOKEN）
 *
 * 用法：
 *   node scripts/test-concurrency.mjs
 *
 * 环境变量：
 *   TEST_SUPABASE_URL  — Supabase URL（默认从 apps/desktop/.env 读取）
 *   TEST_ANON_KEY      — Supabase anon key
 *   TEST_EMAIL         — 测试用户邮箱
 *   TEST_PASSWORD      — 测试用户密码
 *   TEST_ACCESS_TOKEN  — 或直接提供 access_token（跳过登录）
 */

import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '..', '..')

function loadEnv() {
  const envPath = resolve(ROOT, 'apps', 'desktop', '.env')
  try {
    const content = readFileSync(envPath, 'utf8')
    for (const line of content.split('\n')) {
      const m = line.match(/^([A-Z_]+)\s*=\s*(.+)/)
      if (m) process.env[m[1]] = m[2]
    }
  } catch { /* .env not found */ }
}
loadEnv()

const SUPABASE_URL = process.env.TEST_SUPABASE_URL || process.env.VITE_SUPABASE_URL
const ANON_KEY    = process.env.TEST_ANON_KEY    || process.env.VITE_SUPABASE_ANON_KEY

if (!SUPABASE_URL || !ANON_KEY) {
  console.error('❌ 缺少 Supabase 配置。设置 VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY')
  process.exit(1)
}

// ── 工具函数 ──────────────────────────────────────────────
const PARALLEL = 8 // 并发数

function todayKey() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(new Date())
  const get = (t) => parts.find(p => p.type === t)?.value ?? ''
  return `${get('year')}-${get('month')}-${get('day')}`
}

async function authenticate(client) {
  if (process.env.TEST_ACCESS_TOKEN) {
    console.log('  使用提供的 access_token')
    return process.env.TEST_ACCESS_TOKEN
  }
  const email = process.env.TEST_EMAIL
  const password = process.env.TEST_PASSWORD
  if (!email || !password) {
    console.error('❌ 设置 TEST_EMAIL + TEST_PASSWORD，或 TEST_ACCESS_TOKEN')
    process.exit(1)
  }
  const { data, error } = await client.auth.signInWithPassword({ email, password })
  if (error) {
    console.error('❌ 登录失败:', error.message)
    process.exit(1)
  }
  console.log('  登录成功:', data.user.email)
  return data.session.access_token
}

// ── 测试用例 ──────────────────────────────────────────────
let passed = 0, failed = 0
const results = []

function test(name, fn) {
  results.push({ name, status: 'pending' })
  return async () => {
    try {
      await fn()
      console.log(`  ✅ ${name}`)
      results.find(r => r.name === name).status = 'passed'
      passed++
    } catch (e) {
      console.log(`  ❌ ${name}: ${e.message}`)
      results.find(r => r.name === name).status = 'failed'
      failed++
    }
  }
}

// ── 主流程 ────────────────────────────────────────────────
async function main() {
  console.log('══════════════════════════════════════════════')
  console.log('  数据一致性并发测试')
  console.log('══════════════════════════════════════════════\n')

  const client = createClient(SUPABASE_URL, ANON_KEY)
  const token = await authenticate(client)
  await client.auth.setSession({ access_token: token, refresh_token: '' })
  const { data: { user } } = await client.auth.getUser()
  const userId = user.id
  console.log(`  user_id: ${userId}\n`)

  // 测试数据：创建临时 provider key
  const testProviderId = 'doubao'
  const testKeyId = crypto.randomUUID()
  const testKeyId2 = crypto.randomUUID()
  const today = todayKey()

  // 清理函数
  async function cleanup() {
    // 删测试 ledger 行
    await client.from('quota_ledger').delete().eq('owner_user_id', userId)
      .eq('date', today).eq('provider_id', testProviderId)
      .in('account_key_id', [testKeyId, testKeyId2])
    // 删测试 key
    await client.from('provider_keys').delete().eq('owner_user_id', userId)
      .in('id', [testKeyId, testKeyId2])
    // 删测试 jobs
    await client.from('jobs').delete().eq('user_id', userId)
      .eq('status', 'success').gte('cost_amount', 0)
  }

  // 创建测试 key
  async function setupKeys() {
    for (const id of [testKeyId, testKeyId2]) {
      await client.from('provider_keys').insert({
        id, owner_user_id: userId, provider_id: testProviderId,
        encrypted_key: 'test', auth_type: 'cookie', enabled: true
      })
    }
  }

  // 确保 ledger 行存在
  async function ensureLedger(keyId, dailyTotal = 10) {
    const { data: existing } = await client.from('quota_ledger')
      .select('*').eq('date', today).eq('owner_user_id', userId)
      .eq('provider_id', testProviderId).eq('account_key_id', keyId)
      .maybeSingle()
    if (existing) return existing
    const { data } = await client.from('quota_ledger').insert({
      date: today, owner_user_id: userId, provider_id: testProviderId,
      account_key_id: keyId, unit_name: '点', daily_total: dailyTotal,
      used: 0, remaining: dailyTotal
    }).select().single()
    return data
  }

  console.log('── 清理旧数据 ──')
  await cleanup()
  await setupKeys()
  console.log('  测试环境就绪\n')

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // Test 1: getOrInitLedger — 并发初始化不应创建重复行
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  console.log('── Test 1: getOrInitLedger TOCTOU ──')
  await test('并发初始化同一 (user,keyId,date) 只创建 1 行', async () => {
    // 先确保没有行
    await client.from('quota_ledger').delete().eq('owner_user_id', userId)
      .eq('date', today).eq('account_key_id', testKeyId)

    // 并发 INSERT
    const payload = { date: today, owner_user_id: userId, provider_id: testProviderId,
      account_key_id: testKeyId, unit_name: '点', daily_total: 10, used: 0, remaining: 10 }
    const inserts = Array.from({ length: PARALLEL }, () =>
      client.from('quota_ledger').insert(payload).select().single()
    )
    const results = await Promise.allSettled(inserts)
    const successes = results.filter(r => r.status === 'fulfilled').length
    const duplicates = results.filter(r => r.status === 'rejected' &&
      (r.reason?.message || '').includes('duplicate')).length

    // 验证：只有 1 行（partial unique index 保证）
    const { data: rows, error } = await client.from('quota_ledger')
      .select('*').eq('date', today).eq('owner_user_id', userId)
      .eq('provider_id', testProviderId).eq('account_key_id', testKeyId)
    if (error) throw new Error(error.message)
    if (rows.length !== 1) throw new Error(`期望 1 行，实际 ${rows.length} 行（成功:${successes}, 重复冲突:${duplicates}）`)
  })()

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // Test 2: atomic_consume_ledger — 并发扣减不超额
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  console.log('── Test 2: atomic_consume_ledger 并发 ──')
  await test('并发扣减 total=10 每次 1，总额度不超扣', async () => {
    await ensureLedger(testKeyId, 10)
    // 重置
    await client.from('quota_ledger').update({ used: 0, remaining: 10 })
      .eq('date', today).eq('owner_user_id', userId)
      .eq('provider_id', testProviderId).eq('account_key_id', testKeyId)

    const CONCURRENT = 12 // 故意超过总量 10，测试原子保护
    const calls = Array.from({ length: CONCURRENT }, () =>
      client.rpc('atomic_consume_ledger', {
        p_user_id: userId, p_provider_id: testProviderId,
        p_amount: 1, p_key_id: testKeyId, p_date: today
      })
    )
    const results = await Promise.allSettled(calls)
    const consumed = results.filter(r =>
      r.status === 'fulfilled' && r.value?.data?.ok === true
    ).length
    const exhausted = results.filter(r =>
      r.status === 'fulfilled' && r.value?.data?.code === 'QUOTA_EXHAUSTED'
    ).length

    // 验证：used 正好 = min(CONCURRENT, 10) = 10
    const { data: row } = await client.from('quota_ledger')
      .select('*').eq('date', today).eq('owner_user_id', userId)
      .eq('provider_id', testProviderId).eq('account_key_id', testKeyId).single()

    if (Number(row.used) !== 10) throw new Error(`期望 used=10，实际 used=${row.used}（成功:${consumed}, 耗尽:${exhausted}）`)
    if (Number(row.remaining) !== 0) throw new Error(`期望 remaining=0，实际 remaining=${row.remaining}`)
    console.log(`    成功 ${consumed} 次，额度耗尽拒绝 ${exhausted} 次，used=${row.used}`)
  })()

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // Test 3: 扣减条件基于 daily_total - used - reserved
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  console.log('── Test 3: remaining 脏数据不影响扣减 ──')
  await test('remaining 字段不一致时，扣减仍基于 daily_total-used', async () => {
    await ensureLedger(testKeyId, 10)
    // 故意把 remaining 写脏（不等于 daily_total - used）
    await client.from('quota_ledger').update({ used: 2, remaining: 100 })
      .eq('date', today).eq('owner_user_id', userId)
      .eq('provider_id', testProviderId).eq('account_key_id', testKeyId)

    // 尝试扣 9（daily_total=10, used=2 → 可用 8，扣 9 应失败）
    const { data } = await client.rpc('atomic_consume_ledger', {
      p_user_id: userId, p_provider_id: testProviderId,
      p_amount: 9, p_key_id: testKeyId, p_date: today
    })

    if (data.code !== 'QUOTA_EXHAUSTED') {
      throw new Error(`期望 QUOTA_EXHAUSTED（daily_total 10 - used 2 = 8 < 9），实际: ${data.code}`)
    }

    // 扣 8 应成功（remaining=100 dirty 但条件用 daily_total-used=8）
    const { data: d2 } = await client.rpc('atomic_consume_ledger', {
      p_user_id: userId, p_provider_id: testProviderId,
      p_amount: 8, p_key_id: testKeyId, p_date: today
    })
    if (!d2.ok) throw new Error(`期望扣减成功，实际: ${d2.code} ${d2.message}`)

    // used 应为 10（原来的 2 + 8），remaining 被修正为 0
    const { data: row } = await client.from('quota_ledger')
      .select('*').eq('date', today).eq('owner_user_id', userId)
      .eq('provider_id', testProviderId).eq('account_key_id', testKeyId).single()
    if (Number(row.used) !== 10) throw new Error(`期望 used=10，实际 used=${row.used}`)
    if (Number(row.remaining) !== 0) throw new Error(`期望 remaining=0（被重新计算），实际 remaining=${row.remaining}`)
  })()

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // Test 4: set_default_key — 并发切换不产生双默认
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  console.log('── Test 4: set_default_key 并发 ──')
  await test('并发 setDefaultKey(A→X) 和 (B→Y) 最终只有 1 个默认', async () => {
    // 重置：两个都是非默认
    await client.from('provider_keys').update({ is_default: false })
      .eq('owner_user_id', userId).in('id', [testKeyId, testKeyId2])

    const calls = [
      client.rpc('set_default_key', { p_user_id: userId, p_provider_id: testProviderId, p_key_id: testKeyId }),
      client.rpc('set_default_key', { p_user_id: userId, p_provider_id: testProviderId, p_key_id: testKeyId2 })
    ]
    const results = await Promise.allSettled(calls)
    const successes = results.filter(r => r.status === 'fulfilled' && r.value?.data?.ok === true)
    const failures = results.filter(r => r.status === 'fulfilled' && r.value?.data?.ok === false)

    // 验证：恰好 1 个默认（partial unique index + FOR UPDATE 串行化保证）
    const { data: keys } = await client.from('provider_keys')
      .select('*').eq('owner_user_id', userId)
      .eq('provider_id', testProviderId).in('id', [testKeyId, testKeyId2])
    const defaults = keys.filter(k => k.is_default)
    const errors = results.filter(r => r.status === 'rejected')

    if (defaults.length !== 1) {
      throw new Error(`期望恰好 1 个默认，实际 ${defaults.length} 个（成功 RPC: ${successes.length}, 失败 RPC: ${failures.length}, 异常: ${errors.length}）`)
    }
    console.log(`    默认账号: ${defaults[0].id.slice(0, 8)}...，RPC 返回成功 ${successes.length}`)
  })()

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // Test 5: reconcile_consume_and_finalize — 并发不重复扣费
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  console.log('── Test 5: reconcile_consume_and_finalize 并发 ──')
  await test('同一 job 并发 reconcile 只扣一次', async () => {
    await ensureLedger(testKeyId, 20)
    await client.from('quota_ledger').update({ used: 0, remaining: 20 })
      .eq('date', today).eq('owner_user_id', userId)
      .eq('provider_id', testProviderId).eq('account_key_id', testKeyId)

    // 创建测试 job（已删除再新建）
    const jobId = crypto.randomUUID()
    await client.from('jobs').insert({
      id: jobId, user_id: userId, provider_id: testProviderId,
      account_id: testKeyId, mode: 'text2video', status: 'success',
      cost_unit: '点', cost_amount: 2
    })

    // 并发 reconcile（advisory lock 串行化同一 job_id）
    const CONCURRENT = 5
    const calls = Array.from({ length: CONCURRENT }, () =>
      client.rpc('reconcile_consume_and_finalize', {
        p_user_id: userId, p_provider_id: testProviderId,
        p_amount: 2, p_key_id: testKeyId, p_date: today,
        p_job_id: jobId
      })
    )
    const results = await Promise.allSettled(calls)
    const consumed = results.filter(r => r.status === 'fulfilled' && r.value?.data?.ok && r.value?.data?.code !== 'ALREADY_FINALIZED').length
    const skipped  = results.filter(r => r.status === 'fulfilled' && r.value?.data?.code === 'ALREADY_FINALIZED').length

    // 验证：used 正好 = 2（只扣一次）
    const { data: row } = await client.from('quota_ledger')
      .select('*').eq('date', today).eq('owner_user_id', userId)
      .eq('provider_id', testProviderId).eq('account_key_id', testKeyId).single()
    if (Number(row.used) !== 2) {
      throw new Error(`期望 used=2（只扣一次），实际 used=${row.used}（扣了 ${consumed} 次，跳过 ${skipped} 次）`)
    }

    // 验证：恰好 1 条 finalize 记录
    const { data: ops } = await client.from('quota_operations')
      .select('*').eq('job_id', jobId).eq('operation_type', 'finalize')
    if (ops.length !== 1) throw new Error(`期望 1 条 finalize 记录，实际 ${ops.length} 条`)

    console.log(`    扣减 ${consumed} 次，跳过 ${skipped} 次，used=${row.used}，finalize 记录 ${ops.length} 条`)
  })()

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // 清理
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  console.log('\n── 清理 ──')
  await cleanup()
  console.log('  测试数据已删除')

  // ── 结果 ──────────────────────────────────────────────
  console.log('\n══════════════════════════════════════════════')
  console.log(`  通过: ${passed}  |  失败: ${failed}  |  总计: ${passed + failed}`)
  console.log('══════════════════════════════════════════════')

  if (failed > 0) process.exit(1)
}

main().catch(e => {
  console.error('\n❌ 测试异常:', e.message)
  process.exit(1)
})
