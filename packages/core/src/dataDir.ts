// 运行时数据根目录：全局 CLI/桌面端把账本、任务日志、cookie 凭据统一落在用户主目录，
// 避免写入安装目录（node_modules）不可写。可用 QUOTA_FLOW_DATA_DIR 环境变量覆盖。

import * as os from "node:os";
import * as path from "node:path";

/** 返回数据根目录（默认 ~/.quota-flow，可用 QUOTA_FLOW_DATA_DIR 覆盖） */
export function dataDir(): string {
  const override = process.env.QUOTA_FLOW_DATA_DIR;
  if (override && override.trim() !== "") return override.trim();
  return path.join(os.homedir(), ".quota-flow");
}

/** 返回数据根目录下的某个文件名 */
export function dataFile(name: string): string {
  return path.join(dataDir(), name);
}