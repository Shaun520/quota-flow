import { describe, expect, it } from "vitest";
import { isVolcengineVideoFamilyName, jwtExpiryMs, volcGenTokenEstimate } from "./volcengine";

function makeJwt(payload: Record<string, unknown>): string {
  const b64url = (obj: unknown) =>
    Buffer.from(JSON.stringify(obj))
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
  return `${b64url({ alg: "none" })}.${b64url(payload)}.sig`;
}

describe("jwtExpiryMs", () => {
  it("解析 JWT 的 exp 并换算为毫秒", () => {
    expect(jwtExpiryMs(makeJwt({ exp: 1000 }))).toBe(1000000);
  });

  it("空/非法输入返回 null", () => {
    expect(jwtExpiryMs("")).toBeNull();
    expect(jwtExpiryMs("not-a-jwt")).toBeNull();
    expect(jwtExpiryMs(makeJwt({ foo: 1 }))).toBeNull();
  });
});

describe("volcGenTokenEstimate", () => {
  it("默认按 10s 预估（25000 token/s）", () => {
    expect(volcGenTokenEstimate()).toBe(250000);
  });

  it("按给定时长线性计算", () => {
    expect(volcGenTokenEstimate(6)).toBe(150000);
  });

  it("非法时长回退默认", () => {
    expect(volcGenTokenEstimate(0)).toBe(250000);
    expect(volcGenTokenEstimate(-1 as unknown as number)).toBe(250000);
  });
});

describe("isVolcengineVideoFamilyName", () => {
  it("命中 seedance / wan 家族", () => {
    expect(isVolcengineVideoFamilyName("doubao-seedance-1.0")).toBe(true);
    expect(isVolcengineVideoFamilyName("Wan")).toBe(true);
  });

  it("跳过其他家族", () => {
    expect(isVolcengineVideoFamilyName("seedream")).toBe(false);
  });
});