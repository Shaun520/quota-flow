// 智能路由 + 调度执行：综合"模式支持度 + 剩余额度 + 质量分 + 成本"选出 provider，
// 并执行最多 fallbackMaxRounds 轮降级重试。

import type {
  GenerateOptions,
  GenerateResult,
  QuotaLedger,
  RoutingStrategy,
} from "./types";
import { consume, effectiveStatus, loadLedger, remaining, saveLedger } from "./ledger";
import { BaseProvider } from "./base";

export interface DispatchOptions {
  /** 选路策略，默认 quality_first（有额度的情况下优先质量） */
  strategy?: RoutingStrategy;
  /** 失败降级重试最大轮数，默认 2（共尝试 3 家） */
  fallbackMaxRounds?: number;
  /** 单个 provider 失败后冷却分钟数，默认 10 */
  coolDownMinutesOnFail?: number;
  /** 指定只用某一家 provider（调试用） */
  preferredProviderId?: string;
}

export interface DispatchResult {
  result: GenerateResult | null;
  attempts: Array<{
    providerId: string;
    ok: boolean;
    errorMessage?: string;
  }>;
  rounds: number;
  ledgerSnapshot: QuotaLedger;
}

const DEFAULT_ROUNDS = 2;
const DEFAULT_COOLDOWN = 10;

export class Router {
  constructor(
    private readonly providers: BaseProvider[],
  ) {}

  /** 选一家 provider，返回 id 与选择理由 */
  pick(
    ledger: QuotaLedger,
    options: GenerateOptions,
    strategy: RoutingStrategy = "quality_first",
    preferredId?: string,
    excludeIds: string[] = [],
  ): { providerId: string | null; reason: string } {
    const providerMap = new Map<string, BaseProvider>();
    for (const p of this.providers) providerMap.set(p.id, p);

    const candidates = this.providers
      .filter((p) => p.supports(options.mode))
      .filter((p) => !excludeIds.includes(p.id))
      .map((p) => {
        const status = effectiveStatus(ledger, p.id);
        const rem = remaining(ledger, p.id) ?? 0;
        const cap = p.capabilities;
        const estCost = p.estimateCost(options);
        return { id: p.id, status, rem, cap, estCost, preferred: p.id === preferredId };
      });

    if (candidates.length === 0) {
      return { providerId: null, reason: "no provider supports the requested mode" };
    }

    // 1) 优先 preferred
    if (preferredId) {
      const pf = candidates.find((c) => c.id === preferredId);
      if (pf && pf.rem > 0) {  // force: 有额度就用，不受 degraded 限制
        return { providerId: pf.id, reason: `preferred=${preferredId} (force, status=${pf.status})` };
      }
    }

    const avail = candidates.filter(isAvailable);
    if (avail.length === 0) {
      return {
        providerId: null,
        reason: `all ${candidates.length} mode-compatible providers are unavailable (quota/cool/offline)`,
      };
    }

    switch (strategy) {
      case "available_first":
        return { providerId: avail[0].id, reason: "strategy=available_first" };
      case "cost_first":
        avail.sort((a, b) => a.estCost - b.estCost || b.rem - a.rem);
        return { providerId: avail[0].id, reason: "strategy=cost_first" };
      case "round_robin":
        // 简单按 (成功+失败) 累计使用次数最少者
        avail.sort((a, b) => {
          const ea = ledger.providers[a.id];
          const eb = ledger.providers[b.id];
          const ra = (ea?.totalSuccessful ?? 0) + (ea?.totalFailed ?? 0);
          const rb = (eb?.totalSuccessful ?? 0) + (eb?.totalFailed ?? 0);
          return ra - rb;
        });
        return { providerId: avail[0].id, reason: "strategy=round_robin" };
      case "quality_first":
      default:
        // 先按质量分降序，同分按剩余额度多者优先
        avail.sort((a, b) => b.cap.qualityScore - a.cap.qualityScore || b.rem - a.rem);
        return { providerId: avail[0].id, reason: "strategy=quality_first" };
    }
  }

  /** 执行一次完整调度：选路 + 调用 + 记账 + 可选降级重试 */
  async dispatch(options: GenerateOptions, dispatchOpts: DispatchOptions = {}): Promise<DispatchResult> {
    const strategy = dispatchOpts.strategy ?? "quality_first";
    const fallbackMaxRounds = dispatchOpts.fallbackMaxRounds ?? DEFAULT_ROUNDS;
    const coolDownMinutes = dispatchOpts.coolDownMinutesOnFail ?? DEFAULT_COOLDOWN;

    const ledger = loadLedger();
    const attempts: DispatchResult["attempts"] = [];
    const excludeIds: string[] = [];
    let lastResult: GenerateResult | null = null;
    let rounds = 0;

    const providerMap = new Map<string, BaseProvider>();
    for (const p of this.providers) providerMap.set(p.id, p);

    // eslint-disable-next-line no-constant-condition
    while (true) {
      const pick = this.pick(ledger, options, strategy, dispatchOpts.preferredProviderId, excludeIds);
      if (!pick.providerId) break;
      const p = providerMap.get(pick.providerId)!;

      const estCost = p.estimateCost(options);
      const res = await p.generate(options);
      lastResult = res;
      attempts.push({
        providerId: p.id,
        ok: res.ok,
        errorMessage: res.errorMessage,
      });

      if (res.ok) {
        const used = res.quotaUsed > 0 ? res.quotaUsed : estCost;
        consume(ledger, p.id, used, { success: true });
        saveLedger(ledger);
        break;
      }
      // 失败：失败扣 0.5 额度（避免错误滥用但不完全免费），并加入冷却
      consume(ledger, p.id, 0, { success: false, coolDownMinutes });
      excludeIds.push(p.id);
      saveLedger(ledger);

      rounds += 1;
      if (rounds > fallbackMaxRounds) break;
    }

    return { result: lastResult, attempts, rounds, ledgerSnapshot: ledger };
  }
}

type Candidate = {
  id: string;
  status: ReturnType<typeof effectiveStatus>;
  rem: number;
  estCost: number;
};

function isAvailable(c: Candidate): boolean {
  // not_found / offline / quota_exhausted / degraded 都视为不可用
  // active 才直接用
  return c.status === "active" && c.rem > 0;
}
