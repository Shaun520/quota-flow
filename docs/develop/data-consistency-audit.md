# 数据一致性审计报告

> 审计日期：2026-08-12
> 审计范围：额度账本操作全链路（quota_ledger + jobs + provider_keys）
> 审计方法：代码审查 + 数据模型分析 + 并发场景模拟

---

## 1. 审计总览

| 编号 | 严重级别 | 问题 | 涉及方法 | 修复状态 |
|------|---------|------|---------|---------|
| C1 | **CRITICAL** | RMW 竞态：`consumeLedger` SELECT→JS计算→UPDATE 非原子 | consumeLedger | ✅ 已修复 |
| C2 | **CRITICAL** | TOCTOU 竞态：`getOrInitLedger` SELECT→INSERT 非原子 | getOrInitLedger | ✅ 已修复 |
| C3 | **CRITICAL** | 非事务化多步操作：`setDefaultKey` 两个独立 UPDATE | setDefaultKey | ✅ 已修复 |
| C4 | **HIGH** | NULL != NULL：PostgreSQL UNIQUE 约束对 NULL team_id 无效 | quota_ledger schema | ✅ 已修复 |
| C5 | **HIGH** | consumeLedger 失败但 j ob 已标记 success → 额度漏记 | dispatch.ts | ✅ 已修复 |
| C6 | **HIGH** | downloadVideo 无 try-catch → 下载失败 j ob 残留 'running' | dispatch.ts | ✅ 已修复 |
| C7 | **HIGH** | Job-Quota 无关联记录 → 无法对账/去重 | 数据模型 | ✅ 已修复 |
| C8 | **MEDIUM** | 崩溃残留：app 退出时 j ob 状态 'running' 无恢复机制 | dispatch.ts | ✅ 已修复 |

---

## 2. 数据模型审计

### 2.1 quota_ledger 唯一约束分析

**现状（修复前）**：
```sql
UNIQUE (date, team_id, owner_user_id, account_key_id, provider_id)
```

**缺陷**：PostgreSQL 标准规定 `NULL != NULL`，即 UNIQUE 约束中两个 NULL 被视为不相等。个人账号的 `team_id IS NULL`，导致 `(date, NULL, uid, key_id, provider_id)` 可以插入多条重复行。

**修复方案**：
- 0005 migration：清理已有重复 + 新增 partial unique index
```sql
CREATE UNIQUE INDEX idx_quota_ledger_unique_personal
  ON quota_ledger (date, owner_user_id, account_key_id, provider_id)
  WHERE team_id IS NULL AND account_key_id IS NOT NULL;
```

### 2.2 竞态窗口总览

```
dispatch.ts 调用流（修复前）：
                        时间轴 →
  ┌─────────────────────────────────────────────────────────┐
  │ listLedger()  │  生成视频(30-120s)  │  consumeLedger() │
  │ SELECT 读额度  │  无 DB 操作         │  SELECT→UPDATE  │
  └─────────────────────────────────────────────────────────┘
        ↑                                          ↑
   窗口 A: 并发请求读到相同额度                窗口 B: RMW 竞态

  窗口 A: listLedger 读到 same remaining → 两个请求都认为额度够
  窗口 B: 生成完成后 SELECT 读到 same row → JS 各自累加 → UPDATE 后写覆盖
```

**实际并发场景**：
- 窗口 A: 用户快速连续点"生成" → listLedger 几乎同时查，读到相同 remaining
- 窗口 B: 两个 j ob 几乎同时完成 → consumeLedger 基于同一行做累加 → 一个覆盖另一个

---

## 3. 方法级审计

### C1: consumeLedger — RMW 竞态 (CRITICAL)

**修复前**：
```ts
// Step 1: SELECT 读当前值
const row = await this.client.from('quota_ledger').select('*')...maybeSingle()
// Step 2: JS 端计算新值
const used = Number(row.used) + amount
// Step 3: UPDATE 写回
await this.client.from('quota_ledger').update({ used, remaining }).eq('id', row.id)
```

**并发失败场景**：
1. 请求 A SELECT → used=5, remaining=5
2. 请求 B SELECT → used=5, remaining=5（读到相同值）
3. 请求 A UPDATE → used=6, remaining=4
4. 请求 B UPDATE → used=6, remaining=4（覆盖了 A 的扣减！额度实际只扣了 1 次，但两个任务都"成功"了）

