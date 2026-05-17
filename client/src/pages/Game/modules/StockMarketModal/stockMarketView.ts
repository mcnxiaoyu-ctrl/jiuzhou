/**
 * 股市弹窗视图派生工具。
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：把服务端股市 DTO 一次性派生成股票列表、持仓摘要、交易预览、走势点和交易记录展示模型。
 * 2. 不做什么：不发请求、不修改持仓状态、不重新实现服务端交易校验。
 *
 * 输入 / 输出：
 * - 输入：`StockMarketOverviewDto`、历史点、交易记录、当前选中股票和交易数量。
 * - 输出：弹窗 JSX 可直接读取的轻量字符串、色调标记和预览数值。
 *
 * 数据流 / 状态流：
 * API DTO -> 本模块集中格式化与索引选中项 -> StockMarketModal 渲染；交易数量变化 -> 交易预览模型。
 *
 * 复用设计说明：
 * - 概览列表、持仓摘要、历史走势和交易记录共用同一组金额、涨跌、时间格式化入口，避免 JSX 中散落重复计算。
 * - 选中股票在概览派生的一次遍历中确定，避免列表渲染后再 `find` 一次。
 * - 手续费预览只用于前端展示，实际扣费仍以服务端规则为准，降低业务规则漂移风险。
 *
 * 关键边界条件与坑点：
 * 1. 服务端金额已经限制在前端安全整数内，本模块只做展示格式化，不做额外兼容兜底。
 * 2. 历史点可能为空，此时必须输出空走势模型，避免弹窗打开时渲染无意义坐标。
 */
import type {
  StockMarketHistoryPointDto,
  StockMarketOverviewDto,
  StockMarketStockDto,
  StockMarketTradeRecordDto,
} from '../../../../services/api';

export type StockMarketTone = 'up' | 'down' | 'flat';

export interface StockMarketStockView {
  stock: StockMarketStockDto;
  selected: boolean;
  changeTone: StockMarketTone;
  priceText: string;
  changeText: string;
  holdingQtyText: string;
  holdingValueText: string;
  holdingCostText: string;
  unrealizedPnlText: string;
  unrealizedPnlTone: StockMarketTone;
  maxBuyQtyText: string;
  maxSellQtyText: string;
}

export interface StockMarketPortfolioView {
  totalHoldingQtyText: string;
  totalCostText: string;
  totalMarketValueText: string;
  totalUnrealizedPnlText: string;
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
  feeAmount: number;
  buyCost: number;
  sellReceive: number;
  maxBuyQty: number;
  maxSellQty: number;
  maxTradeQty: number;
  grossAmountText: string;
  feeAmountText: string;
  buyCostText: string;
  sellReceiveText: string;
  maxBuyQtyText: string;
  maxSellQtyText: string;
}

export interface StockMarketHistoryPointView {
  key: string;
  priceText: string;
  changeText: string;
  tone: StockMarketTone;
  timeText: string;
  reason: string | null;
  heightPercent: number;
}

