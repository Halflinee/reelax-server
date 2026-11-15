import { describe, expect, it } from "vitest";
import { planMasteryMarket } from "../src/services/mastery-market-preview.ts";

function fixture() {
  return {
    input: { fishId: "fish", quantity: 10, maxUnitPrice: 150, budget: 2000 },
    fish: { id: "fish", name: "测试鱼", biomeId: "map", rarity: "common", sellPrice: 100 },
    missing: 10, gold: 5000,
    config: { maxFishOrderQuantity: 100, fishMinimumPrices: [{ biomeId: "map", rarity: "common", configuredMinimumUnitPrice: 120 }] },
    book: { version: 3, sellLevels: [{ unitPrice: 140, quantity: 5 }, { unitPrice: 130, quantity: 3 }, { unitPrice: 151, quantity: 100 }] },
  };
}

describe("专精鱼市场限价计划", () => {
  it("低价优先累计卖盘，超过限价的卖盘不计入；预览不修改输入", () => {
    const input = fixture();
    const before = structuredClone(input);
    expect(planMasteryMarket(input)).toMatchObject({ orderQuantity: 10, reserveGold: 1500, expectedQuantity: 8, expectedCostGold: 1090, pendingQuantity: 2,
      fills: [{ unitPrice: 130, quantity: 3, costGold: 390 }, { unitPrice: 140, quantity: 5, costGold: 700 }] });
    expect(input).toEqual(before);
  });
  it("预算按最高单价冻结额限制数量，不借用预计差价扩大数量", () => {
    const input = fixture(); input.input.budget = 600;
    expect(planMasteryMarket(input)).toMatchObject({ orderQuantity: 4, reserveGold: 600, expectedQuantity: 4, expectedCostGold: 530, pendingQuantity: 0 });
  });
  it("预算高于余额时只能使用余额", () => {
    const input = fixture(); input.gold = 299;
    expect(planMasteryMarket(input)).toMatchObject({ orderQuantity: 1, reserveGold: 150 });
  });
  it("零预算和零金币均不生成可委托数量", () => {
    const input = fixture(); input.input.budget = 0;
    expect(planMasteryMarket(input).orderQuantity).toBe(0);
    input.input.budget = 500; input.gold = 0;
    expect(planMasteryMarket(input).orderQuantity).toBe(0);
  });
  it("数量不超过当前专精缺口和单笔上限", () => {
    const input = fixture(); input.missing = 7; input.config.maxFishOrderQuantity = 4;
    expect(planMasteryMarket(input).orderQuantity).toBe(4);
    input.missing = 2;
    expect(planMasteryMarket(input).orderQuantity).toBe(2);
  });
  it("最低价同时满足 NPC 售价和地图稀有度配置", () => {
    const input = fixture(); input.input.maxUnitPrice = 119;
    expect(planMasteryMarket(input)).toMatchObject({ minimumUnitPrice: 120, orderQuantity: 0, expectedQuantity: 0 });
    input.config.fishMinimumPrices[0]!.configuredMinimumUnitPrice = 20;
    expect(planMasteryMarket(input).minimumUnitPrice).toBe(100);
    input.config.fishMinimumPrices = [];
    expect(planMasteryMarket(input).minimumUnitPrice).toBe(100);
  });
  it("空盘口显示无卖价及等待数量，不伪造立即成交", () => {
    const input = fixture(); input.book.sellLevels = [];
    expect(planMasteryMarket(input)).toMatchObject({ bestAsk: null, expectedQuantity: 0, expectedCostGold: 0, pendingQuantity: 10 });
  });
  it("未填写限价和预算时，按最低价、当前金币及缺口生成初始预览", () => {
    const input = fixture();
    expect(planMasteryMarket({ ...input, input: { fishId: "fish" } })).toMatchObject({ requestedQuantity: 10, maxUnitPrice: 120, budget: 5000, orderQuantity: 10, expectedQuantity: 0 });
  });
  it("安全整数上限金额不溢出，不先计算超大乘积", () => {
    const input = fixture(); input.input.maxUnitPrice = Number.MAX_SAFE_INTEGER; input.input.budget = Number.MAX_SAFE_INTEGER; input.gold = Number.MAX_SAFE_INTEGER;
    expect(planMasteryMarket(input)).toMatchObject({ orderQuantity: 1, reserveGold: Number.MAX_SAFE_INTEGER, expectedQuantity: 1, expectedCostGold: 130 });
  });
  it("损坏的配置与盘口明确报错", () => {
    expect(() => planMasteryMarket({ ...fixture(), config: {} })).toThrow("数据格式已变化");
    expect(() => planMasteryMarket({ ...fixture(), book: { version: 1, sellLevels: [{ unitPrice: 1, quantity: -1 }] } })).toThrow("数据格式已变化");
  });
});