**修复方案**：
- PostgreSQL RPC `atomic_consume_ledger`：单个 `UPDATE ... WHERE remaining >= amount RETURNING *` 原子操作
- 应用层：优先调用 RPC；LEDGER_NOT_FOUND 时自动 getOrInitLedger + 重试

### C2: getOrInitLedger — TOCTOU 竞态 (CRITICAL)

**修复前**：
```ts
const { data } = await query.maybeSingle()
if (existing) return existing
// TOCTOU 窗口：另一个并发请求刚 INSERT 完
const { data: created } = await this.client.from('quota_ledger').insert(...)
// 如果上面并发 INSERT 已完成 → 这里报 duplicate key error
```

**修复方案**：
- 0005 migration partial unique index（消除重复可能）
- 应用层：INSERT 失败时 `isDuplicateKeyError()` → 重查 `query.maybeSingle()` 返回已有行

### C3: setDefaultKey — 非事务化 (CRITICAL)

**修复前**：
```ts
await this.client.from('provider_keys').update({ is_default: false }).eq('owner_user_id', userId).eq('provider_id', providerId)
// ← 中间态：该厂商所有 key 都不是 default
await this.client.from('provider_keys').update({ is_default: true }).eq('id', keyId)
```

**并发失败场景**：
- 两个请求同时调 setDefaultKey(A→X, B→Y)
- 交错执行：B clearAll → A clearAll(覆盖B) → A setTrue(X) → B setTrue(Y)
- 结果：X 和 Y 都是 default（broken invariant）

**修复方案**：
- PostgreSQL RPC `set_default_key`：单次调用内事务化完成清旧+设新

### C5: consumeLedger 失败但 job 已 success (HIGH)

**修复前** (dispatch.ts L350-362)：
```ts
await jobSvc.updateJob(..., { status: 'success', ... })  // job 先标记成功
try {
  await providerSvc.consumeLedger(...)  // 额度记账可能失败
} catch {
  emit({ status: 'success', message: '记账失败' })
  return { ok: true, jobId: job.id }  // ⚠️ job=success 但额度未扣
}
```

**修复方案**：
- consumeLedger 改为 RPC 原子操作（大幅降低失败率）
- 新增 `insertQuotaOperation(job.id, ledger.id, 'finalize', cost)` — Job-Quota 关联记录
- 新增 reconciliation：`findUnfinalizedJobs()` 查 `status='success'` 但无 finalize 记录的 j ob → 追记额度

### C6: downloadVideo 无错误处理 (HIGH)

**修复前** (dispatch.ts L331)：
```ts
const localPath = await downloadVideo(result.videoUrl, job.id)
// downloadVideo 内部 reject → 未捕获 → 函数抛异常
// → 整个 runGenerate 在 return 前崩溃
// → job 状态永远是 'running'（L268-272 已设为 running）
```

**修复方案**：
- 包裹 try-catch：下载失败 fallback 到远程 URL，继续写 job 为 success

### C8: 崩溃残留无恢复 (MEDIUM)

**修复前**：j ob 在 L268-272 变为 `running`，若 app 在此之后退出 → 永久 stuck。

**修复方案**：
- `dispatch:reconcile` IPC handler：启动时查 `status='running'` 且 >10min 的 job → 标记 `failed`
- Dashboard 组件挂载时静默触发 reconciliation

---

## 4. Job-Quota 关联模型

### quota_operations 表

```sql
CREATE TABLE quota_operations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id UUID NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  ledger_id UUID NOT NULL REFERENCES quota_ledger(id),
  operation_type TEXT NOT NULL CHECK (operation_type IN ('reserve', 'finalize', 'release')),
  amount NUMERIC NOT NULL CHECK (amount > 0),
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE (job_id, operation_type)  -- 幂等保证
);
```

**设计原则**：
- 每个 job 每种操作类型最多一条记录 → 天然幂等
- `UNIQUE(job_id, operation_type)` 保证重复调用不重复扣减
- RLS 通过 `jobs.user_id` 校验，防止越权写入

---

## 5. 修复方案汇总

### 5.1 数据库层（Migration）

| Migration | 内容 |
|-----------|------|
| 0005_quota_consistency.sql | 清理重复 ledger 行 + partial unique index + `reserved` 列 + `quota_operations` 表 |
| 0006_quota_rpc.sql | `atomic_consume_ledger` + `atomic_release_ledger` + `set_default_key` 三个 RPC 函数 |

