# 智能调度时长优化方案

## Summary

- 问题根因：桌面端 `durationOptions()` 对 `provider === 'auto'` 没有做时长收敛，当前默认仍返回 `5s / 10s / 15s`，而实际执行链路只支持豆包，豆包只支持 `5s / 10s`。
- 方案：把“厂商支持时长”做成数据库驱动的能力字段，桌面端智能调度只展示所有“已绑定且启用”厂商都支持的时长交集。
- 当前只绑定豆包时，智能调度只显示 `5s` 和 `10s`，不再出现 `15s`。

## Key Changes

### 数据

- 新增迁移 `migrations/0012_provider_duration_capabilities.sql`，给 `providers.capabilities` 写入 `supported_durations`。
- 豆包固定为 `[5, 10]`；其他厂商默认也按当前实际支持范围保守配置，未确认支持 `15s` 的一律不配置 `15`。
- 如果后续厂商支持 `15s`，由 admin 修改对应 `providers.capabilities.supported_durations`，桌面端刷新后自动生效。

### 桌面端能力读取

- `useProviders` 的 `ProviderAgg` 增加 `durations: number[]`，从 `ProviderMeta.capabilities.supported_durations` 解析；字段缺失时默认 `[5, 10]`，避免旧数据又漏出 15s。
- `Dashboard.tsx` 根据已绑定且启用厂商的 `durations` 计算“智能调度可选时长交集”。

### 调度台 UI

- `durationOptions()` 增加可选 `supportedDurations` 入参；显式选择某个厂商时用该厂商能力，`auto` 时用已绑定且启用厂商的交集。
- 时长选择后如果当前值不在候选列表里，自动回退到最后一个合法值，例如从 15s 回退到 10s。
- 智能调度当前实际仍走豆包执行，所以 `auto` 的预计额度按豆包规则展示：5s = 1 点，10s = 2 点，不再显示成默认“1 次”。

### 主进程兜底

- 在 `dispatch.ts` 创建任务前校验 `durationSec` 是否在目标厂商 `capabilities.supported_durations` 内；不支持时直接返回明确错误，避免绕过 UI 后仍提交 15s。
- 本次不新增多厂商真实调度，`auto` 仍解析为豆包执行；只把时长能力收紧到正确范围。

## Test Plan

- 执行迁移后，确认 `doubao` 的 `capabilities.supported_durations = [5, 10]`。
- 桌面端 `auto` 模式只显示 `5s / 10s`，没有 `15s`；显式选择豆包同样只显示 `5s / 10s`。
- 用开发工具或 IPC 强制提交 `durationSec: 15`，主进程应报“当前厂商不支持 15 秒”，任务不会进入生成阶段。
- 验证智能调度 5s、10s 正常生成并扣 1 点 / 2 点。
- 如果后续绑定第二个厂商且只支持 5s，则 `auto` 只显示 5s，确保交集逻辑生效。
- 运行 `pnpm --filter @quota-flow/desktop typecheck`。

## Assumptions

- 智能调度当前只执行豆包，不在此次方案里扩展为真正多厂商自动选择。
- “支持时长”以 `providers.capabilities.supported_durations` 为准，不再靠前端硬编码 `[5, 10, 15]`。
- 已有 `provider_cost_tables` 继续负责扣费规则，不改成时长选项数据源；本次只加能力字段用于 UI 和提交校验。
