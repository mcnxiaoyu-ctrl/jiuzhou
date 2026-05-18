/**
 * 股市数值与交易规则。
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：集中维护 AI 涨跌数值边界、股价调整、A 股交易费用、交易数量和持仓价值限制。
 * 2. 不做什么：不访问数据库、不读取 AI 返回、不决定玩家是否已持仓。
 *
 * 输入 / 输出：
 * - 输入：AI 输出涨跌百分比、当前价格、交易金额、买卖方向、当前持仓成本。
 * - 输出：涨跌基点、新价格、交易费用拆分、释放成本和规则 DTO。
 *
 * 数据流 / 状态流：
 * AI 影响 -> `normalizeStockMarketAiChangeBps` -> `applyStockMarketPriceChange` -> quote/history；
 * 交易金额 + 买卖方向 -> `calculateStockMarketTradeFeeBreakdown` -> 买卖服务。
 *
 * 复用设计说明：
 * - 买入、卖出、概览展示和测试都复用本模块，避免佣金、印花税、过户费、AI 涨跌边界和限额散落在路由或前端。
 * - 涨跌上限是股市平衡的高频业务变化点，集中到这里后后续调参只改一处。
 *
 * 关键边界条件与坑点：
 * 1. 费用分项使用向上取整，防止小额拆单绕过佣金、印花税或过户费。
 * 2. 释放持仓成本必须按卖出数量比例计算，避免分批卖出时盈亏被重复计算。
 */
export const STOCK_MARKET_TICK_INTERVAL_MS = 60 * 60 * 1000;
export const STOCK_MARKET_FEE_RATE_DENOMINATOR = 100_000;
export const STOCK_MARKET_COMMISSION_RATE = 30;
export const STOCK_MARKET_STAMP_DUTY_RATE = 50;
export const STOCK_MARKET_TRANSFER_FEE_RATE = 1;
export const STOCK_MARKET_MIN_PRICE_SPIRIT_STONES = 1n;
export const STOCK_MARKET_MAX_ORDER_VALUE_SPIRIT_STONES = 2_000_000n;
export const STOCK_MARKET_MAX_SINGLE_STOCK_VALUE_SPIRIT_STONES = 5_000_000n;
export const STOCK_MARKET_MAX_TOTAL_VALUE_SPIRIT_STONES = 20_000_000n;
export const STOCK_MARKET_HISTORY_LIMIT = 48;
export const STOCK_MARKET_TRADE_RECORD_PAGE_SIZE = 20;

export const STOCK_MARKET_MAX_ABS_CHANGE_BPS = 800;
const BPS_DENOMINATOR = 10_000n;
const FEE_RATE_DENOMINATOR = BigInt(STOCK_MARKET_FEE_RATE_DENOMINATOR);
const STOCK_MARKET_PERCENT_TO_BPS = 100;
const STOCK_MARKET_FLOAT_EPSILON = 1e-9;

export type StockMarketTradeSide = 'buy' | 'sell';

export interface StockMarketTradeFeeBreakdown {
  commissionFeeSpiritStones: bigint;
  stampDutySpiritStones: bigint;
  transferFeeSpiritStones: bigint;
  totalFeeSpiritStones: bigint;
}

export const normalizeStockMarketAiChangeBps = (changePercent: number): number | null => {
  if (!Number.isFinite(changePercent)) return null;
  const scaledBps = changePercent * STOCK_MARKET_PERCENT_TO_BPS;
  const roundedBps = Math.round(scaledBps);
  if (Math.abs(scaledBps - roundedBps) > STOCK_MARKET_FLOAT_EPSILON) return null;
  if (roundedBps === 0) return null;
  if (Math.abs(roundedBps) > STOCK_MARKET_MAX_ABS_CHANGE_BPS) return null;
  return roundedBps;
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

const calculateStockMarketFeeComponent = (
  grossAmountSpiritStones: bigint,
  rate: number,
): bigint => {
  if (grossAmountSpiritStones <= 0n || rate <= 0) return 0n;
  return (
    grossAmountSpiritStones * BigInt(rate)
    + (FEE_RATE_DENOMINATOR - 1n)
  ) / FEE_RATE_DENOMINATOR;
};

export const calculateStockMarketTradeFeeBreakdown = (
  grossAmountSpiritStones: bigint,
  side: StockMarketTradeSide,
): StockMarketTradeFeeBreakdown => {
  const commissionFeeSpiritStones = calculateStockMarketFeeComponent(
    grossAmountSpiritStones,
    STOCK_MARKET_COMMISSION_RATE,
  );
  const stampDutySpiritStones = side === 'sell'
    ? calculateStockMarketFeeComponent(grossAmountSpiritStones, STOCK_MARKET_STAMP_DUTY_RATE)
    : 0n;
  const transferFeeSpiritStones = calculateStockMarketFeeComponent(
    grossAmountSpiritStones,
    STOCK_MARKET_TRANSFER_FEE_RATE,
  );
  return {
    commissionFeeSpiritStones,
    stampDutySpiritStones,
    transferFeeSpiritStones,
    totalFeeSpiritStones: commissionFeeSpiritStones + stampDutySpiritStones + transferFeeSpiritStones,
  };
};

export const calculateStockMarketTradeFee = (
  grossAmountSpiritStones: bigint,
  side: StockMarketTradeSide,
): bigint => {
  return calculateStockMarketTradeFeeBreakdown(grossAmountSpiritStones, side).totalFeeSpiritStones;
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
  feeRateDenominator: STOCK_MARKET_FEE_RATE_DENOMINATOR,
  commissionRate: STOCK_MARKET_COMMISSION_RATE,
  stampDutyRate: STOCK_MARKET_STAMP_DUTY_RATE,
  transferFeeRate: STOCK_MARKET_TRANSFER_FEE_RATE,
  maxOrderValueSpiritStones: Number(STOCK_MARKET_MAX_ORDER_VALUE_SPIRIT_STONES),
  maxSingleStockValueSpiritStones: Number(STOCK_MARKET_MAX_SINGLE_STOCK_VALUE_SPIRIT_STONES),
  maxTotalValueSpiritStones: Number(STOCK_MARKET_MAX_TOTAL_VALUE_SPIRIT_STONES),
  minPriceSpiritStones: Number(STOCK_MARKET_MIN_PRICE_SPIRIT_STONES),
});
