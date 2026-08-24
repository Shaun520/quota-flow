import { describe, expect, it } from "vitest";
import {
  consume,
  effectiveStatus,
  isCooledDown,
  maybeRollDaily,
  remaining,
  todayLocal,
} from "./ledger";
import type { QuotaLedger, QuotaLedgerProviderEntry } from "./types";

function entry(over: Partial<QuotaLedgerProviderEntry>): QuotaLedgerProviderEntry {
  return {
    dailyQuota: 0,
    used: 0,
    totalSuccessful: 0,
    totalFailed: 0,
    status: "offline",
    asOfDate: todayLocal(),
    ...over,
  };
}

function ledger(providers: Record<string, QuotaLedgerProviderEntry>): QuotaLedger {
  return { version: 1, updatedAt: "", timezone: "Asia/Shanghai", providers };
}

describe("todayLocal", () => {
  it("把本地日期格式化为 YYYY-MM-DD", () => {
    expect(todayLocal(new Date(2026, 0, 5))).toBe("2026-01-05");
    expect(todayLocal(new Date(2026, 10, 30))).toBe("2026-11-30");
  });

  it("个位月/日前补零", () => {
    expect(todayLocal(new Date(2026, 0, 1))).toBe("2026-01-01");
  });
});

describe("remaining", () => {
  it("返回剩余额度 dailyQuota - used", () => {
    const l = ledger({ qwen: entry({ dailyQuota: 5, used: 2 }) });
    expect(remaining(l, "qwen")).toBe(3);
  });

  it("provider 不存在返回 null", () => {
    expect(remaining(ledger({}), "nope")).toBeNull();
  });

  it("超过额度时不为负数", () => {
    const l = ledger({ qwen: entry({ dailyQuota: 2, used: 5 }) });
    expect(remaining(l, "qwen")).toBe(0);
  });
});

describe("consume", () => {
  it("扣减额度并返回剩余", () => {
    const l = ledger({ qwen: entry({ dailyQuota: 5, used: 0 }) });
    expect(consume(l, "qwen", 3)).toBe(2);
    expect(l.providers.qwen.used).toBe(3);
  });

  it("provider 不存在返回 null", () => {
    expect(consume(ledger({}), "nope", 1)).toBeNull();
  });

  it("用满达到 quota_exhausted", () => {
    const l = ledger({ qwen: entry({ dailyQuota: 5, used: 0 }) });
    consume(l, "qwen", 5);
    expect(l.providers.qwen.status).toBe("quota_exhausted");
    expect(consume(l, "qwen", 1)).toBe(0);
  });

  it("成功/失败计次", () => {
    const l = ledger({ qwen: entry({ dailyQuota: 5, used: 0 }) });
    consume(l, "qwen", 1, { success: true });
    consume(l, "qwen", 1, { success: false });
    expect(l.providers.qwen.totalSuccessful).toBe(1);
    expect(l.providers.qwen.totalFailed).toBe(1);
  });
});

describe("effectiveStatus", () => {
  it("provider 不存在返回 not_found", () => {
    expect(effectiveStatus(ledger({}), "nope")).toBe("not_found");
  });

  it("当日未耗尽且活跃返回 active", () => {
    const l = ledger({ qwen: entry({ dailyQuota: 5, used: 1, status: "active" }) });
    expect(effectiveStatus(l, "qwen")).toBe("active");
  });

  it("冷却中返回 degraded", () => {
    const future = new Date(Date.now() + 10 * 60 * 1000).toISOString();
    const l = ledger({ qwen: entry({ dailyQuota: 0, used: 0, status: "degraded", coolDownUntil: future }) });
    expect(effectiveStatus(l, "qwen")).toBe("degraded");
  });
});

describe("isCooledDown", () => {
  it("无冷却时间视为已冷却", () => {
    expect(isCooledDown(entry({}))).toBe(true);
  });

  it("未来冷却时间未冷却", () => {
    const future = new Date(Date.now() + 5 * 60 * 1000).toISOString();
    expect(isCooledDown(entry({ coolDownUntil: future }))).toBe(false);
  });

  it("过去冷却时间已冷却", () => {
    const past = new Date(Date.now() - 1000).toISOString();
    expect(isCooledDown(entry({ coolDownUntil: past }))).toBe(true);
  });
});

describe("maybeRollDaily", () => {
  it("跨日时重置 used 返回 true", () => {
    const yesterday = "2020-01-01";
    const l = ledger({
      qwen: entry({ dailyQuota: 5, used: 5, status: "quota_exhausted", asOfDate: yesterday }),
    });
    expect(maybeRollDaily(l)).toBe(true);
    expect(l.providers.qwen.used).toBe(0);
    expect(l.providers.qwen.asOfDate).toBe(todayLocal());
  });

  it("当日无变动返回 false", () => {
    const l = ledger({ qwen: entry({ dailyQuota: 5, used: 2, status: "active" }) });
    expect(maybeRollDaily(l)).toBe(false);
  });
});