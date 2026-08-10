# 账号指纹去重方案（方案 A，P2）

> 状态：待实施（P2 设计稿，P1 不做自动去重）
> 日期：2026-08-10
> 适用范围：apps/desktop（Electron 主进程页面抓取）+ packages/db-supabase + migrations
> 关联文档：docs/develop/desktop-providers-system.md（厂商账号系统 P1）、docs/develop/desktop-auth-system.md
> 关联需求：REQUIREMENTS.md §5.7 / §5.8（provider_keys 表结构、RLS）

## 1. 背景与问题

P1 阶段用户可重复绑定同一账号（相同 cookie），产生重复条目。曾考虑「cookie 哈希去重」，经分析**不可行**：

| 场景 | cookie 哈希结果 | 期望 | 问题 |
|---|---|---|---|
| 同一 QQ 账号登录两次 | 哈希不同（session token 每次登录旋转、csrf/跟踪 cookie 变化） | 去重掉 | 漏判（false negative） |
| 同一厂商 QQ 与 WX 账号 | 哈希不同 | 都保留 | 正常 |
| 不同账号 cookie 子集碰撞 | 理论上可能相同 | 都保留 | 误判（false positive） |

结论：cookie 层无法区分「同一账号」，必须提取**账号级标识**（页面上的用户 ID / 手机号 / 邮箱 / 昵称等登录态信息）作为真正指纹。

## 2. 目标

- 绑定成功后自动提取账号指纹，绑定前查重：同一用户对**同一厂商同一账号**的重复绑定予以拦截/提示
- QQ 与 WX 等不同账号必须都能绑定，不得误去重
- 指纹不可恢复出登录凭证（只存摘要，不存明文标识）

## 3. 核心设计决策

### 3.1 指纹来源：登录后页面提取（已确认 ✅）

- 复用登录窗口（`persist:qf-p:<providerId>` partition），用户在登录窗口完成登录后，主进程在**同一窗口/隐藏窗口**加载厂商的「登录后页面」
- 通过 `webContents.executeJavaScript` 执行各厂商的提取脚本，从页面 DOM / 接口响应中取出账号标识
- 每厂商一个提取脚本（`ACCOUNT_FINGERPRINT_EXTRACTORS`），结构不同 → 分别写

### 3.2 指纹存储：哈希后落库（已确认 ✅）

- 提取到的明文标识**不进 renderer、不落库**：主进程内 `crypto.createHash('sha256')` 后存 `provider_keys.account_fingerprint`
- 指纹 = `sha256(<providerId> | <归一化标识>)`，归一化规则见 §5
- 反查：绑定新账号时，服务端按 `(owner_user_id, provider_id, account_fingerprint)` 查重复

### 3.3 去重语义：同用户同厂商同账号（已确认 ✅）

- 作用域 = `(owner_user_id, provider_id, account_fingerprint)`，**不含 team_id**：个人与团队共享同一指纹判断（同一物理账号）
- QQ 与 WX 标识不同 → 指纹不同 → 都可绑定
- 同一 QQ 二次绑定 → 指纹相同 → 拦截，提示「该账号已绑定，可在账号列表中解绑后重绑」

## 4. 表结构变更（迁移 0002）

```sql
ALTER TABLE provider_keys ADD COLUMN IF NOT EXISTS account_fingerprint TEXT;
CREATE INDEX IF NOT EXISTS idx_provider_keys_fp
  ON provider_keys (owner_user_id, provider_id, account_fingerprint);

-- 说明：不用 UNIQUE 约束，重复场景先拦截提示（可强制覆盖），避免误伤；
-- 如需硬约束：CREATE UNIQUE INDEX ... WHERE account_fingerprint IS NOT NULL;
```

- `account_fingerprint TEXT NULL`：apikey 型厂商（mathmind）指纹 = sha256(apikey 明文) 也可覆盖；暂无提取脚本的厂商保持 NULL（不参与查重）

## 5. 指纹提取脚本（每厂商一个）

### 5.1 通用约定

