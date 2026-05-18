/**
 * 股市规则纯函数回归测试
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：锁定 AI 涨跌数值边界、历史 OHLC、A 股交易费用、持仓成本释放和初始 10 支股票配置。
 * 2. 不做什么：不访问数据库、不调用 AI、不覆盖 HTTP 路由。
 *
 * 输入 / 输出：
 * - 输入：固定价格、交易金额、持仓成本和静态股票定义。
 * - 输出：可预测的涨跌后价格、历史开高低收、交易费用拆分和配置数量断言。
 *
 * 数据流 / 状态流：
 * 规则函数 -> 断言输出；静态 JSON -> 定义索引 -> 唯一性断言。
 *
 * 复用设计说明：
 * - 规则测试直接覆盖共享规则入口，买入、卖出和调度同时受保护，避免在多个服务测试中重复写同样的数值断言。
 * - 股票数量和 ID 唯一性在这里锁定，防止扩展静态配置时破坏 v1 初始 10 股。
 *
 * 关键边界条件与坑点：
 * 1. 历史 OHLC 必须给实体上下留影线，避免前端 K 线退化成无影线柱。
 * 2. 小额交易费用必须按分项向上取整，否则玩家可以通过拆单规避交易成本。
 * 3. 股价必须以分单位保留两位小数，小幅涨跌不能被整数灵石吞掉。
 * 4. 分批卖出成本释放必须保留剩余成本，否则盈亏会被重复计算。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { getEnabledStockDefinitions } from '../stockMarket/stockMarketDefinitions.js';
import {
  applyStockMarketPriceChange,
  buildStockMarketHistoryOhlc,
  calculateStockMarketGrossAmount,
  calculateStockMarketMaxSellQuantity,
  calculateReleasedStockHoldingCost,
  calculateStockMarketTradeFee,
  calculateStockMarketTradeFeeBreakdown,
  normalizeStockMarketAiChangeBps,
  stockMarketPriceToStorageUnits,
  stockMarketPriceUnitsToSpiritStones,
} from '../stockMarket/stockMarketRules.js';

test('股市初始配置应包含 10 支启用股票且 ID 唯一', () => {
  const definitions = getEnabledStockDefinitions();
  const idSet = new Set(definitions.map((definition) => definition.id));

  assert.equal(definitions.length, 10);
  assert.equal(idSet.size, definitions.length);
  assert.ok(definitions.every((definition) => definition.initial_price_spirit_stones > 0));
});

test('normalizeStockMarketAiChangeBps: AI 涨跌应限制为两位小数且不超过正负 8%', () => {
  assert.equal(normalizeStockMarketAiChangeBps(8), 800);
  assert.equal(normalizeStockMarketAiChangeBps(-8), -800);
  assert.equal(normalizeStockMarketAiChangeBps(1.23), 123);
  assert.equal(normalizeStockMarketAiChangeBps(0), null);
  assert.equal(normalizeStockMarketAiChangeBps(1.234), null);
  assert.equal(normalizeStockMarketAiChangeBps(8.01), null);
  assert.equal(normalizeStockMarketAiChangeBps(-8.01), null);
});

test('applyStockMarketPriceChange: 应按两位小数分单位调整价格且不低于 1 灵石', () => {
  assert.equal(applyStockMarketPriceChange(stockMarketPriceToStorageUnits(100), 10), 10010n);
  assert.equal(applyStockMarketPriceChange(stockMarketPriceToStorageUnits(100), 800), 10800n);
  assert.equal(applyStockMarketPriceChange(stockMarketPriceToStorageUnits(100), -800), 9200n);
  assert.equal(applyStockMarketPriceChange(1n, -800), 100n);
  assert.equal(stockMarketPriceUnitsToSpiritStones(10010n), 100.1);
});

test('buildStockMarketHistoryOhlc: 历史 K 线应在实体上下生成影线', () => {
  assert.deepEqual(buildStockMarketHistoryOhlc(17900n, 18300n), {
    openPriceUnits: 17900n,
    highPriceUnits: 18400n,
    lowPriceUnits: 17800n,
    closePriceUnits: 18300n,
  });
  assert.deepEqual(buildStockMarketHistoryOhlc(17900n, 17900n), {
    openPriceUnits: 17900n,
    highPriceUnits: 17954n,
    lowPriceUnits: 17846n,
    closePriceUnits: 17900n,
  });
});

test('calculateStockMarketGrossAmount: 小数股价买入向上取整，卖出向下取整', () => {
  assert.equal(calculateStockMarketGrossAmount(10001n, 1, 'buy'), 101n);
  assert.equal(calculateStockMarketGrossAmount(10001n, 1, 'sell'), 100n);
  assert.equal(calculateStockMarketGrossAmount(10001n, 2, 'buy'), 201n);
  assert.equal(calculateStockMarketGrossAmount(10001n, 2, 'sell'), 200n);
});

test('calculateStockMarketTradeFee: A 股费用应按买卖方向拆分并向上取整', () => {
  assert.deepEqual(calculateStockMarketTradeFeeBreakdown(10_000n, 'buy'), {
    commissionFeeSpiritStones: 3n,
    stampDutySpiritStones: 0n,
    transferFeeSpiritStones: 1n,
    totalFeeSpiritStones: 4n,
  });
  assert.deepEqual(calculateStockMarketTradeFeeBreakdown(10_000n, 'sell'), {
    commissionFeeSpiritStones: 3n,
    stampDutySpiritStones: 5n,
    transferFeeSpiritStones: 1n,
    totalFeeSpiritStones: 9n,
  });
  assert.equal(calculateStockMarketTradeFee(101n, 'sell'), 3n);
});

test('calculateStockMarketMaxSellQuantity: 卖出数量应直接取当前持仓数量', () => {
  assert.equal(calculateStockMarketMaxSellQuantity(2500), 2500);
  assert.equal(calculateStockMarketMaxSellQuantity(0), 0);
});

test('calculateReleasedStockHoldingCost: 分批卖出应按数量比例释放成本', () => {
  assert.equal(calculateReleasedStockHoldingCost(1_000n, 10, 4), 400n);
  assert.equal(calculateReleasedStockHoldingCost(1_000n, 10, 10), 1_000n);
  assert.equal(calculateReleasedStockHoldingCost(0n, 10, 4), 0n);
});
