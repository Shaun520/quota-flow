// 全链路验证：登录态（auth.json）→ Supabase 会话 → runGenerate（引擎+jobs+额度）→ 核对落库
import { app, safeStorage } from 'electron'
import { readFileSync, appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { createSupabaseClient, JobService, ProviderService } from '@quota-flow/db-supabase'
import { runGenerate } from '../src/main/dispatch'

const LOG_FILE = join(process.env.TEMP || '.', 'qf-dispatch-verify.log')

function log(k: string, v: unknown): void {
  const line = '[' + k + '] ' + (typeof v === 'string' ? v : JSON.stringify(v))
  console.log(line)
  try {
    appendFileSync(LOG_FILE, new Date().toISOString() + ' ' + line + '\n')
  } catch {}
}

function readEnv(): { url: string; anonKey: string } {
  const raw = readFileSync('D:/project/quota-flow/apps/desktop/.env', 'utf8')
  const env: Record<string, string> = {}
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(/^([A-Za-z0-9_]+)=(.*)$/)
    if (m) env[m[1]] = m[2].trim()
  }
  return { url: env['VITE_SUPABASE_URL'], anonKey: env['VITE_SUPABASE_ANON_KEY'] }
}

function readStoredSession(): { accessToken: string; refreshToken: string } | null {
  const file = join(process.env.APPDATA || '', '@quota-flow', 'desktop', 'auth.json')
  try {
    const raw = readFileSync(file, 'utf8')
    const json = JSON.parse(safeStorage.decryptString(Buffer.from(raw.trim(), 'base64'))) as {
      accessToken: string
      refreshToken: string
    }
    return json
  } catch (e) {
    log('session-decrypt-fail', e instanceof Error ? e.message : String(e))
    return null
  }
}

app.whenReady().then(async () => {
  try {
    const env = readEnv()
    const sessionData = readStoredSession()
    if (!sessionData) {
      log('result', { ok: false, reason: 'auth.json 无法解密' })
      app.exit(0)
      return
    }
    log('session', { decrypted: true })

    const client = createSupabaseClient({ supabaseUrl: env.url, supabaseAnonKey: env.anonKey })
    await client.auth.setSession({
      access_token: sessionData.accessToken,
      refresh_token: sessionData.refreshToken
    })
    const { data: userData, error: userError } = await client.auth.getUser()
    if (userError || !userData?.user) {
      log('result', { ok: false, reason: '会话恢复失败: ' + (userError ? userError.message : 'no user') })
      app.exit(0)
      return
    }
    const userId = userData.user.id
    log('user', userId)

    const providerSvc = new ProviderService(client)
    const jobSvc = new JobService(client)
    const keys = await providerSvc.listProviderKeys(userId)
    const doubaoKey = keys.find((k) => k.provider_id === 'doubao')
    log('provider-keys', {
      bound: keys.map((k) => k.provider_id),
      doubao: doubaoKey
        ? { id: doubaoKey.id, accountName: doubaoKey.account_name, health: doubaoKey.health_status }
        : null
    })
    const ledgerBefore = await providerSvc.listLedger(userId)
    log('ledger-before', ledgerBefore.map((l) => ({ provider: l.provider_id, used: l.used, remaining: l.remaining, total: l.daily_total })))

    log('generate-start', { prompt: '一只橘猫在窗台上晒太阳，微风吹动窗帘', durationSec: 5 })
    const res = await runGenerate(
      {
        supabaseUrl: env.url,
        supabaseAnonKey: env.anonKey,
        accessToken: sessionData.accessToken,
        refreshToken: sessionData.refreshToken,
        userId,
        prompt: '一只橘猫在窗台上晒太阳，微风吹动窗帘',
        providerId: 'doubao',
        durationSec: 5
      },
      (ev) => log('event', ev)
    )
    log('generate-result', res)

    if (res.jobId) {
      const jobs = await jobSvc.listJobs()
      const job = jobs.find((j) => j.id === res.jobId)
      log('job-final', job
        ? {
            id: job.id,
            status: job.status,
            resultUrl: job.result_url,
            costAmount: job.cost_amount,
            costUnit: job.cost_unit,
            error: job.error,
            options: job.options
          }
        : null)
    }
    const ledgerAfter = await providerSvc.listLedger(userId)
    log('ledger-after', ledgerAfter.map((l) => ({ provider: l.provider_id, used: l.used, remaining: l.remaining, total: l.daily_total })))
  } catch (e) {
    log('fatal', e instanceof Error ? e.stack || e.message : String(e))
  }
  app.exit(0)
})

setTimeout(() => {
  log('fatal', '总时长超时')
  app.exit(3)
}, 8 * 60 * 1000)
