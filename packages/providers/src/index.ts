// Provider 注册表：所有适配过的厂商在这里统一暴露，供 Router 与 CLI 调用

import { BaseProvider } from "@quota-flow/core";
import { MathmindProvider, MathmindDryRunContext } from "./mathmind";
import { YuanbaoProvider } from "./yuanbao";
import { QwenWanProvider } from "./qwen";

export interface ProviderFactoryOptions {
  /** 用于 dry-run 模式下累积 mathmind 调用指令 */
  mathmindCtx?: MathmindDryRunContext;
}

/** 实例化所有已接入的 provider */
export function createAllProviders(
  options: ProviderFactoryOptions = {},
): BaseProvider[] {
  const providers: BaseProvider[] = [];
  providers.push(new MathmindProvider(options.mathmindCtx));
  providers.push(new QwenWanProvider());
  // TODO: 接入 seedance (豆包即梦)
  // providers.push(new SeedanceProvider(options));
  providers.push(new YuanbaoProvider());
  return providers;
}

/** 按 id 快速索引 */
export function toProviderMap(providers: BaseProvider[]): Map<string, BaseProvider> {
  const map = new Map<string, BaseProvider>();
  for (const p of providers) map.set(p.id, p);
  return map;
}

export { BaseProvider };
export type { MathmindDryRunContext } from "./mathmind";

