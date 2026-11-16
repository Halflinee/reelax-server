import { describe, expect, it } from "vitest";
import { pickFishUnitPrice } from "../src/services/mastery-supply-service.ts";

describe("专精鱼自动选价", () => {
  it("选择价差内最低整数价，不取中间价或追高", () => {
    expect(pickFishUnitPrice({ highestBid: 100, lowestAsk: 120, minimumPrice: 50 }, 3, 1000)).toBe(101);
  });
  it("市场底价高于买一加一时，选择底价", () => {
    expect(pickFishUnitPrice({ highestBid: 100, lowestAsk: 200, minimumPrice: 150 }, 3, 1000)).toBe(150);
  });
  it("空盘口和只有卖盘时按底价选择", () => {
    expect(pickFishUnitPrice({ highestBid: null, lowestAsk: null, minimumPrice: 25 }, 3, 1000)).toBe(25);
    expect(pickFishUnitPrice({ highestBid: null, lowestAsk: 100, minimumPrice: 25 }, 3, 1000)).toBe(25);
  });
  it("只有买盘时仍需要高于最高买价", () => {
    expect(pickFishUnitPrice({ highestBid: 100, lowestAsk: null, minimumPrice: 25 }, 3, 1000)).toBe(101);
  });
  it.each([
    { highestBid: 100, lowestAsk: 101, minimumPrice: 25 },
    { highestBid: 100, lowestAsk: 100, minimumPrice: 25 },
    { highestBid: 110, lowestAsk: 100, minimumPrice: 25 },
    { highestBid: null, lowestAsk: 100, minimumPrice: 100 },
  ])("没有价格空档时不能选价 %j", (pricing) => {
    expect(() => pickFishUnitPrice(pricing, 3, 10000)).toThrow("没有可用的整数价格空档");
  });
  it("余额不足不自动减少数量或选择会和别人撮合的低价", () => {
    expect(() => pickFishUnitPrice({ highestBid: 100, lowestAsk: 120, minimumPrice: 25 }, 3, 302)).toThrow("请减少数量");
    expect(pickFishUnitPrice({ highestBid: 100, lowestAsk: 120, minimumPrice: 25 }, 3, 303)).toBe(101);
  });
  it("最高买价超出可用整数范围时不会溢出", () => {
    expect(() => pickFishUnitPrice({ highestBid: Number.MAX_SAFE_INTEGER, lowestAsk: null, minimumPrice: 25 }, 1, Number.MAX_SAFE_INTEGER)).toThrow("没有可用的整数价格空档");
    expect(pickFishUnitPrice({ highestBid: Number.MAX_SAFE_INTEGER - 1, lowestAsk: null, minimumPrice: 25 }, 1, Number.MAX_SAFE_INTEGER)).toBe(Number.MAX_SAFE_INTEGER);
  });
  it("大额数量和单价乘积使用精确整数，不突破余额", () => {
    expect(() => pickFishUnitPrice({ highestBid: 100, lowestAsk: null, minimumPrice: 25 }, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER)).toThrow("金币");
  });
});
