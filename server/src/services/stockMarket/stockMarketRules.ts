/**
 * 股市数值与交易规则。
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：集中维护股价涨跌映射、手续费、交易数量和持仓价值限制。
 * 2. 不做什么：不访问数据库、不读取 AI 返回、不决定玩家是否已持仓。
 *
 * 输入 / 输出：
 * - 输入：AI 语义方向、影响等级、当前价格、交易金额、当前持仓成本。
 * - 输出：涨跌基点、新价格、手续费、释放成本和规则 DTO。
 *
 * 数据流 / 状态流：
 * AI 影响 -> `resolveStockMarketChangeBps` -> `applyStockMarketPriceChange` -> quote/history；
 * 交易金额 -> `calculateStockMarketTradeFee` -> 买卖服务。
 *
 * 复用设计说明：
 * - 买入、卖出、概览展示和测试都复用本模块，避免 1% 手续费、涨跌范围和限额散落在路由或前端。
 * - 影响等级是股市平衡的高频业务变化点，集中到映射表后后续调参只改一处。
 *
 * 关键边界条件与坑点：
 * 1. 手续费使用向上取整，防止小额拆单绕过 1% 成本。
 * 2. 释放持仓成本必须按卖出数量比例计算，避免分批卖出时盈亏被重复计算。
 */
export type StockMarketImpactDirection = 'bullish' | 'bearish';
export type StockMarketImpactLevel = 'minor' | 'normal' | 'major';

export const STOCK_MARKET_TICK_INTERVAL_MS = 60 * 60 * 1000;
export const STOCK_MARKET_TRADE_FEE_BPS = 100;
export const STOCK_MARKET_MIN_PRICE_SPIRIT_STONES = 1n;
export const STOCK_MARKET_MAX_ORDER_VALUE_SPIRIT_STONES = 2_000_000n;
export const STOCK_MARKET_MAX_SINGLE_STOCK_VALUE_SPIRIT_STONES = 5_000_000n;
export const STOCK_MARKET_MAX_TOTAL_VALUE_SPIRIT_STONES = 20_000_000n;
export const STOCK_MARKET_HISTORY_LIMIT = 48;
export const STOCK_MARKET_TRADE_RECORD_PAGE_SIZE = 20;

const STOCK_MARKET_CHANGE_BPS: Record<
  StockMarketImpactDirection,
  Record<StockMarketImpactLevel, number>
> = {
  bullish: {
    minor: 150,
    normal: 450,
    major: 800,
  },
  bearish: {
    minor: -150,
    normal: -400,
    major: -600,
  },
};

const STOCK_MARKET_MAX_UP_BPS = 800;
const STOCK_MARKET_MAX_DOWN_BPS = -600;
const BPS_DENOMINATOR = 10_000n;

export const resolveStockMarketChangeBps = (
  direction: StockMarketImpactDirection,
  impactLevel: StockMarketImpactLevel,
): number => {
  const rawChangeBps = STOCK_MARKET_CHANGE_BPS[direction][impactLevel];
  return Math.max(STOCK_MARKET_MAX_DOWN_BPS, Math.min(STOCK_MARKET_MAX_UP_BPS, rawChangeBps));
};

export const applyStockMarketPriceChange = (
  currentPriceSpiritStones: bigint,
  changeBps: number,
): bigint => {
  const normalizedCurrentPrice = currentPriceSpiritStones > 0n
    ? currentPriceSpiritStones
    : STOCK_MARKET_MIN_PRICE_SPIRIT_STONES;
  if (changeBps === 0) return normalizedCurrentPrice;

  const absChangeBps = BigInt(Math.abs(changeBps));
  const delta = (normalizedCurrentPrice * absChangeBps + (BPS_DENOMINATOR / 2n)) / BPS_DENOMINATOR;
  const nextPrice = changeBps > 0
    ? normalizedCurrentPrice + delta
    : normalizedCurrentPrice - delta;
  return nextPrice >= STOCK_MARKET_MIN_PRICE_SPIRIT_STONES
    ? nextPrice
    : STOCK_MARKET_MIN_PRICE_SPIRIT_STONES;
};

export const calculateStockMarketTradeFee = (grossAmountSpiritStones: bigint): bigint => {
  if (grossAmountSpiritStones <= 0n) return 0n;
  return (
    grossAmountSpiritStones * BigInt(STOCK_MARKET_TRADE_FEE_BPS)
    + (BPS_DENOMINATOR - 1n)
  ) / BPS_DENOMINATOR;
};

export const calculateStockMarketGrossAmount = (
  unitPriceSpiritStones: bigint,
  quantity: number,
): bigint => {
  return unitPriceSpiritStones * BigInt(Math.max(0, Math.floor(quantity)));
};

const toSafeQuantity = (value: bigint): number => {
  const normalized = Number(value);
  if (!Number.isSafeInteger(normalized)) {
    throw new Error('股市可交易数量超过前端安全整数范围');
  }
  return Math.max(0, Math.trunc(normalized));
};

export const calculateStockMarketMaxBuyQuantity = (params: {
  unitPriceSpiritStones: bigint;
  currentSingleStockValueSpiritStones: bigint;
  currentTotalValueSpiritStones: bigint;
}): number => {
  const unitPrice = params.unitPriceSpiritStones > 0n
    ? params.unitPriceSpiritStones
    : STOCK_MARKET_MIN_PRICE_SPIRIT_STONES;
  const singleStockRemainingValue = STOCK_MARKET_MAX_SINGLE_STOCK_VALUE_SPIRIT_STONES
    - params.currentSingleStockValueSpiritStones;
  const totalRemainingValue = STOCK_MARKET_MAX_TOTAL_VALUE_SPIRIT_STONES
    - params.currentTotalValueSpiritStones;
  const availableValue = [
    STOCK_MARKET_MAX_ORDER_VALUE_SPIRIT_STONES,
    singleStockRemainingValue,
    totalRemainingValue,
  ].reduce((min, value) => (value < min ? value : min));
  if (availableValue <= 0n) return 0;
  return toSafeQuantity(availableValue / unitPrice);
};

export const calculateStockMarketMaxSellQuantity = (
  holdingQuantity: number,
): number => {
  return Number.isSafeInteger(holdingQuantity) && holdingQuantity > 0
    ? Math.trunc(holdingQuantity)
    : 0;
};

export const calculateReleasedStockHoldingCost = (
  totalCostSpiritStones: bigint,
  holdingQuantity: number,
  sellQuantity: number,
): bigint => {
  if (totalCostSpiritStones <= 0n || holdingQuantity <= 0 || sellQuantity <= 0) return 0n;
  if (sellQuantity >= holdingQuantity) return totalCostSpiritStones;
  return (totalCostSpiritStones * BigInt(sellQuantity)) / BigInt(holdingQuantity);
};

export const buildStockMarketTradeRulesDto = () => ({
  feeBps: STOCK_MARKET_TRADE_FEE_BPS,
  maxOrderValueSpiritStones: Number(STOCK_MARKET_MAX_ORDER_VALUE_SPIRIT_STONES),
  maxSingleStockValueSpiritStones: Number(STOCK_MARKET_MAX_SINGLE_STOCK_VALUE_SPIRIT_STONES),
  maxTotalValueSpiritStones: Number(STOCK_MARKET_MAX_TOTAL_VALUE_SPIRIT_STONES),
  minPriceSpiritStones: Number(STOCK_MARKET_MIN_PRICE_SPIRIT_STONES),
});
