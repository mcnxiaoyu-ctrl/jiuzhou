/**
 * 股市规则纯函数回归测试
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：锁定稳健档涨跌、手续费、持仓成本释放和初始 10 支股票配置。
 * 2. 不做什么：不访问数据库、不调用 AI、不覆盖 HTTP 路由。
 *
 * 输入 / 输出：
 * - 输入：固定价格、交易金额、持仓成本和静态股票定义。
 * - 输出：可预测的涨跌后价格、手续费和配置数量断言。
 *
 * 数据流 / 状态流：
 * 规则函数 -> 断言输出；静态 JSON -> 定义索引 -> 唯一性断言。
 *
 * 复用设计说明：
 * - 规则测试直接覆盖共享规则入口，买入、卖出和调度同时受保护，避免在多个服务测试中重复写同样的数值断言。
 * - 股票数量和 ID 唯一性在这里锁定，防止扩展静态配置时破坏 v1 初始 10 股。
 *
 * 关键边界条件与坑点：
 * 1. 小额交易手续费必须向上取整，否则玩家可以通过拆单规避交易成本。
 * 2. 分批卖出成本释放必须保留剩余成本，否则盈亏会被重复计算。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { getEnabledStockDefinitions } from '../stockMarket/stockMarketDefinitions.js';
import {
  applyStockMarketPriceChange,
  calculateStockMarketMaxBuyQuantity,
  calculateStockMarketMaxSellQuantity,
  calculateReleasedStockHoldingCost,
  calculateStockMarketTradeFee,
  resolveStockMarketChangeBps,
} from '../stockMarket/stockMarketRules.js';

test('股市初始配置应包含 10 支启用股票且 ID 唯一', () => {
  const definitions = getEnabledStockDefinitions();
  const idSet = new Set(definitions.map((definition) => definition.id));

  assert.equal(definitions.length, 10);
  assert.equal(idSet.size, definitions.length);
  assert.ok(definitions.every((definition) => definition.initial_price_spirit_stones > 0));
});

test('resolveStockMarketChangeBps: 稳健档涨跌应限制在服务端规则范围内', () => {
  assert.equal(resolveStockMarketChangeBps('bullish', 'major'), 800);
  assert.equal(resolveStockMarketChangeBps('bearish', 'major'), -600);
});

test('applyStockMarketPriceChange: 应按基点调整价格且不低于 1 灵石', () => {
  assert.equal(applyStockMarketPriceChange(100n, 800), 108n);
  assert.equal(applyStockMarketPriceChange(100n, -600), 94n);
  assert.equal(applyStockMarketPriceChange(1n, -600), 1n);
});

test('calculateStockMarketTradeFee: 买卖手续费应按 1% 向上取整', () => {
  assert.equal(calculateStockMarketTradeFee(10_000n), 100n);
  assert.equal(calculateStockMarketTradeFee(101n), 2n);
  assert.equal(calculateStockMarketTradeFee(1n), 1n);
});

test('calculateStockMarketMaxBuyQuantity: 买入数量应按剩余持仓价值与单笔金额共同收敛', () => {
  assert.equal(calculateStockMarketMaxBuyQuantity({
    unitPriceSpiritStones: 100n,
    currentSingleStockValueSpiritStones: 4_999_800n,
    currentTotalValueSpiritStones: 10_000_000n,
  }), 2);
  assert.equal(calculateStockMarketMaxBuyQuantity({
    unitPriceSpiritStones: 100n,
    currentSingleStockValueSpiritStones: 1_000_000n,
    currentTotalValueSpiritStones: 19_999_950n,
  }), 0);
  assert.equal(calculateStockMarketMaxBuyQuantity({
    unitPriceSpiritStones: 100n,
    currentSingleStockValueSpiritStones: 1_000_000n,
    currentTotalValueSpiritStones: 1_000_000n,
  }), 20_000);
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
