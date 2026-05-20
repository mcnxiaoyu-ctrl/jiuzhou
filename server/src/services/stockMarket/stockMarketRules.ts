/**
 * 股市数值与交易规则。
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：集中维护 AI 涨跌数值边界、两位小数股价、A 股交易费用和交易数量基础规则。
 * 2. 不做什么：不访问数据库、不读取 AI 返回、不决定玩家是否已持仓。
 *
 * 输入 / 输出：
 * - 输入：AI 输出涨跌百分比、当前价格分单位、历史开收价分单位、交易金额、买卖方向、当前持仓成本。
 * - 输出：涨跌基点、新价格分单位、历史 OHLC 分单位、整数灵石交易金额、交易费用拆分、释放成本和规则 DTO。
 *
 * 数据流 / 状态流：
 * AI 影响 -> `normalizeStockMarketAiChangeBps` -> `applyStockMarketPriceChange` -> `buildStockMarketHistoryOhlc` -> quote/history；
 * 交易金额 + 买卖方向 -> `calculateStockMarketTradeFeeBreakdown` -> 买卖服务。
 *
 * 复用设计说明：
 * - 买入、卖出、概览展示、历史 K 线和测试都复用本模块，避免佣金、印花税、过户费和 AI 涨跌边界散落在路由或前端。
 * - 涨跌上限是股市平衡的高频业务变化点，集中到这里后后续调参只改一处。
 *
 * 关键边界条件与坑点：
 * 1. 费用分项使用向上取整，防止小额拆单绕过佣金、印花税或过户费。
 * 2. 股价使用定点分单位存储，避免 0.1% 这类小幅波动被整数灵石吞掉。
 * 3. 买入成交额向上取整、卖出成交额向下取整，避免小数灵石在扣款和到账时制造套利。
 * 4. 释放持仓成本必须按卖出数量比例计算，避免分批卖出时盈亏被重复计算。
 * 5. 历史表当前只存 tick 收盘价，OHLC 的影线是后端统一生成的展示区间，不代表真实逐笔成交高低。
 */
export const STOCK_MARKET_TICK_INTERVAL_MINUTES = 30;
export const STOCK_MARKET_TICK_INTERVAL_MS = STOCK_MARKET_TICK_INTERVAL_MINUTES * 60 * 1000;
export const STOCK_MARKET_FEE_RATE_DENOMINATOR = 100_000;
export const STOCK_MARKET_COMMISSION_RATE = 30;
export const STOCK_MARKET_STAMP_DUTY_RATE = 50;
export const STOCK_MARKET_TRANSFER_FEE_RATE = 1;
export const STOCK_MARKET_PRICE_SCALE = 100n;
export const STOCK_MARKET_PRICE_SCALE_NUMBER = 100;
export const STOCK_MARKET_MIN_PRICE_SPIRIT_STONES = 1n;
export const STOCK_MARKET_MIN_PRICE_UNITS = STOCK_MARKET_MIN_PRICE_SPIRIT_STONES * STOCK_MARKET_PRICE_SCALE;
export const STOCK_MARKET_HISTORY_LIMIT = 48;
export const STOCK_MARKET_TRADE_RECORD_PAGE_SIZE = 20;

export const STOCK_MARKET_MAX_ABS_CHANGE_BPS = 800;
const BPS_DENOMINATOR = 10_000n;
const FEE_RATE_DENOMINATOR = BigInt(STOCK_MARKET_FEE_RATE_DENOMINATOR);
const STOCK_MARKET_PERCENT_TO_BPS = 100;
const STOCK_MARKET_FLOAT_EPSILON = 1e-9;
const STOCK_MARKET_HISTORY_WICK_BPS = 30n;
const STOCK_MARKET_HISTORY_WICK_BODY_RATIO_NUMERATOR = 1n;
const STOCK_MARKET_HISTORY_WICK_BODY_RATIO_DENOMINATOR = 4n;

export type StockMarketTradeSide = 'buy' | 'sell';

export interface StockMarketHistoryOhlc {
  openPriceUnits: bigint;
  highPriceUnits: bigint;
  lowPriceUnits: bigint;
  closePriceUnits: bigint;
}

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
  currentPriceUnits: bigint,
  changeBps: number,
): bigint => {
  const normalizedCurrentPrice = currentPriceUnits >= STOCK_MARKET_MIN_PRICE_UNITS
    ? currentPriceUnits
    : STOCK_MARKET_MIN_PRICE_UNITS;
  if (changeBps === 0) return normalizedCurrentPrice;

  const absChangeBps = BigInt(Math.abs(changeBps));
  const delta = (normalizedCurrentPrice * absChangeBps + (BPS_DENOMINATOR / 2n)) / BPS_DENOMINATOR;
  const nextPrice = changeBps > 0
    ? normalizedCurrentPrice + delta
    : normalizedCurrentPrice - delta;
  return nextPrice >= STOCK_MARKET_MIN_PRICE_UNITS
    ? nextPrice
    : STOCK_MARKET_MIN_PRICE_UNITS;
};

