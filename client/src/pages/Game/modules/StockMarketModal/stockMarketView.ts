/**
 * 股市弹窗视图派生工具。
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：把服务端股市 DTO 一次性派生成股票列表、持仓摘要、交易预览、标准 K 线、交易记录和收益详情展示模型。
 * 2. 不做什么：不发请求、不修改持仓状态、不重新实现服务端交易校验。
 *
 * 输入 / 输出：
 * - 输入：`StockMarketOverviewDto`、历史点、交易记录、当前选中股票、交易数量和当前灵石余额。
 * - 输出：弹窗 JSX 可直接读取的轻量字符串、色调标记、两位小数 K 线价格和预览数值。
 *
 * 数据流 / 状态流：
 * API DTO + 当前灵石余额 -> 本模块集中格式化、K 线派生、可买数量估算与索引选中项 -> StockMarketModal 渲染；交易数量变化 -> 交易预览模型。
 *
 * 复用设计说明：
 * - 概览列表、持仓摘要、历史 K 线和交易记录共用同一组金额、涨跌、时间格式化入口，避免 JSX 中散落重复计算。
 * - K 线开高低收和坐标只在历史数据变化时一次性派生，渲染层不做价格区间扫描。
 * - 选中股票在概览派生的一次遍历中确定，避免列表渲染后再 `find` 一次。
 * - 交易费用预览和可买数量都消费服务端下发的费率 DTO，实际扣费仍以服务端规则为准，降低业务规则漂移风险。
 *
 * 关键边界条件与坑点：
 * 1. 服务端金额已经限制在前端安全整数内，本模块只做展示格式化，不做额外兼容兜底。
 * 2. 历史点可能为空，此时必须输出空 K 线模型，避免弹窗打开时渲染无意义坐标。
 * 3. 历史 K 线的 OHLC 由后端 DTO 统一下发，前端只做格式化和图表数据收敛，避免前后端影线规则漂移。
 * 4. 股价是两位小数，成交金额仍是整数灵石，两个格式化入口不能混用。
 * 5. 可买数量按灵石余额和买入费用二分估算，不能按股数线性试算，否则高余额账号会产生无意义循环。
 */
import type {
  StockMarketHistoryPointDto,
  StockMarketOverviewDto,
  StockMarketProfitDetailDto,
  StockMarketProfitDailyDto,
  StockMarketStockDto,
  StockMarketTradeRulesDto,
  StockMarketTradeRecordDto,
} from '../../../../services/api';

export type StockMarketTone = 'up' | 'down' | 'flat';

export interface StockMarketStockView {
  stock: StockMarketStockDto;
  selected: boolean;
  hasHolding: boolean;
  changeTone: StockMarketTone;
  priceText: string;
  changeText: string;
  holdingQtyText: string;
  holdingMarketValueText: string;
  holdingSummaryText: string;
  unrealizedPnlText: string;
  unrealizedPnlPercentText: string;
  unrealizedPnlTone: StockMarketTone;
  maxSellQtyText: string;
}

export interface StockMarketPortfolioView {
  totalHoldingQtyText: string;
  totalCostText: string;
  totalMarketValueText: string;
  totalUnrealizedPnlText: string;
  totalUnrealizedPnlPercentText: string;
  totalUnrealizedPnlTone: StockMarketTone;
}

export interface StockMarketOverviewViewModel {
  stocks: StockMarketStockView[];
  selectedStock: StockMarketStockView | null;
  portfolio: StockMarketPortfolioView;
  nextRefreshText: string;
}

export interface StockMarketTradePreview {
  quantity: number;
  grossAmount: number;
  sellGrossAmount: number;
  commissionAmount: number;
  sellCommissionAmount: number;
  stampDutyAmount: number;
  transferFeeAmount: number;
  sellTransferFeeAmount: number;
  buyFeeAmount: number;
  sellFeeAmount: number;
  buyCost: number;
  sellReceive: number;
  maxAffordableBuyQty: number;
  maxSellQty: number;
  maxTradeQty: number;
  grossAmountText: string;
  sellGrossAmountText: string;
  commissionAmountText: string;
  sellCommissionAmountText: string;
  stampDutyAmountText: string;
  transferFeeAmountText: string;
  sellTransferFeeAmountText: string;
  buyFeeAmountText: string;
  sellFeeAmountText: string;
  buyCostText: string;
  sellReceiveText: string;
  maxAffordableBuyQtyText: string;
  maxSellQtyText: string;
}

