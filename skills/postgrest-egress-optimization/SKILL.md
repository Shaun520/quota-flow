---
name: "postgrest-egress-optimization"
description: "降低 Supabase/PostgREST 出口流量(Egress)与请求量的排查落地方法论。用户反馈流量超额、请求数过高、查询慢、或要做数据库访问优化时调用。"
---

# PostgREST Egress 优化

沉淀「以最少读库换取功能不变」的通用方法论。目标：把稳态请求量压下去，同时保证数据新鲜度。

## 何时使用
- 用户报告 PostgREST/Auth Egress 超额、请求数(SBUs)过高、或单日流量异常上涨
- 新写任何列表页 / 历史 / 账号 / 额度查询前，先按本规范评估会不会重复打库
- 接到「查询慢 / 超时」问题需排查高频读时

## 核心原则
1. **能少发一次就少发一次**：先识别哪些读是重复的，再去想怎么缓存/去重，而不是先改 SQL。
2. **稳态靠正缓存 + 降轮询，突发靠 in-flight 去重 + SQL 下推**。两档问题手段不同，别混用。
   - 第一档「5 万次请求数」由高频重复调用决定 → 用会话级正缓存 / 降轮询才压得动。
   - 第二档「单次全表/大字段」由一次查询回传量决定 → 用显式字段 + SQL 过滤下推。
3. **一切缓存都必须有显式失效点**：写点成功后失效、登出/换账号全清，不依赖 TTL 兜新鲜。
4. 禁止默认 `select('*')` 或 `select()`；一律显式列出字段。
5. 默认不下发大字段和密钥：`encrypted_key`、`options`、`attempts`、`cost_breakdown` 等按需再取。
6. 列表必须服务端分页/搜索/筛选，禁止无 limit 全量拉取；Admin 下拉用轻量 option 查询，禁止 `pageSize: 1000`。

## 排查步骤
1. 在 Supabase Dashboard → Database → Query Insights / Performance 看 Top 查询与读计数字段。
2. 用 `pg_stat_user_tables`（读次数）找高频表，用 `pg_stat_statements`（单次返回行数/耗时）找全表/大字段查询。
3. 对每个热点读分类：
   - 同参、并发窗口内重复 → **in-flight 读去重**（不落缓存，落定即删）。
   - 跨调用、跨模块、T秒内多次 → **会话级 TTL 正缓存**，且登记写点用于失效。
   - 轮询类 → **降频** 或 **增量拉取**（`updated_at > lastSync`）/ **Realtime**。
   - 一次回传过大 → **字段裁剪 + 过滤下推到 SQL**。
4. 改完用 `typecheck` 验证，并对比前后 Egress/请求数。

## 落地范式

### 1. 跨模块 in-flight 读去重（并发窗口）
只共享「完全相同参数」的并发读；落定即删，不做正缓存（适合易变数据）。

```ts
const readInFlight = new Map<string, Promise<unknown>>()
function dedupeRead<T>(key: string, fetch: () => Promise<T>): Promise<T> {
  const pending = readInFlight.get(key)
  if (pending) return pending as Promise<T>
  const p = fetch().finally(() => readInFlight.delete(key))
  readInFlight.set(key, p)
  return p
}
```

### 2. 会话级 TTL 正缓存 + 写点显式失效
适合低频变化数据（权限开关、团队归属、账号密钥列表）。固定范式：
- 分区 key 形如 `{kind}:{scopeId}:{providerId}`，含具体维度与全量两种。
- 维护「业务主键 → 分区集合」反查索引，写点只要拿到主键即可定位失效分区。
- 提供三件套：`invalidateByKeyId`（反查）、`invalidateByScope`（整 owner 前缀清）、`clearAll`（登出/换账号）。
- 访问入口封装真实读取，命中 TTL 直接返回缓存，不持有 client（命中零请求）。

```ts
function invalidateByKeyId(id: string) {
  for (const pk of [...keyToPartitions.get(id) ?? []]) evictPartition(pk) // 连反查一起清
}
```

### 3. SQL 过滤下推
不要在内存里筛掉大字段行；把过滤条件写进查询，只回传目标行。例如按厂商筛选密钥，代替「整表拉回再 filter」。

## 重要提醒
- TTL 设多大都行，但**新鲜度靠写点失效保证**，TTL 只是兜底。每个写点必须配失效，否则缓存会给出陈旧选号/权限。
- 缓存如果跨进程（主进程缓存 vs 渲染进程直写 DB），要建 IPC 让写测通知缓存进程失效；登出全清。
- 缓存只存结果数据与反查索引，不要持有连接/client，避免悬空与泄漏。
- Skill 内容为通用方法论，不含任何账号、密钥、URL 或具体业务数值。