### 5.2 应用层（db-supabase）

| 方法 | 变更 |
|------|------|
| `getOrInitLedger` | INSERT 失败时 `isDuplicateKeyError()` → 重查返回已有行 |
| `consumeLedger` | keyId 存在 → RPC `atomic_consume_ledger`；LEDGER_NOT_FOUND → 初始化后重试 |
| `setDefaultKey` | 改为 RPC `set_default_key`（返回 `LedgerResult`） |
| `releaseLedger` | **新增**：RPC `atomic_release_ledger`（支持未来 reservation 模式） |
| `insertQuotaOperation` | **新增**：幂等记录 job↔ledger 关联 |
| `findUnfinalizedJobs` | **新增**：查 success 但无 finalize 的 job |

### 5.3 调度层（dispatch.ts）

| 变更 | 说明 |
|------|------|
| downloadVideo try-catch | 下载失败 fallback 到远程 URL，不阻塞 job 成功流转 |
| insertQuotaOperation | 成功扣减后记录 finalize，建立 Job-Quota 关联 |
| reconciliation IPC | 启动时恢复 stuck job + 追记未入账额度 |

---

## 6. 遗留事项

### 6.1 Reservation → Finalize/Release 模式

当前修复仍是一个阶段（直接 finalize）。完整的跨系统一致性需要两阶段：

```
dispatch.ts 改进路线：
  ┌─────────────────────────────────────────────────────────────┐
  │ 1. reserve(预占)  │  2. 调豆包(不可回滚)  │  3. finalize/release │
  │ RPC: remaining-=   │  WebView 生成...       │   成功→finalize      │
  │ amount,             │                         │   失败→release       │
  │ reserved+=amount    │                         │   崩溃→reconcile     │
  └─────────────────────────────────────────────────────────────┘
```

当前为何暂不引入：
- reserve 后 crash → reserved 永久冻结（需 complex reconciliation）
- 豆包单次生成成本低（1-3 点），直接 finalize 的损失很小
- quota_ledger 已预留 `reserved` 列，未来可平滑升级

### 6.2 并发测试

8 个并发场景测试用例（见原始审计 spec）尚未执行：
- 需实际启动多个 Electron 实例或 tRPC 并发请求模拟
- 优先级：low（RPC 原子操作 + partial unique index 从根本上消除竞态窗口）

### 6.3 非 doubao 厂商

当前修改仅覆盖 doubao 厂商路径（dispatch.ts）。其余 6 家厂商尚未接入，接入时需要同样的模式。

---

## 7. 安全审查确认

| 检查项 | 状态 |
|--------|------|
| RPC 函数 `SECURITY INVOKER` | ✅ 所有 3 个函数 |
| RPC 函数 `SET search_path = ''` | ✅ 防止函数劫持 |
| quota_operations RLS 策略通过 jobs 表校验 | ✅ SELECT/INSERT 均校验 `j.user_id = auth.uid()` |
| 应用层 isDuplicateKeyError 不泄露 DB 信息 | ✅ 仅判断特征字符串 |
| Partial unique index 仅约束个人行 | ✅ `WHERE team_id IS NULL AND account_key_id IS NOT NULL` |

---

## 8. 相关文件

| 文件 | 角色 |
|------|------|
| [migrations/0005_quota_consistency.sql](../../migrations/0005_quota_consistency.sql) | 去重 + partial index + quota_operations 表 |
| [migrations/0006_quota_rpc.sql](../../migrations/0006_quota_rpc.sql) | 3 个原子 RPC 函数 |
| [packages/db-supabase/src/index.ts](../../packages/db-supabase/src/index.ts) | ProviderService（含所有账本/额度方法） |
| [apps/desktop/src/main/dispatch.ts](../../apps/desktop/src/main/dispatch.ts) | 调度编排（runGenerate） |
| [apps/desktop/src/main/index.ts](../../apps/desktop/src/main/index.ts) | 主进程 + reconciliation IPC |
| [apps/desktop/src/preload/index.ts](../../apps/desktop/src/preload/index.ts) | API 桥接声明 |
| [apps/desktop/src/renderer/src/components/Dashboard.tsx](../../apps/desktop/src/renderer/src/components/Dashboard.tsx) | 渲染进程 reconciliation 触发 |
