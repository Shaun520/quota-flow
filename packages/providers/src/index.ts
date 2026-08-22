// Provider 注册表：所有适配过的厂商在这里统一暴露，供 Router 与 CLI 调用

import { BaseProvider } from "@quota-flow/core";
import { YuanbaoProvider } from "./yuanbao";
import { QwenWanProvider } from "./qwen";

// 导出 API 型厂商的凭据处理函数（decode/test/fetch-quota 等），供桌面端主进程直接复用。
// 注意：保持在源码层再导出（不要只存在于已构建的 dist），否则 rebuild 会把这些导出打穿。
export * from "./zhipu";
export * from "./volcengine";
export * from "./bailian";
export * from "./tokenhub";

export interface ProviderFactoryOptions {
}

/** 实例化所有已接入的 provider */
export function createAllProviders(
  options: ProviderFactoryOptions = {},
): BaseProvider[] {
  const providers: BaseProvider[] = [];
  providers.push(new QwenWanProvider());
  // TODO: 接入 seedance (豆包)
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
