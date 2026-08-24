import { describe, expect, it } from "vitest";
import { bailianModelCap, decodeBailianPayload } from "./bailian";

describe("bailianModelCap", () => {
  it("按命名段识别 t2v / i2v", () => {
    expect(bailianModelCap("wanx-t2v").kind).toBe("t2v");
    expect(bailianModelCap("wanx-i2v").kind).toBe("i2v");
  });

  it("未识别视频模型回退 special", () => {
    expect(bailianModelCap("foo-bar").kind).toBe("special");
  });
});

describe("decodeBailianPayload", () => {
  it("纯 API Key 字符串直接返回", () => {
    expect(decodeBailianPayload("sk-456")).toEqual({ apiKey: "sk-456" });
  });

  it("解析 JSON 负载中的 apiKey/accountId", () => {
    const payload = JSON.stringify({ v: 1, apiKey: " sk-abc ", accountId: "12345" });
    const out = decodeBailianPayload(payload);
    expect(out.apiKey).toBe("sk-abc");
    expect(out.accountId).toBe("12345");
  });
});