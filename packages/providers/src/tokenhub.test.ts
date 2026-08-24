import { describe, expect, it } from "vitest";
import {
  attachTokenhubFreeQuota,
  decodeTokenhubPayload,
  parseTokenhubDescribeResponse,
  tokenhubFreeVideoModels,
} from "./tokenhub";

describe("parseTokenhubDescribeResponse", () => {
  it("空文本返回空数组", () => {
    expect(parseTokenhubDescribeResponse("")).toEqual([]);
    expect(parseTokenhubDescribeResponse('{"data":{}}')).toEqual([]);
  });

  it("非法 JSON 返回空数组", () => {
    expect(parseTokenhubDescribeResponse("not-json")).toEqual([]);
  });

  it("解析 FREE + FreeTrialClaimed 模型的额度", () => {
    const resp = JSON.stringify({
      data: {
        data: {
          data: {
            Response: {
              ModelEndpointSet: [
                {
                  ModelId: "hy-video-1.5",
                  ChargeType: "FREE",
                  FreeTrialClaimed: true,
                  ChargeDetail: JSON.stringify({
                    FreeQuota: { TotalQuota: 10, UsedQuota: 4, UsagePercent: 40 },
                  }),
                },
                {
                  // 非 FREE，应被过滤
                  ModelId: "paid-model",
                  ChargeType: "PAID",
                  ChargeDetail: JSON.stringify({ FreeQuota: { TotalQuota: 10, UsedQuota: 0 } }),
                },
              ],
            },
          },
        },
      },
    });
    const out = parseTokenhubDescribeResponse(resp);
    expect(out).toHaveLength(1);
    expect(out[0].model).toBe("hy-video-1.5");
    expect(out[0].quota.total).toBe(10);
    expect(out[0].quota.used).toBe(4);
    expect(out[0].quota.remaining).toBe(6);
  });
});

describe("decodeTokenhubPayload", () => {
  it("纯 API Key 字符串直接返回", () => {
    expect(decodeTokenhubPayload("sk-123")).toEqual({ apiKey: "sk-123" });
  });

  it("解析 JSON 负载中的 apiKey/uin/models/points", () => {
    const payload = JSON.stringify({
      v: 1,
      apiKey: "  sk-abc  ",
      uin: "10001",
      models: [{ id: "hy-video-1.5", name: "HY-Video-1.5" }],
      points: { remaining: 20, total: 100 },
    });
    const out = decodeTokenhubPayload(payload);
    expect(out.apiKey).toBe("sk-abc");
    expect(out.uin).toBe("10001");
    expect(out.models).toHaveLength(1);
    expect(out.points?.remaining).toBe(20);
  });
});

describe("attachTokenhubFreeQuota", () => {
  it("把额度挂到对应模型，缺额度的保持原样", () => {
    const models = [{ id: "a" }, { id: "b" }];
    const out = attachTokenhubFreeQuota(models, { a: { total: 5, used: 2, remaining: 3, percent: 40, expired: false } });
    expect(out[0].freeQuota?.remaining).toBe(3);
    expect(out[1].freeQuota).toBeUndefined();
  });
});

describe("tokenhubFreeVideoModels", () => {
  it("返回内含已知免费视频模型", () => {
    const models = tokenhubFreeVideoModels();
    expect(models.length).toBeGreaterThan(0);
    const ids = models.map((m) => m.id);
    expect(ids).toContain("hy-video-1.5");
  });
});