- 提取入口：`extract(): string | null`，返回归一化前的账号标识
- 归一化：trim、全角转半角、小写化（邮箱/昵称不区分大小写）
- 失败返回 `null` → 本次不写指纹，绑定照常成功（去重仅尽力而为，不阻断流程）
- 超时 10s；提取脚本出错仅记日志，不影响绑定

### 5.2 厂商提取点（初版占位，联调时逐个校准）

| 厂商 | 提取途径（候选） | 归一化说明 |
|---|---|---|
| 豆包 | 登录后页面个人中心显示手机号/头像旁昵称；或 `executeJavaScript` 抓取页面内 `userId` 字段 | 取手机号优先，其次 userId |
| 即梦 | 页面右上角账号入口抓昵称 / 绑定手机号 | 同上 |
| 通义万相 | 阿里系页面可抓 `loginId`（手机号/邮箱） | 小写化 |
| 元宝混元 | 腾讯系抓 openid / 页面昵称 | QQ 与 WX 的 openid 区分账号 |
| 可灵 | 个人中心手机号 / 用户 ID | 取手机号优先 |
| 海螺 | 个人中心手机号 / 邮箱 | 同上 |
| MathMind | apikey 直接作为标识（不抓页面） | sha256(apikey.trim()) |

> 联调方法论：绑定后手动开 DevTools 看登录后页面 DOM / Network 请求里承载账号标识的字段，定稿提取脚本并回填本表。

### 5.3 风险与兜底

- 页面结构改版 → 提取脚本失效 → 指纹为 NULL → 去重暂时失效（不报错、不阻断），P 级任务修复脚本
- 非浏览器环境（部分厂商要求扫码）→ 提取失败 → 同上兜底

## 6. 模块划分（实施清单）

### 6.1 主进程（apps/desktop/src/main/providers.ts）

```
provider:login
  └─ 登录完成 → 若该厂商有提取脚本：
       executeJavaScript(script) → 归一化 → sha256 → 随结果返回 accountFingerprint
       （指纹仅主进程计算，renderer 只透传字符串）
```

新增：
- `ACCOUNT_FINGERPRINT_EXTRACTORS: Partial<Record<ProviderId, { pageUrl: string; script: string }>>`
- `extractAccountFingerprint(providerId): Promise<string | null>`

### 6.2 packages/db-supabase

```ts
// AddProviderKeyInput 增加
accountFingerprint?: string | null

// 新增
findDuplicateFingerprint(userId, providerId, fingerprint): Promise<boolean>
// 或 addProviderKey 内部先查：
//   SELECT 1 FROM provider_keys
//   WHERE owner_user_id=$1 AND provider_id=$2 AND account_fingerprint=$3
```

### 6.3 renderer（AddProviderModal）

```ts
保存前：
  const dup = await svc.findDuplicateFingerprint(userId, providerId, res.accountFingerprint)
  if (dup) → setError('该账号已绑定（检测到相同账号指纹），可先解绑再重新绑定')
            → 不写库
```

- 弹窗提示文案区分「账号相同」与「一般失败」；提供「强制绑定」二次确认（可选，P2 末再定）

## 7. 验收用例

| 用例 | 操作 | 期望 |
|---|---|---|
| 同账号去重 | 元宝登录 QQ → 再次登录 QQ | 第二次被拦截，提示已绑定 |
| 异账号不误伤 | 元宝登录 QQ | 元宝登录 WX | 两次都成功，列表 2 个绑定 |
| 提取失败兜底 | 提取脚本失效的厂商 | 绑定成功，指纹 NULL，去重跳过 |
| apikey 去重 | MathMind 重贴同一 apikey | 被拦截（sha256(apikey) 相同） |
| 解绑后重绑 | 解绑 QQ → 重新绑定 QQ | 指纹行已删，绑定成功 |

## 8. 与 P1 的关系

- P1 不做自动去重，仅保留「绑定前提示该厂商已有 N 个绑定」的弱提示（低成本防误操作）
- 本方案作为 P2 独立阶段实施，不依赖 P1 结构变更；迁移 0002 与主进程提取脚本可先行开发