export interface StockMarketHistoryViewModel {
  points: StockMarketHistoryPointView[];
  latestPriceText: string;
  latestChangeText: string;
  latestTone: StockMarketTone;
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

const BPS_DENOMINATOR = 10_000;

const integerFormatter = new Intl.NumberFormat('zh-CN', {
  maximumFractionDigits: 0,
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

export const formatStockMarketCurrency = (value: number): string => {
  return `${integerFormatter.format(toFiniteInteger(value))} 灵石`;
};

export const formatStockMarketQuantity = (value: number): string => {
  return `${integerFormatter.format(toFiniteInteger(value))} 股`;
};

export const resolveStockMarketTone = (value: number): StockMarketTone => {
  if (value > 0) return 'up';
  if (value < 0) return 'down';
  return 'flat';
};

export const formatStockMarketBps = (bps: number): string => {
  const normalized = toFiniteInteger(bps);
  const prefix = normalized > 0 ? '+' : '';
  return `${prefix}${(normalized / 100).toFixed(2)}%`;
};

export const formatStockMarketSignedCurrency = (value: number): string => {
  const normalized = toFiniteInteger(value);
  if (normalized === 0) return formatStockMarketCurrency(0);
  return `${normalized > 0 ? '+' : '-'}${formatStockMarketCurrency(Math.abs(normalized))}`;
};

const formatStockMarketTime = (timestamp: number): string => {
  return dateTimeFormatter.format(new Date(timestamp));
};

const buildStockView = (
  stock: StockMarketStockDto,
  selectedStockId: string,
): StockMarketStockView => {
  return {
    stock,
    selected: stock.stockId === selectedStockId,
    changeTone: resolveStockMarketTone(stock.lastChangeBps),
    priceText: formatStockMarketCurrency(stock.priceSpiritStones),
    changeText: formatStockMarketBps(stock.lastChangeBps),
    holdingQtyText: formatStockMarketQuantity(stock.holdingQty),
    holdingValueText: formatStockMarketCurrency(stock.holdingMarketValueSpiritStones),
    holdingCostText: formatStockMarketCurrency(stock.holdingCostSpiritStones),
    unrealizedPnlText: formatStockMarketSignedCurrency(stock.unrealizedPnlSpiritStones),
    unrealizedPnlTone: resolveStockMarketTone(stock.unrealizedPnlSpiritStones),
    maxBuyQtyText: formatStockMarketQuantity(stock.maxBuyQty),
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
      totalUnrealizedPnlTone: resolveStockMarketTone(overview.portfolio.totalUnrealizedPnlSpiritStones),
    },
    nextRefreshText: formatStockMarketTime(overview.nextRefreshAt),
  };
};

export const buildStockMarketTradePreview = (
  stock: StockMarketStockDto,
  quantity: number,
  feeBps: number,
): StockMarketTradePreview => {
  const normalizedQuantity = Math.max(0, toFiniteInteger(quantity));
  const grossAmount = stock.priceSpiritStones * normalizedQuantity;
  const feeAmount = grossAmount > 0
    ? Math.ceil((grossAmount * feeBps) / BPS_DENOMINATOR)
    : 0;
  const buyCost = grossAmount + feeAmount;
  const sellReceive = Math.max(0, grossAmount - feeAmount);
  const maxBuyQty = Math.max(0, toFiniteInteger(stock.maxBuyQty));
  const maxSellQty = Math.max(0, toFiniteInteger(stock.maxSellQty));

  return {
    quantity: normalizedQuantity,
    grossAmount,
    feeAmount,
    buyCost,
    sellReceive,
    maxBuyQty,
    maxSellQty,
    maxTradeQty: Math.max(1, maxBuyQty, maxSellQty),
    grossAmountText: formatStockMarketCurrency(grossAmount),
    feeAmountText: formatStockMarketCurrency(feeAmount),
    buyCostText: formatStockMarketCurrency(buyCost),
    sellReceiveText: formatStockMarketCurrency(sellReceive),
    maxBuyQtyText: formatStockMarketQuantity(maxBuyQty),
    maxSellQtyText: formatStockMarketQuantity(maxSellQty),
  };
};

export const buildStockMarketHistoryViewModel = (
  points: readonly StockMarketHistoryPointDto[],
): StockMarketHistoryViewModel => {
  if (points.length <= 0) {
    return {
      points: [],
      latestPriceText: '--',
      latestChangeText: '--',
      latestTone: 'flat',
    };
  }

  let minPrice = points[0].priceSpiritStones;
  let maxPrice = points[0].priceSpiritStones;
  for (const point of points) {
    if (point.priceSpiritStones < minPrice) minPrice = point.priceSpiritStones;
    if (point.priceSpiritStones > maxPrice) maxPrice = point.priceSpiritStones;
  }

  const range = Math.max(1, maxPrice - minPrice);
  const viewPoints: StockMarketHistoryPointView[] = points.map((point) => ({
    key: `${point.stockId}:${point.createdAt}`,
    priceText: formatStockMarketCurrency(point.priceSpiritStones),
    changeText: formatStockMarketBps(point.changeBps),
    tone: resolveStockMarketTone(point.changeBps),
    timeText: formatStockMarketTime(point.createdAt),
    reason: point.reason,
    heightPercent: 18 + ((point.priceSpiritStones - minPrice) / range) * 72,
  }));
  const latestPoint = points[points.length - 1];

  return {
    points: viewPoints,
    latestPriceText: formatStockMarketCurrency(latestPoint.priceSpiritStones),
    latestChangeText: formatStockMarketBps(latestPoint.changeBps),
    latestTone: resolveStockMarketTone(latestPoint.changeBps),
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
      unitPriceText: formatStockMarketCurrency(record.unitPriceSpiritStones),
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