const absBigInt = (value: bigint): bigint => (value >= 0n ? value : -value);

const ceilDiv = (value: bigint, denominator: bigint): bigint => {
  if (value <= 0n) return 0n;
  return (value + denominator - 1n) / denominator;
};

export const stockMarketPriceToStorageUnits = (priceSpiritStones: number): bigint => {
  if (!Number.isFinite(priceSpiritStones) || priceSpiritStones <= 0) {
    throw new Error('股市初始价格必须是正数');
  }
  const scaledPrice = priceSpiritStones * STOCK_MARKET_PRICE_SCALE_NUMBER;
  const roundedScaledPrice = Math.round(scaledPrice);
  if (Math.abs(scaledPrice - roundedScaledPrice) > STOCK_MARKET_FLOAT_EPSILON) {
    throw new Error('股市初始价格最多支持两位小数');
  }
  return BigInt(roundedScaledPrice);
};

export const stockMarketPriceUnitsToSpiritStones = (priceUnits: bigint): number => {
  const normalized = Number(priceUnits);
  if (!Number.isSafeInteger(normalized)) {
    throw new Error('股市价格超过前端安全整数范围');
  }
  return normalized / STOCK_MARKET_PRICE_SCALE_NUMBER;
};

const resolveStockMarketHistoryWickSize = (
  openPriceUnits: bigint,
  closePriceUnits: bigint,
): bigint => {
  const highBodyPrice = openPriceUnits > closePriceUnits
    ? openPriceUnits
    : closePriceUnits;
  const bodyRange = absBigInt(closePriceUnits - openPriceUnits);
  const priceBasedWick = ceilDiv(highBodyPrice * STOCK_MARKET_HISTORY_WICK_BPS, BPS_DENOMINATOR);
  const bodyBasedWick = ceilDiv(
    bodyRange * STOCK_MARKET_HISTORY_WICK_BODY_RATIO_NUMERATOR,
    STOCK_MARKET_HISTORY_WICK_BODY_RATIO_DENOMINATOR,
  );
  const wickSize = priceBasedWick > bodyBasedWick ? priceBasedWick : bodyBasedWick;
  return wickSize > 0n ? wickSize : 1n;
};

export const buildStockMarketHistoryOhlc = (
  openPriceUnits: bigint,
  closePriceUnits: bigint,
): StockMarketHistoryOhlc => {
  const openPrice = openPriceUnits >= STOCK_MARKET_MIN_PRICE_UNITS
    ? openPriceUnits
    : STOCK_MARKET_MIN_PRICE_UNITS;
  const closePrice = closePriceUnits >= STOCK_MARKET_MIN_PRICE_UNITS
    ? closePriceUnits
    : STOCK_MARKET_MIN_PRICE_UNITS;
  const highBodyPrice = openPrice > closePrice ? openPrice : closePrice;
  const lowBodyPrice = openPrice < closePrice ? openPrice : closePrice;
  const wickSize = resolveStockMarketHistoryWickSize(openPrice, closePrice);

  return {
    openPriceUnits: openPrice,
    highPriceUnits: highBodyPrice + wickSize,
    lowPriceUnits: lowBodyPrice > wickSize
      ? lowBodyPrice - wickSize
      : STOCK_MARKET_MIN_PRICE_UNITS,
    closePriceUnits: closePrice,
  };
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
  unitPriceUnits: bigint,
  quantity: number,
  side: StockMarketTradeSide,
): bigint => {
  const normalizedUnitPrice = unitPriceUnits >= STOCK_MARKET_MIN_PRICE_UNITS
    ? unitPriceUnits
    : STOCK_MARKET_MIN_PRICE_UNITS;
  const rawAmountUnits = normalizedUnitPrice * BigInt(Math.max(0, Math.floor(quantity)));
  return side === 'buy'
    ? ceilDiv(rawAmountUnits, STOCK_MARKET_PRICE_SCALE)
    : rawAmountUnits / STOCK_MARKET_PRICE_SCALE;
};

export const calculateStockMarketMarketValue = (
  unitPriceUnits: bigint,
  quantity: number,
): bigint => {
  const normalizedUnitPrice = unitPriceUnits >= STOCK_MARKET_MIN_PRICE_UNITS
    ? unitPriceUnits
    : STOCK_MARKET_MIN_PRICE_UNITS;
  return ceilDiv(
    normalizedUnitPrice * BigInt(Math.max(0, Math.floor(quantity))),
    STOCK_MARKET_PRICE_SCALE,
  );
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
  minPriceSpiritStones: Number(STOCK_MARKET_MIN_PRICE_SPIRIT_STONES),
});



