import { createAllProviders } from "./dist/index.mjs";

const providers = createAllProviders();
const zhipu = providers.find(p => p.id === "zhipu");
console.log("Found:", zhipu?.id, zhipu?.displayName);

// 测试默认（免费）
delete process.env.ZHIPU_MODEL;
console.log("默认(flash):", zhipu.estimateCost({}));

// 测试付费
process.env.ZHIPU_MODEL = "cogvideox-2";
console.log("cogvideox-2:", zhipu.estimateCost({}));

process.env.ZHIPU_MODEL = "cogvideox-3";
console.log("cogvideox-3:", zhipu.estimateCost({}));

delete process.env.ZHIPU_MODEL;
