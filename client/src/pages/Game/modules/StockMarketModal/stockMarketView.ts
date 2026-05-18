/**
 * 股市弹窗视图派生工具。
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：把服务端股市 DTO 一次性派生成股票列表、持仓摘要、交易预览、标准 K 线和交易记录展示模型。
 * 2. 不做什么：不发请求、不修改持仓状态、不重新实现服务端交易校验。
 *
 * 输入 / 输出：
 * - 输入：`StockMarketOverviewDto`、历史点、交易记录、当前选中股票和交易数量。
 * - 输出：弹窗 JSX 可直接读取的轻量字符串、色调标记、K 线坐标和预览数值。
 *
 * 数据流 / 状态流：
 * API DTO -> 本模块集中格式化、K 线派生与索引选中项 -> StockMarketModal 渲染；交易数量变化 -> 交易预览模型。
 *
 * 复用设计说明：
 * - 概览列表、持仓摘要、历史 K 线和交易记录共用同一组金额、涨跌、时间格式化入口，避免 JSX 中散落重复计算。
 * - K 线开高低收和坐标只在历史数据变化时一次性派生，渲染层不做价格区间扫描。
 * - 选中股票在概览派生的一次遍历中确定，避免列表渲染后再 `find` 一次。
 * - 手续费预览只用于前端展示，实际扣费仍以服务端规则为准，降低业务规则漂移风险。
 *
 * 关键边界条件与坑点：
 * 1. 服务端金额已经限制在前端安全整数内，本模块只做展示格式化，不做额外兼容兜底。
 * 2. 历史点可能为空，此时必须输出空 K 线模型，避免弹窗打开时渲染无意义坐标。
 * 3. 后端当前只记录每个 tick 的收盘价，因此前端以相邻 tick 收盘价作为下一根 K 线开盘价，不伪造未记录的盘中波动。
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

export interface StockMarketCandlestickView {
  key: string;
  openPriceText: string;
  highPriceText: string;
  lowPriceText: string;
  closePriceText: string;
  changeText: string;
  tone: StockMarketTone;
  timeText: string;
  reason: string | null;
  tooltipText: string;
  x: number;
  bodyX: number;
  bodyY: number;
  bodyWidth: number;
  bodyHeight: number;
  wickTopY: number;
  wickBottomY: number;
  hitX: number;
  hitY: number;
  hitWidth: number;
  hitHeight: number;
  tooltipLeftPercent: number;
  tooltipTopPercent: number;
  tooltipPlacement: 'above' | 'below';
}

export interface StockMarketMovingAverageView {
  key: 'ma5' | 'ma10' | 'ma30';
  labelText: string;
  valueText: string;
  path: string;
}

export interface StockMarketPriceAxisView {
  key: string;
  y: number;
  priceText: string;
}

export interface StockMarketHistoryViewModel {
  candlesticks: StockMarketCandlestickView[];
  candlestickLookup: Map<string, StockMarketCandlestickView>;
  movingAverages: StockMarketMovingAverageView[];
  priceAxis: StockMarketPriceAxisView[];
  chartViewBox: string;
  chartPriceAxisX: number;
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

type StockMarketCandlestickDraft = {
  point: StockMarketHistoryPointDto;
  openPrice: number;
  highPrice: number;
  lowPrice: number;
  closePrice: number;
  x: number;
  bodyWidth: number;
};

const BPS_DENOMINATOR = 10_000;
const STOCK_MARKET_CHART_WIDTH = 720;
const STOCK_MARKET_CHART_HEIGHT = 220;
const STOCK_MARKET_CHART_PADDING_TOP = 28;
const STOCK_MARKET_CHART_PADDING_RIGHT = 54;
const STOCK_MARKET_CHART_PADDING_BOTTOM = 18;
const STOCK_MARKET_CHART_PADDING_LEFT = 8;
const STOCK_MARKET_CHART_BODY_MIN_HEIGHT = 2;
const STOCK_MARKET_PRICE_AXIS_COUNT = 4;
const STOCK_MARKET_TOOLTIP_BELOW_THRESHOLD_Y = 104;

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

export const getStockMarketToneClassName = (tone: StockMarketTone): string => `is-${tone}`;

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

const formatStockMarketAveragePrice = (value: number): string => {
  return value.toFixed(2);
};

const formatStockMarketAxisPrice = (value: number): string => {
  return integerFormatter.format(Math.round(value));
};

const deriveFirstStockMarketOpenPrice = (closePrice: number, changeBps: number): number => {
  const normalizedClosePrice = Math.max(1, toFiniteInteger(closePrice));
  if (changeBps === 0) return normalizedClosePrice;
  return Math.max(
    1,
    Math.round((normalizedClosePrice * BPS_DENOMINATOR) / (BPS_DENOMINATOR + changeBps)),
  );
};

const resolveStockMarketChartY = (
  price: number,
  minPrice: number,
  maxPrice: number,
): number => {
  const innerHeight = STOCK_MARKET_CHART_HEIGHT
    - STOCK_MARKET_CHART_PADDING_TOP
    - STOCK_MARKET_CHART_PADDING_BOTTOM;
  if (maxPrice <= minPrice) return STOCK_MARKET_CHART_PADDING_TOP + innerHeight / 2;
  return STOCK_MARKET_CHART_PADDING_TOP
    + ((maxPrice - price) / (maxPrice - minPrice)) * innerHeight;
};

const buildStockMarketMovingAverageViews = (
  drafts: readonly StockMarketCandlestickDraft[],
  minPrice: number,
  maxPrice: number,
): StockMarketMovingAverageView[] => {
  return STOCK_MARKET_MA_PERIODS.map((config) => {
    let rollingSum = 0;
    const pathParts: string[] = [];

    drafts.forEach((draft, index) => {
      rollingSum += draft.closePrice;
      if (index >= config.period) {
        rollingSum -= drafts[index - config.period].closePrice;
      }
      if (index < config.period - 1) {
        return;
      }

      const average = rollingSum / config.period;
      const command = pathParts.length === 0 ? 'M' : 'L';
      pathParts.push(`${command}${draft.x.toFixed(2)} ${resolveStockMarketChartY(average, minPrice, maxPrice).toFixed(2)}`);
    });

    const latestDrafts = drafts.slice(-config.period);
    const latestAverage = latestDrafts.length > 0
      ? latestDrafts.reduce((sum, draft) => sum + draft.closePrice, 0) / latestDrafts.length
      : 0;

    return {
      key: config.key,
      labelText: config.labelText,
      valueText: formatStockMarketAveragePrice(latestAverage),
      path: pathParts.join(' '),
    };
  });
};

const buildStockMarketPriceAxis = (
  minPrice: number,
  maxPrice: number,
): StockMarketPriceAxisView[] => {
  const axis: StockMarketPriceAxisView[] = [];
  for (let index = 0; index < STOCK_MARKET_PRICE_AXIS_COUNT; index += 1) {
    const ratio = index / (STOCK_MARKET_PRICE_AXIS_COUNT - 1);
    const price = maxPrice - (maxPrice - minPrice) * ratio;
    axis.push({
      key: `axis:${index}`,
      y: resolveStockMarketChartY(price, minPrice, maxPrice),
      priceText: formatStockMarketAxisPrice(price),
    });
  }
  return axis;
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
  const chartViewBox = `0 0 ${STOCK_MARKET_CHART_WIDTH} ${STOCK_MARKET_CHART_HEIGHT}`;
  const chartPriceAxisX = STOCK_MARKET_CHART_WIDTH - STOCK_MARKET_CHART_PADDING_RIGHT + 8;

  if (points.length <= 0) {
    return {
      candlesticks: [],
      candlestickLookup: new Map<string, StockMarketCandlestickView>(),
      movingAverages: [],
      priceAxis: [],
      chartViewBox,
      chartPriceAxisX,
    };
  }

  const drafts: StockMarketCandlestickDraft[] = [];
  let minPrice = Number.POSITIVE_INFINITY;
  let maxPrice = Number.NEGATIVE_INFINITY;
  let previousClosePrice: number | null = null;
  const chartInnerWidth = STOCK_MARKET_CHART_WIDTH
    - STOCK_MARKET_CHART_PADDING_LEFT
    - STOCK_MARKET_CHART_PADDING_RIGHT;
  const candleSlotWidth = chartInnerWidth / points.length;
  const bodyWidth = Math.max(3, Math.min(9, candleSlotWidth * 0.56));

  for (const point of points) {
    const closePrice = toFiniteInteger(point.priceSpiritStones);
    const openPrice = previousClosePrice ?? deriveFirstStockMarketOpenPrice(closePrice, point.changeBps);
    const highPrice = Math.max(openPrice, closePrice);
    const lowPrice = Math.min(openPrice, closePrice);
    const x = STOCK_MARKET_CHART_PADDING_LEFT + candleSlotWidth * (drafts.length + 0.5);

    drafts.push({
      point,
      openPrice,
      highPrice,
      lowPrice,
      closePrice,
      x,
      bodyWidth,
    });

    if (lowPrice < minPrice) minPrice = lowPrice;
    if (highPrice > maxPrice) maxPrice = highPrice;
    previousClosePrice = closePrice;
  }

  const priceRange = maxPrice - minPrice;
  const pricePadding = priceRange > 0 ? Math.max(1, priceRange * 0.08) : 1;
  const chartMinPrice = Math.max(1, minPrice - pricePadding);
  const chartMaxPrice = maxPrice + pricePadding;
  const priceAxis = buildStockMarketPriceAxis(chartMinPrice, chartMaxPrice);
  const movingAverages = buildStockMarketMovingAverageViews(drafts, chartMinPrice, chartMaxPrice);
  const hitY = STOCK_MARKET_CHART_PADDING_TOP;
  const hitHeight = STOCK_MARKET_CHART_HEIGHT
    - STOCK_MARKET_CHART_PADDING_TOP
    - STOCK_MARKET_CHART_PADDING_BOTTOM;
  const candlesticks: StockMarketCandlestickView[] = drafts.map((draft) => {
    const { point } = draft;
    const openY = resolveStockMarketChartY(draft.openPrice, chartMinPrice, chartMaxPrice);
    const closeY = resolveStockMarketChartY(draft.closePrice, chartMinPrice, chartMaxPrice);
    const highY = resolveStockMarketChartY(draft.highPrice, chartMinPrice, chartMaxPrice);
    const lowY = resolveStockMarketChartY(draft.lowPrice, chartMinPrice, chartMaxPrice);
    const rawBodyHeight = Math.abs(closeY - openY);
    const bodyHeight = Math.max(STOCK_MARKET_CHART_BODY_MIN_HEIGHT, rawBodyHeight);
    const bodyY = Math.min(openY, closeY) - (bodyHeight - rawBodyHeight) / 2;
    const openPriceText = formatStockMarketCurrency(draft.openPrice);
    const highPriceText = formatStockMarketCurrency(draft.highPrice);
    const lowPriceText = formatStockMarketCurrency(draft.lowPrice);
    const closePriceText = formatStockMarketCurrency(draft.closePrice);
    const changeText = formatStockMarketBps(point.changeBps);
    const timeText = formatStockMarketTime(point.createdAt);
    const tooltipAnchorY = Math.min(highY, bodyY);

    return {
      key: `${point.stockId}:${point.createdAt}`,
      openPriceText,
      highPriceText,
      lowPriceText,
      closePriceText,
      changeText,
      tone: resolveStockMarketTone(point.changeBps),
      timeText,
      reason: point.reason,
      tooltipText: `${timeText} · 开 ${openPriceText} · 高 ${highPriceText} · 低 ${lowPriceText} · 收 ${closePriceText} · ${changeText}${point.reason ? ` · ${point.reason}` : ''}`,
      x: draft.x,
      bodyX: draft.x - draft.bodyWidth / 2,
      bodyY,
      bodyWidth: draft.bodyWidth,
      bodyHeight,
      wickTopY: highY,
      wickBottomY: lowY,
      hitX: draft.x - candleSlotWidth / 2,
      hitY,
      hitWidth: candleSlotWidth,
      hitHeight,
      tooltipLeftPercent: (draft.x / STOCK_MARKET_CHART_WIDTH) * 100,
      tooltipTopPercent: (tooltipAnchorY / STOCK_MARKET_CHART_HEIGHT) * 100,
      tooltipPlacement: tooltipAnchorY < STOCK_MARKET_TOOLTIP_BELOW_THRESHOLD_Y ? 'below' : 'above',
    };
  });
  const candlestickLookup = new Map<string, StockMarketCandlestickView>();
  for (const candlestick of candlesticks) {
    candlestickLookup.set(candlestick.key, candlestick);
  }
  return {
    candlesticks,
    candlestickLookup,
    movingAverages,
    priceAxis,
    chartViewBox,
    chartPriceAxisX,
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
