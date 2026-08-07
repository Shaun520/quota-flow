// 额度账本：本地 JSON 存储，按日自动滚动，支持查询/扣减/刷新

import * as fs from "node:fs";
import * as path from "node:path";
import type { QuotaLedger, QuotaLedgerProviderEntry, ProviderStatus } from "./types";

export const LEDGER_PATH = path.resolve(__dirname, "..", "..", "..", "data", "ledger.json");

/** 每个 provider 的默认每日额度（估算，可后续按实际调整） */
export const DEFAULT_DAILY_QUOTA: Record<string, number> = {
  mathmind: 10,
  qwenwan: 5, // 通义万相：每日5次免费视频生成
  seedance: 0,
  yuanbao: 5,
};

function pad(n: number): string {
  return n < 10 ? `0${n}` : `${n}`;
}

/** 返回本地时区的 YYYY-MM-DD */
export function todayLocal(d = new Date()): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function ensureParentDir(file: string): void {
  const dir = path.dirname(file);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function emptyEntry(providerId: string, dailyQuota: number): QuotaLedgerProviderEntry {
  return {
    dailyQuota,
    used: 0,
    totalSuccessful: 0,
    totalFailed: 0,
    status: dailyQuota > 0 ? "active" : "offline",
    asOfDate: todayLocal(),
  };
}

function emptyLedger(): QuotaLedger {
  const providers: Record<string, QuotaLedgerProviderEntry> = {};
  for (const [id, q] of Object.entries(DEFAULT_DAILY_QUOTA)) {
    providers[id] = emptyEntry(id, q);
  }
  return {
    version: 1,
    updatedAt: new Date().toISOString(),
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    providers,
  };
}

/** 读取账本；不存在则创建并写入默认 */
export function loadLedger(): QuotaLedger {
  ensureParentDir(LEDGER_PATH);
  if (!fs.existsSync(LEDGER_PATH)) {
    const init = emptyLedger();
    fs.writeFileSync(LEDGER_PATH, JSON.stringify(init, null, 2), "utf-8");
    return init;
  }
  try {
    const raw = fs.readFileSync(LEDGER_PATH, "utf-8");
    const parsed = JSON.parse(raw) as QuotaLedger;
    return normalizeLedger(parsed);
  } catch (err) {
    // 损坏则备份并重置
    const backup = `${LEDGER_PATH}.${Date.now()}.bak`;
    try {
      fs.copyFileSync(LEDGER_PATH, backup);
    } catch {
      /* ignore */
    }
    const init = emptyLedger();
    fs.writeFileSync(LEDGER_PATH, JSON.stringify(init, null, 2), "utf-8");
    return init;
  }
}

export function saveLedger(ledger: QuotaLedger): void {
  ensureParentDir(LEDGER_PATH);
  ledger.updatedAt = new Date().toISOString();
  fs.writeFileSync(LEDGER_PATH, JSON.stringify(ledger, null, 2), "utf-8");
}

/** 对缺省字段补全，并按新的一日滚动重置额度 */
function normalizeLedger(parsed: QuotaLedger): QuotaLedger {
  const today = todayLocal();
  if (!parsed.providers) parsed.providers = {};
  // 补齐默认 provider
  for (const [id, q] of Object.entries(DEFAULT_DAILY_QUOTA)) {
    if (!parsed.providers[id]) {
      parsed.providers[id] = emptyEntry(id, q);
    } else {
      const e = parsed.providers[id];
      e.asOfDate ??= today;
      e.status ??= q > 0 ? "active" : "offline";
      e.used ??= 0;
      e.dailyQuota ??= q;
      e.totalSuccessful ??= 0;
      e.totalFailed ??= 0;
    }
  }
  if (!parsed.timezone) parsed.timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  if (!parsed.version) parsed.version = 1;
  return parsed;
}

/** 检查并刷新"按日"的额度。返回是否发生过刷新 */
export function maybeRollDaily(ledger: QuotaLedger): boolean {
  const today = todayLocal();
  let rolled = false;
  for (const entry of Object.values(ledger.providers)) {
    if (entry.asOfDate !== today) {
      const preservedDaily =
        DEFAULT_DAILY_QUOTA[entry.asOfDate /* placeholder to keep ref */] ?? entry.dailyQuota ?? 0;
      entry.asOfDate = today;
      entry.used = 0;
      entry.status = entry.dailyQuota > 0 ? "active" : "offline";
      entry.coolDownUntil = undefined;
      // 用最新默认额度覆盖（允许后续在 DEFAULT_DAILY_QUOTA 调优）
      for (const [id, e2] of Object.entries(ledger.providers)) {
        if (e2 === entry && DEFAULT_DAILY_QUOTA[id] != null) {
          e2.dailyQuota = DEFAULT_DAILY_QUOTA[id];
          e2.status = e2.dailyQuota > 0 ? "active" : "offline";
        }
      }
      void preservedDaily;
      rolled = true;
    }
  }
  return rolled;
}

/** 查询某 provider 剩余额度；返回 null 表示账本里无此 provider */
export function remaining(ledger: QuotaLedger, providerId: string): number | null {
  const e = ledger.providers[providerId];
  if (!e) return null;
  return Math.max(0, e.dailyQuota - e.used);
}

/** 是否已到冷却结束时间 */
export function isCooledDown(entry: QuotaLedgerProviderEntry): boolean {
  if (!entry.coolDownUntil) return true;
  return new Date(entry.coolDownUntil).getTime() <= Date.now();
}

/** 计算 provider 当前的实际可用状态（考虑冷却、日期滚动） */
export function effectiveStatus(
  ledger: QuotaLedger,
  providerId: string,
): ProviderStatus | "not_found" {
  const e = ledger.providers[providerId];
  if (!e) return "not_found";
  if (e.asOfDate !== todayLocal()) return e.dailyQuota > 0 ? "active" : "offline";
  if (!isCooledDown(e)) return "degraded";
  if (e.used >= e.dailyQuota && e.dailyQuota > 0) return "quota_exhausted";
  if (e.dailyQuota <= 0) return "offline";
  return e.status === "quota_exhausted" ? "active" : e.status;
}

/** 扣减额度。返回扣减后剩余，或 null 表示失败 */
export function consume(
  ledger: QuotaLedger,
  providerId: string,
  amount: number,
  opts?: { success?: boolean; coolDownMinutes?: number },
): number | null {
  const e = ledger.providers[providerId];
  if (!e) return null;
  e.used = Math.min(e.dailyQuota, (e.used ?? 0) + Math.max(0, amount));
  e.lastUsedAt = new Date().toISOString();
  if (opts?.success === true) e.totalSuccessful += 1;
  if (opts?.success === false) e.totalFailed += 1;
  if (opts?.coolDownMinutes && opts.coolDownMinutes > 0) {
    const until = new Date(Date.now() + opts.coolDownMinutes * 60 * 1000);
    e.coolDownUntil = until.toISOString();
    e.status = "degraded";
  } else if (e.used >= e.dailyQuota && e.dailyQuota > 0) {
    e.status = "quota_exhausted";
  } else {
    e.status = "active";
  }
  return e.dailyQuota - e.used;
}

/** 手动刷新：按默认额度重置当天 */
export function refreshToday(ledger: QuotaLedger): string[] {
  const today = todayLocal();
  const touched: string[] = [];
  for (const [id, q] of Object.entries(DEFAULT_DAILY_QUOTA)) {
    const e = (ledger.providers[id] ??= emptyEntry(id, q));
    e.asOfDate = today;
    e.dailyQuota = q;
    e.used = 0;
    e.status = q > 0 ? "active" : "offline";
    e.coolDownUntil = undefined;
    touched.push(id);
  }
  return touched;
}