export interface StockMarketCandlestickView {
  key: string;
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  openPriceText: string;
  highPriceText: string;
  lowPriceText: string;
  closePriceText: string;
  changeText: string;
  tone: StockMarketTone;
  timeText: string;
  reasonText: string;
}

export interface StockMarketMovingAveragePointView {
  time: number;
  value: number;
}

export interface StockMarketMovingAverageView {
  key: 'ma5' | 'ma10' | 'ma30';
  labelText: string;
  valueText: string;
  data: StockMarketMovingAveragePointView[];
}

export interface StockMarketHistoryViewModel {
  candlesticks: StockMarketCandlestickView[];
  movingAverages: StockMarketMovingAverageView[];
}

export interface StockMarketTradeRecordView {
  id: number;
  sideText: string;
  sideTone: StockMarketTone;
  stockText: string;
  quantityText: string;
  unitPriceText: string;
  grossAmountText: string;
  feeText: string;
  netAmountText: string;
  realizedPnlText: string;
  realizedPnlTone: StockMarketTone;
  timeText: string;
}

export interface StockMarketProfitSummaryView {
  totalHoldingQtyText: string;
  totalMarketValueText: string;
  totalCostText: string;
  realizedPnlText: string;
  realizedPnlTone: StockMarketTone;
  unrealizedPnlText: string;
  unrealizedPnlTone: StockMarketTone;
  totalPnlText: string;
  totalPnlTone: StockMarketTone;
}

export interface StockMarketProfitDailyView {
  dayKey: string;
  dailyPnlText: string;
  dailyPnlTone: StockMarketTone;
  totalPnlText: string;
  totalPnlTone: StockMarketTone;
  realizedPnlText: string;
  realizedPnlTone: StockMarketTone;
  unrealizedPnlText: string;
  unrealizedPnlTone: StockMarketTone;
  totalMarketValueText: string;
  totalCostText: string;
}

export interface StockMarketProfitDetailViewModel {
  summary: StockMarketProfitSummaryView;
  dailyRows: StockMarketProfitDailyView[];
}

type StockMarketCandlestickDraft = {
  point: StockMarketHistoryPointDto;
  openPrice: number;
  highPrice: number;
  lowPrice: number;
  closePrice: number;
  time: number;
};

const STOCK_MARKET_MA_PERIODS: ReadonlyArray<{
  key: StockMarketMovingAverageView['key'];
  labelText: string;
  period: number;
}> = [
    { key: 'ma5', labelText: 'MA5', period: 5 },
    { key: 'ma10', labelText: 'MA10', period: 10 },
    { key: 'ma30', labelText: 'MA30', period: 30 },
  ];

const integerFormatter = new Intl.NumberFormat('zh-CN', {
  maximumFractionDigits: 0,
});

const priceFormatter = new Intl.NumberFormat('zh-CN', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const dateTimeFormatter = new Intl.DateTimeFormat('zh-CN', {
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

const toFiniteInteger = (value: number): number => {
  return Number.isFinite(value) ? Math.trunc(value) : 0;
};

const toFiniteNumber = (value: number): number => {
  return Number.isFinite(value) ? value : 0;
};

export const formatStockMarketCurrency = (value: number): string => {
  return `${integerFormatter.format(toFiniteInteger(value))} 灵石`;
};

export const formatStockMarketPrice = (value: number): string => {
  return `${priceFormatter.format(toFiniteNumber(value))} 灵石`;
};

export const formatStockMarketQuantity = (value: number): string => {
  return `${integerFormatter.format(toFiniteInteger(value))} 股`;
};

export const resolveStockMarketTone = (value: number): StockMarketTone => {
  if (value > 0) return 'up';
  if (value < 0) return 'down';
  return 'flat';
};

export const getStockMarketToneClassName = (tone: StockMarketTone): string => `is-${tone}`;

export const formatStockMarketBps = (bps: number): string => {
  const normalized = toFiniteInteger(bps);
  const prefix = normalized > 0 ? '+' : '';
  return `${prefix}${(normalized / 100).toFixed(2)}%`;
};

const formatStockMarketPnlPercent = (pnl: number, cost: number): string => {
  const normalizedCost = toFiniteInteger(cost);
  if (normalizedCost <= 0) return '--';
  const pnlBps = Math.round((toFiniteInteger(pnl) / normalizedCost) * 10_000);
  return formatStockMarketBps(pnlBps);
};

export const formatStockMarketSignedCurrency = (value: number): string => {
  const normalized = toFiniteInteger(value);
  if (normalized === 0) return formatStockMarketCurrency(0);
  return `${normalized > 0 ? '+' : '-'}${formatStockMarketCurrency(Math.abs(normalized))}`;
};

const formatStockMarketTime = (timestamp: number): string => {
  return dateTimeFormatter.format(new Date(timestamp));
};

const formatStockMarketAveragePrice = (value: number): string => {
  return toFiniteNumber(value).toFixed(2);
};

const toStockMarketChartTime = (timestamp: number): number => {
  return Math.trunc(timestamp / 1000);
};

const calculateStockMarketFeeComponent = (
  grossAmount: number,
  rate: number,
  feeRateDenominator: number,
): number => {
  if (grossAmount <= 0 || rate <= 0 || feeRateDenominator <= 0) return 0;
  return Math.ceil((grossAmount * rate) / feeRateDenominator);
};

const STOCK_MARKET_FLOAT_EPSILON = 1e-9;

const ceilStockMarketCurrencyAmount = (value: number): number => {
  return Math.max(0, Math.ceil(value - STOCK_MARKET_FLOAT_EPSILON));
};

const floorStockMarketCurrencyAmount = (value: number): number => {
  return Math.max(0, Math.floor(value + STOCK_MARKET_FLOAT_EPSILON));
};

const calculateStockMarketBuyAmounts = (
  unitPrice: number,
  quantity: number,
  tradeRules: StockMarketTradeRulesDto,
): {
  grossAmount: number;
  commissionAmount: number;
  transferFeeAmount: number;
  buyFeeAmount: number;
  buyCost: number;
} => {
  const rawGrossAmount = Math.max(0, toFiniteNumber(unitPrice) * Math.max(0, toFiniteInteger(quantity)));
  const grossAmount = ceilStockMarketCurrencyAmount(rawGrossAmount);
  const feeRateDenominator = toFiniteInteger(tradeRules.feeRateDenominator);
  const commissionAmount = calculateStockMarketFeeComponent(
    grossAmount,
    toFiniteInteger(tradeRules.commissionRate),
    feeRateDenominator,
  );
  const transferFeeAmount = calculateStockMarketFeeComponent(
    grossAmount,
    toFiniteInteger(tradeRules.transferFeeRate),
    feeRateDenominator,
  );
  const buyFeeAmount = commissionAmount + transferFeeAmount;
  return {
    grossAmount,
    commissionAmount,
    transferFeeAmount,
    buyFeeAmount,
    buyCost: grossAmount + buyFeeAmount,
  };
};

const calculateStockMarketAffordableBuyQuantity = (
  stock: StockMarketStockDto,
  availableSpiritStones: number,
  tradeRules: StockMarketTradeRulesDto,
): number => {
  const availableAmount = Math.max(0, toFiniteInteger(availableSpiritStones));
  const unitPrice = Math.max(1, toFiniteNumber(stock.priceSpiritStones));
  if (availableAmount <= 0) return 0;

  let low = 0;
  let high = Math.floor(availableAmount / unitPrice);
  while (low < high) {
    const mid = low + Math.floor((high - low + 1) / 2);
    const buyCost = calculateStockMarketBuyAmounts(stock.priceSpiritStones, mid, tradeRules).buyCost;
    if (buyCost <= availableAmount) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }
  return low;
};

const buildStockMarketMovingAverageViews = (
  drafts: readonly StockMarketCandlestickDraft[],
): StockMarketMovingAverageView[] => {
  return STOCK_MARKET_MA_PERIODS.map((config) => {
    let rollingSum = 0;
    const data: StockMarketMovingAveragePointView[] = [];

    drafts.forEach((draft, index) => {
      rollingSum += draft.closePrice;
      if (index >= config.period) {
        rollingSum -= drafts[index - config.period].closePrice;
      }
      if (index < config.period - 1) {
        return;
      }

      const average = rollingSum / config.period;
      data.push({
        time: draft.time,
        value: Number(average.toFixed(2)),
      });
    });

    const latestDrafts = drafts.slice(-config.period);
    const latestAverage = latestDrafts.length > 0
      ? latestDrafts.reduce((sum, draft) => sum + draft.closePrice, 0) / latestDrafts.length
      : 0;

    return {
      key: config.key,
      labelText: config.labelText,
      valueText: formatStockMarketAveragePrice(latestAverage),
      data,
    };
  });
};

const buildStockView = (
  stock: StockMarketStockDto,
  selectedStockId: string,
): StockMarketStockView => {
  const hasHolding = stock.holdingQty > 0;
  const holdingQtyText = formatStockMarketQuantity(stock.holdingQty);
  const holdingValueText = formatStockMarketCurrency(stock.holdingMarketValueSpiritStones);
  const unrealizedPnlPercentText = hasHolding
    ? formatStockMarketPnlPercent(stock.unrealizedPnlSpiritStones, stock.holdingCostSpiritStones)
    : '--';

  return {
    stock,
    selected: stock.stockId === selectedStockId,
    hasHolding,
    changeTone: resolveStockMarketTone(stock.lastChangeBps),
    priceText: formatStockMarketPrice(stock.priceSpiritStones),
    changeText: formatStockMarketBps(stock.lastChangeBps),
    holdingQtyText,
    holdingMarketValueText: holdingValueText,
    holdingSummaryText: hasHolding ? `持有 ${holdingQtyText} · 市值 ${holdingValueText}` : '未持有',
    unrealizedPnlText: formatStockMarketSignedCurrency(stock.unrealizedPnlSpiritStones),
    unrealizedPnlPercentText,
    unrealizedPnlTone: resolveStockMarketTone(stock.unrealizedPnlSpiritStones),
    maxSellQtyText: formatStockMarketQuantity(stock.maxSellQty),
  };
};

export const buildStockMarketOverviewViewModel = (
  overview: StockMarketOverviewDto,
  selectedStockId: string,
): StockMarketOverviewViewModel => {
  const fallbackSelectedStockId = selectedStockId || overview.stocks[0]?.stockId || '';
  const stocks: StockMarketStockView[] = [];
  let selectedStock: StockMarketStockView | null = null;

  for (const stock of overview.stocks) {
    const view = buildStockView(stock, fallbackSelectedStockId);
    stocks.push(view);
    if (view.selected) {
      selectedStock = view;
    }
  }

  if (!selectedStock && stocks.length > 0) {
    const firstStock = {
      ...stocks[0],
      selected: true,
    };
    stocks[0] = firstStock;
    selectedStock = firstStock;
  }

  return {
    stocks,
    selectedStock,
    portfolio: {
      totalHoldingQtyText: formatStockMarketQuantity(overview.portfolio.totalHoldingQty),
      totalCostText: formatStockMarketCurrency(overview.portfolio.totalCostSpiritStones),
      totalMarketValueText: formatStockMarketCurrency(overview.portfolio.totalMarketValueSpiritStones),
      totalUnrealizedPnlText: formatStockMarketSignedCurrency(overview.portfolio.totalUnrealizedPnlSpiritStones),
      totalUnrealizedPnlPercentText: formatStockMarketPnlPercent(
        overview.portfolio.totalUnrealizedPnlSpiritStones,
        overview.portfolio.totalCostSpiritStones,
      ),
      totalUnrealizedPnlTone: resolveStockMarketTone(overview.portfolio.totalUnrealizedPnlSpiritStones),
    },
    nextRefreshText: formatStockMarketTime(overview.nextRefreshAt),
  };
};

export const buildStockMarketTradePreview = (
  stock: StockMarketStockDto,
  quantity: number,
  tradeRules: StockMarketTradeRulesDto,
  availableSpiritStones: number,
): StockMarketTradePreview => {
  const normalizedQuantity = Math.max(0, toFiniteInteger(quantity));
  const buyAmounts = calculateStockMarketBuyAmounts(stock.priceSpiritStones, normalizedQuantity, tradeRules);
  const rawSellGrossAmount = Math.max(0, toFiniteNumber(stock.priceSpiritStones) * normalizedQuantity);
  const sellGrossAmount = floorStockMarketCurrencyAmount(rawSellGrossAmount);
  const feeRateDenominator = toFiniteInteger(tradeRules.feeRateDenominator);
  const sellCommissionAmount = calculateStockMarketFeeComponent(
    sellGrossAmount,
    toFiniteInteger(tradeRules.commissionRate),
    feeRateDenominator,
  );
  const stampDutyAmount = calculateStockMarketFeeComponent(
    sellGrossAmount,
    toFiniteInteger(tradeRules.stampDutyRate),
    feeRateDenominator,
  );
  const sellTransferFeeAmount = calculateStockMarketFeeComponent(
    sellGrossAmount,
    toFiniteInteger(tradeRules.transferFeeRate),
    feeRateDenominator,
  );
  const sellFeeAmount = sellCommissionAmount + stampDutyAmount + sellTransferFeeAmount;
  const sellReceive = Math.max(0, sellGrossAmount - sellFeeAmount);
  const maxAffordableBuyQty = calculateStockMarketAffordableBuyQuantity(stock, availableSpiritStones, tradeRules);
  const maxSellQty = Math.max(0, toFiniteInteger(stock.maxSellQty));

  return {
    quantity: normalizedQuantity,
    grossAmount: buyAmounts.grossAmount,
    sellGrossAmount,
    commissionAmount: buyAmounts.commissionAmount,
    sellCommissionAmount,
    stampDutyAmount,
    transferFeeAmount: buyAmounts.transferFeeAmount,
    sellTransferFeeAmount,
    buyFeeAmount: buyAmounts.buyFeeAmount,
    sellFeeAmount,
    buyCost: buyAmounts.buyCost,
    sellReceive,
    maxAffordableBuyQty,
    maxSellQty,
    maxTradeQty: Math.max(1, maxAffordableBuyQty, maxSellQty),
    grossAmountText: formatStockMarketCurrency(buyAmounts.grossAmount),
    sellGrossAmountText: formatStockMarketCurrency(sellGrossAmount),
    commissionAmountText: formatStockMarketCurrency(buyAmounts.commissionAmount),
    sellCommissionAmountText: formatStockMarketCurrency(sellCommissionAmount),
    stampDutyAmountText: formatStockMarketCurrency(stampDutyAmount),
    transferFeeAmountText: formatStockMarketCurrency(buyAmounts.transferFeeAmount),
    sellTransferFeeAmountText: formatStockMarketCurrency(sellTransferFeeAmount),
    buyFeeAmountText: formatStockMarketCurrency(buyAmounts.buyFeeAmount),
    sellFeeAmountText: formatStockMarketCurrency(sellFeeAmount),
    buyCostText: formatStockMarketCurrency(buyAmounts.buyCost),
    sellReceiveText: formatStockMarketCurrency(sellReceive),
    maxAffordableBuyQtyText: formatStockMarketQuantity(maxAffordableBuyQty),
    maxSellQtyText: formatStockMarketQuantity(maxSellQty),
  };
};

export const buildStockMarketHistoryViewModel = (
  points: readonly StockMarketHistoryPointDto[],
): StockMarketHistoryViewModel => {
  if (points.length <= 0) {
    return {
      candlesticks: [],
      movingAverages: [],
    };
  }

  const drafts: StockMarketCandlestickDraft[] = [];

  for (const point of points) {
    const openPrice = toFiniteNumber(point.openPriceSpiritStones);
    const highPrice = toFiniteNumber(point.highPriceSpiritStones);
    const lowPrice = toFiniteNumber(point.lowPriceSpiritStones);
    const closePrice = toFiniteNumber(point.closePriceSpiritStones);

    drafts.push({
      point,
      openPrice,
      highPrice,
      lowPrice,
      closePrice,
      time: toStockMarketChartTime(point.createdAt),
    });
  }

  const movingAverages = buildStockMarketMovingAverageViews(drafts);
  const candlesticks: StockMarketCandlestickView[] = drafts.map((draft) => {
    const { point } = draft;
    const isFlatBody = draft.openPrice === draft.closePrice;
    const candleTone = isFlatBody
      ? 'flat'
      : resolveStockMarketTone(draft.closePrice - draft.openPrice);
    const openPriceText = formatStockMarketPrice(draft.openPrice);
    const highPriceText = formatStockMarketPrice(draft.highPrice);
    const lowPriceText = formatStockMarketPrice(draft.lowPrice);
    const closePriceText = formatStockMarketPrice(draft.closePrice);
    const changeText = formatStockMarketBps(point.changeBps);
    const reasonText = point.reason ? `影响：${point.reason}` : '影响：无直接影响';

    return {
      key: `${point.stockId}:${point.createdAt}`,
      time: draft.time,
      open: draft.openPrice,
      high: draft.highPrice,
      low: draft.lowPrice,
      close: draft.closePrice,
      openPriceText,
      highPriceText,
      lowPriceText,
      closePriceText,
      changeText,
      tone: candleTone,
      timeText: formatStockMarketTime(point.createdAt),
      reasonText,
    };
  });
  return {
    candlesticks,
    movingAverages,
  };
};

export const buildStockMarketTradeRecordViews = (
  records: readonly StockMarketTradeRecordDto[],
): StockMarketTradeRecordView[] => {
  return records.map((record) => {
    const realizedPnl = record.realizedPnlSpiritStones ?? 0;
    return {
      id: record.id,
      sideText: record.side === 'buy' ? '买入' : '卖出',
      sideTone: record.side === 'buy' ? 'up' : 'down',
      stockText: `${record.stockName} · ${record.stockCode}`,
      quantityText: formatStockMarketQuantity(record.quantity),
      unitPriceText: formatStockMarketPrice(record.unitPriceSpiritStones),
      grossAmountText: formatStockMarketCurrency(record.grossAmountSpiritStones),
      feeText: formatStockMarketCurrency(record.feeSpiritStones),
      netAmountText: formatStockMarketCurrency(record.netAmountSpiritStones),
      realizedPnlText: record.realizedPnlSpiritStones === null
        ? '--'
        : formatStockMarketSignedCurrency(realizedPnl),
      realizedPnlTone: resolveStockMarketTone(realizedPnl),
      timeText: formatStockMarketTime(record.createdAt),
    };
  });
};

const buildStockMarketProfitDailyView = (
  record: StockMarketProfitDailyDto,
): StockMarketProfitDailyView => {
  return {
    dayKey: record.dayKey,
    dailyPnlText: formatStockMarketSignedCurrency(record.dailyPnlSpiritStones),
    dailyPnlTone: resolveStockMarketTone(record.dailyPnlSpiritStones),
    totalPnlText: formatStockMarketSignedCurrency(record.totalPnlSpiritStones),
    totalPnlTone: resolveStockMarketTone(record.totalPnlSpiritStones),
    realizedPnlText: formatStockMarketSignedCurrency(record.realizedPnlSpiritStones),
    realizedPnlTone: resolveStockMarketTone(record.realizedPnlSpiritStones),
    unrealizedPnlText: formatStockMarketSignedCurrency(record.unrealizedPnlSpiritStones),
    unrealizedPnlTone: resolveStockMarketTone(record.unrealizedPnlSpiritStones),
    totalMarketValueText: formatStockMarketCurrency(record.totalMarketValueSpiritStones),
    totalCostText: formatStockMarketCurrency(record.totalCostSpiritStones),
  };
};

export const buildStockMarketProfitDetailViewModel = (
  detail: StockMarketProfitDetailDto,
): StockMarketProfitDetailViewModel => {
  return {
    summary: {
      totalHoldingQtyText: formatStockMarketQuantity(detail.summary.totalHoldingQty),
      totalMarketValueText: formatStockMarketCurrency(detail.summary.totalMarketValueSpiritStones),
      totalCostText: formatStockMarketCurrency(detail.summary.totalCostSpiritStones),
      realizedPnlText: formatStockMarketSignedCurrency(detail.summary.realizedPnlSpiritStones),
      realizedPnlTone: resolveStockMarketTone(detail.summary.realizedPnlSpiritStones),
      unrealizedPnlText: formatStockMarketSignedCurrency(detail.summary.unrealizedPnlSpiritStones),
      unrealizedPnlTone: resolveStockMarketTone(detail.summary.unrealizedPnlSpiritStones),
      totalPnlText: formatStockMarketSignedCurrency(detail.summary.totalPnlSpiritStones),
      totalPnlTone: resolveStockMarketTone(detail.summary.totalPnlSpiritStones),
    },
    dailyRows: detail.daily.map((record) => buildStockMarketProfitDailyView(record)),
  };
};
