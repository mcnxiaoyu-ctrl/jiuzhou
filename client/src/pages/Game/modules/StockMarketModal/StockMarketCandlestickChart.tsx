/**
 * 股市 K 线图组件。
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：用 TradingView Lightweight Charts 渲染选中股票的近期 K 线、均线、右侧价格轴和加载/空状态。
 * 2. 不做什么：不发起历史请求、不计算 OHLC、不决定涨跌业务规则。
 *
 * 输入 / 输出：
 * - 输入：`model` 为 `stockMarketView` 已派生好的 K 线和均线数据，`loading` 表示历史请求状态，当前价和涨跌来自选中股票概览。
 * - 输出：一个由第三方 canvas 图表承载的行情图，父级弹窗不关心图表库实例生命周期。
 *
 * 数据流 / 状态流：
 * history DTO -> `buildStockMarketHistoryViewModel` 一次性派生 OHLC 与均线 -> 本组件把数据写入 lightweight-charts series。
 *
 * 复用设计说明：
 * - 图表库实例、series 创建、尺寸自适应和主题同步集中在本组件，避免弹窗主文件维护第三方图表生命周期。
 * - 均线和 K 线数据仍复用 `stockMarketView` 的纯函数输出，后续换图表库也只影响本组件。
 * - K 线是近期走势的高频视觉变化点，交给 canvas 图表库可避免手写 SVG 文本缩放、右轴和 hover 的重复维护。
 *
 * 关键边界条件与坑点：
 * 1. 图表库只能在浏览器 DOM 容器可用后创建，卸载时必须 `remove`，避免 modal 反复打开泄漏 canvas。
 * 2. lightweight-charts 的时间戳单位是秒，数据层已经前置转换，组件只做类型收敛。
 * 3. 历史数据和 loading 状态会分批更新，图表实例必须绑定真实渲染条件，否则会在容器尚未挂载时错过初始化。
 * 4. 不能调用 `fitContent`，否则少量历史点会被强行撑满宽度，蜡烛尺寸会偏离官方示例的密集行情图。
 * 5. 价格轴自动缩放要额外扩展 min/max，避免最高价、最低价和均线贴住上下边缘。
 * 6. 许可证要求页面保留 TradingView 归属标识，因此不关闭库自带 attribution logo。
 */
import { LineChartOutlined } from '@ant-design/icons';
import { Spin } from 'antd';
import {
  CandlestickSeries,
  ColorType,
  CrosshairMode,
  LineSeries,
  LineStyle,
  createChart,
  type AutoscaleInfoProvider,
  type CandlestickData,
  type IChartApi,
  type ISeriesApi,
  type LineData,
  type MouseEventParams,
  type Point,
  type UTCTimestamp,
} from 'lightweight-charts';
import {
  memo,
  useEffect,
  useMemo,
  useRef,
} from 'react';
import {
  getStockMarketToneClassName,
  type StockMarketHistoryViewModel,
  type StockMarketTone,
} from './stockMarketView';

interface StockMarketCandlestickChartProps {
  model: StockMarketHistoryViewModel;
  loading: boolean;
  latestPriceText: string;
  latestChangeText: string;
  latestTone: StockMarketTone;
}

type StockMarketMovingAverageKey = StockMarketHistoryViewModel['movingAverages'][number]['key'];

type StockMarketChartRefs = {
  chart: IChartApi;
  candlestickSeries: ISeriesApi<'Candlestick'>;
  movingAverageSeriesByKey: Map<StockMarketMovingAverageKey, ISeriesApi<'Line'>>;
};

type StockMarketChartTooltipData = {
  timeText: string;
  changeText: string;
  openPriceText: string;
  highPriceText: string;
  lowPriceText: string;
  closePriceText: string;
  reasonText: string;
  tone: StockMarketTone;
};

type StockMarketChartTooltipRefs = {
  root: HTMLDivElement | null;
  time: HTMLDivElement | null;
  change: HTMLDivElement | null;
  open: HTMLDivElement | null;
  high: HTMLDivElement | null;
  low: HTMLDivElement | null;
  close: HTMLDivElement | null;
  reason: HTMLDivElement | null;
};

const STOCK_MARKET_CHART_COLORS = {
  upFill: '#f05b4f',
  upStroke: '#b9342d',
  downFill: '#58a678',
  downStroke: '#2f7f5c',
  ma5: '#4f88a7',
  ma10: '#d8bd80',
  ma30: '#9c8aa4',
};

const STOCK_MARKET_MA_COLOR_BY_KEY: Record<StockMarketMovingAverageKey, string> = {
  ma5: STOCK_MARKET_CHART_COLORS.ma5,
  ma10: STOCK_MARKET_CHART_COLORS.ma10,
  ma30: STOCK_MARKET_CHART_COLORS.ma30,
};

const STOCK_MARKET_MA_KEYS: readonly StockMarketMovingAverageKey[] = ['ma5', 'ma10', 'ma30'];
const STOCK_MARKET_CHART_BAR_SPACING = 6;
const STOCK_MARKET_CHART_MIN_BAR_SPACING = 3;
const STOCK_MARKET_CHART_RIGHT_OFFSET = 1;
const STOCK_MARKET_CHART_MIN_VISIBLE_BARS = 72;
const STOCK_MARKET_PRICE_RANGE_PADDING_RATIO = 0.12;
const STOCK_MARKET_PRICE_RANGE_MIN_PADDING = 2;
const STOCK_MARKET_TOOLTIP_OFFSET = 12;
const STOCK_MARKET_TOOLTIP_EDGE_GAP = 8;

const readCssColor = (
  element: HTMLElement,
  variableName: string,
  fallback: string,
): string => {
  const value = getComputedStyle(element).getPropertyValue(variableName).trim();
  return value || fallback;
};

const toChartTime = (value: number): UTCTimestamp => value as UTCTimestamp;

const resolveStockMarketVisibleBarCount = (containerWidth: number): number => {
  return Math.max(
    STOCK_MARKET_CHART_MIN_VISIBLE_BARS,
    Math.ceil(containerWidth / STOCK_MARKET_CHART_BAR_SPACING),
  );
};

const stockMarketAutoscaleInfoProvider: AutoscaleInfoProvider = (baseImplementation) => {
  const baseInfo = baseImplementation();
  if (!baseInfo?.priceRange) return baseInfo;

  const { minValue, maxValue } = baseInfo.priceRange;
  const valueRange = Math.max(0, maxValue - minValue);
  const padding = Math.max(
    STOCK_MARKET_PRICE_RANGE_MIN_PADDING,
    valueRange * STOCK_MARKET_PRICE_RANGE_PADDING_RATIO,
  );

  return {
    ...baseInfo,
    priceRange: {
      minValue: Math.max(0, minValue - padding),
      maxValue: maxValue + padding,
    },
  };
};

const hideStockMarketChartTooltip = (tooltipRoot: HTMLDivElement | null): void => {
  tooltipRoot?.classList.remove('is-visible');
};

const updateStockMarketChartTooltip = (
  refs: StockMarketChartTooltipRefs,
  container: HTMLDivElement | null,
  point: Point,
  data: StockMarketChartTooltipData,
): void => {
  if (
    !refs.root ||
    !refs.time ||
    !refs.change ||
    !refs.open ||
    !refs.high ||
    !refs.low ||
    !refs.close ||
    !refs.reason ||
    !container
  ) return;

  refs.time.textContent = data.timeText;
  refs.change.textContent = data.changeText;
  refs.change.className = `stock-market-kline-tooltip-change ${getStockMarketToneClassName(data.tone)}`;
  refs.open.textContent = `开 ${data.openPriceText}`;
  refs.high.textContent = `高 ${data.highPriceText}`;
  refs.low.textContent = `低 ${data.lowPriceText}`;
  refs.close.textContent = `收 ${data.closePriceText}`;
  refs.reason.textContent = data.reasonText;

  const tooltipWidth = refs.root.offsetWidth;
  const tooltipHeight = refs.root.offsetHeight;
  const maxLeft = Math.max(STOCK_MARKET_TOOLTIP_EDGE_GAP, container.clientWidth - tooltipWidth - STOCK_MARKET_TOOLTIP_EDGE_GAP);
  const maxTop = Math.max(STOCK_MARKET_TOOLTIP_EDGE_GAP, container.clientHeight - tooltipHeight - STOCK_MARKET_TOOLTIP_EDGE_GAP);
  const preferredLeft = point.x + STOCK_MARKET_TOOLTIP_OFFSET + tooltipWidth > container.clientWidth
    ? point.x - tooltipWidth - STOCK_MARKET_TOOLTIP_OFFSET
    : point.x + STOCK_MARKET_TOOLTIP_OFFSET;
  const preferredTop = point.y + STOCK_MARKET_TOOLTIP_OFFSET + tooltipHeight > container.clientHeight
    ? point.y - tooltipHeight - STOCK_MARKET_TOOLTIP_OFFSET
    : point.y + STOCK_MARKET_TOOLTIP_OFFSET;
  const left = Math.min(maxLeft, Math.max(STOCK_MARKET_TOOLTIP_EDGE_GAP, preferredLeft));
  const top = Math.min(maxTop, Math.max(STOCK_MARKET_TOOLTIP_EDGE_GAP, preferredTop));

  refs.root.style.transform = `translate3d(${Math.round(left)}px, ${Math.round(top)}px, 0)`;
  refs.root.classList.add('is-visible');
};

const StockMarketCandlestickChart = memo(function StockMarketCandlestickChart({
  model,
  loading,
  latestPriceText,
  latestChangeText,
  latestTone,
}: StockMarketCandlestickChartProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const tooltipRootRef = useRef<HTMLDivElement | null>(null);
  const tooltipTimeRef = useRef<HTMLDivElement | null>(null);
  const tooltipChangeRef = useRef<HTMLDivElement | null>(null);
  const tooltipOpenRef = useRef<HTMLDivElement | null>(null);
  const tooltipHighRef = useRef<HTMLDivElement | null>(null);
  const tooltipLowRef = useRef<HTMLDivElement | null>(null);
  const tooltipCloseRef = useRef<HTMLDivElement | null>(null);
  const tooltipReasonRef = useRef<HTMLDivElement | null>(null);
  const chartRefs = useRef<StockMarketChartRefs | null>(null);
  const tooltipDataByTimeRef = useRef<ReadonlyMap<number, StockMarketChartTooltipData>>(new Map());
  const hasChartData = model.candlesticks.length > 0;
  const shouldRenderChart = !loading && hasChartData;

  const candlestickData = useMemo<CandlestickData<UTCTimestamp>[]>(() => {
    return model.candlesticks.map((candlestick) => ({
      time: toChartTime(candlestick.time),
      open: candlestick.open,
      high: candlestick.high,
      low: candlestick.low,
      close: candlestick.close,
    }));
  }, [model.candlesticks]);

  const movingAverageDataByKey = useMemo(() => {
    const dataByKey = new Map<StockMarketMovingAverageKey, LineData<UTCTimestamp>[]>();
    for (const average of model.movingAverages) {
      dataByKey.set(average.key, average.data.map((point) => ({
        time: toChartTime(point.time),
        value: point.value,
      })));
    }
    return dataByKey;
  }, [model.movingAverages]);

  const tooltipDataByTime = useMemo(() => {
    const dataByTime = new Map<number, StockMarketChartTooltipData>();
    for (const candlestick of model.candlesticks) {
      dataByTime.set(candlestick.time, {
        timeText: candlestick.timeText,
        changeText: candlestick.changeText,
        openPriceText: candlestick.openPriceText,
        highPriceText: candlestick.highPriceText,
        lowPriceText: candlestick.lowPriceText,
        closePriceText: candlestick.closePriceText,
        reasonText: candlestick.reasonText,
        tone: candlestick.tone,
      });
    }
    return dataByTime;
  }, [model.candlesticks]);

  useEffect(() => {
    tooltipDataByTimeRef.current = tooltipDataByTime;
    hideStockMarketChartTooltip(tooltipRootRef.current);
  }, [tooltipDataByTime]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container || !shouldRenderChart) return undefined;

    const textColor = readCssColor(container, '--text-secondary', '#5f6368');
    const backgroundColor = readCssColor(container, '--panel-bg', '#ffffff');
    const gridColor = readCssColor(container, '--border-color-soft', 'rgba(0, 0, 0, 0.10)');

    const chart = createChart(container, {
      autoSize: true,
      height: container.clientHeight,
      layout: {
        background: { type: ColorType.Solid, color: backgroundColor },
        textColor,
        fontSize: 12,
        fontFamily: '"Microsoft YaHei", "PingFang SC", "Noto Sans SC", sans-serif',
        attributionLogo: true,
      },
      grid: {
        vertLines: {
          color: gridColor,
          style: LineStyle.Dotted,
          visible: true,
        },
        horzLines: {
          color: gridColor,
          style: LineStyle.Solid,
          visible: true,
        },
      },
      rightPriceScale: {
        borderVisible: false,
        entireTextOnly: false,
        minimumWidth: 52,
        scaleMargins: {
          top: 0.08,
          bottom: 0.06,
        },
        ticksVisible: false,
      },
      timeScale: {
        borderVisible: false,
        fixLeftEdge: false,
        fixRightEdge: true,
        rightOffset: STOCK_MARKET_CHART_RIGHT_OFFSET,
        barSpacing: STOCK_MARKET_CHART_BAR_SPACING,
        minBarSpacing: STOCK_MARKET_CHART_MIN_BAR_SPACING,
        timeVisible: false,
        visible: false,
      },
      crosshair: {
        mode: CrosshairMode.MagnetOHLC,
        horzLine: {
          color: textColor,
          style: LineStyle.Dotted,
          width: 1,
          visible: true,
          labelVisible: true,
        },
        vertLine: {
          color: textColor,
          style: LineStyle.Dotted,
          width: 1,
          visible: true,
          labelVisible: false,
        },
      },
      handleScroll: false,
      handleScale: false,
      localization: {
        priceFormatter: (price: number) => price.toFixed(2),
      },
    });

    const candlestickSeries = chart.addSeries(CandlestickSeries, {
      upColor: STOCK_MARKET_CHART_COLORS.upFill,
      downColor: STOCK_MARKET_CHART_COLORS.downFill,
      borderVisible: true,
      borderUpColor: STOCK_MARKET_CHART_COLORS.upStroke,
      borderDownColor: STOCK_MARKET_CHART_COLORS.downStroke,
      wickUpColor: STOCK_MARKET_CHART_COLORS.upStroke,
      wickDownColor: STOCK_MARKET_CHART_COLORS.downStroke,
      priceFormat: {
        type: 'price',
        precision: 2,
        minMove: 0.01,
      },
      priceLineVisible: true,
      priceLineStyle: LineStyle.Dotted,
      priceLineWidth: 1,
      lastValueVisible: true,
      autoscaleInfoProvider: stockMarketAutoscaleInfoProvider,
    });

    const movingAverageSeriesByKey = new Map<StockMarketMovingAverageKey, ISeriesApi<'Line'>>();
    for (const key of STOCK_MARKET_MA_KEYS) {
      const series = chart.addSeries(LineSeries, {
        color: STOCK_MARKET_MA_COLOR_BY_KEY[key],
        lineWidth: 2,
        lastValueVisible: false,
        priceLineVisible: false,
        crosshairMarkerVisible: false,
        autoscaleInfoProvider: stockMarketAutoscaleInfoProvider,
      });
      movingAverageSeriesByKey.set(key, series);
    }

    const handleCrosshairMove = (param: MouseEventParams): void => {
      if (!param.point || typeof param.time !== 'number') {
        hideStockMarketChartTooltip(tooltipRootRef.current);
        return;
      }

      const tooltipData = tooltipDataByTimeRef.current.get(param.time);
      if (!tooltipData) {
        hideStockMarketChartTooltip(tooltipRootRef.current);
        return;
      }

      updateStockMarketChartTooltip(
        {
          root: tooltipRootRef.current,
          time: tooltipTimeRef.current,
          change: tooltipChangeRef.current,
          open: tooltipOpenRef.current,
          high: tooltipHighRef.current,
          low: tooltipLowRef.current,
          close: tooltipCloseRef.current,
          reason: tooltipReasonRef.current,
        },
        containerRef.current,
        param.point,
        tooltipData,
      );
    };

    chartRefs.current = {
      chart,
      candlestickSeries,
      movingAverageSeriesByKey,
    };
    chart.subscribeCrosshairMove(handleCrosshairMove);

    return () => {
      chart.unsubscribeCrosshairMove(handleCrosshairMove);
      hideStockMarketChartTooltip(tooltipRootRef.current);
      chartRefs.current = null;
      chart.remove();
    };
  }, [shouldRenderChart]);

  useEffect(() => {
    const refs = chartRefs.current;
    const container = containerRef.current;
    if (!refs || !shouldRenderChart) return;
    refs.candlestickSeries.setData(candlestickData);
    for (const average of model.movingAverages) {
      refs.movingAverageSeriesByKey.get(average.key)?.setData(
        movingAverageDataByKey.get(average.key) ?? [],
      );
    }
    const visibleBarCount = resolveStockMarketVisibleBarCount(container?.clientWidth ?? 0);
    refs.chart.timeScale().setVisibleLogicalRange({
      from: candlestickData.length - visibleBarCount - STOCK_MARKET_CHART_RIGHT_OFFSET,
      to: candlestickData.length - 1 + STOCK_MARKET_CHART_RIGHT_OFFSET,
    });
  }, [candlestickData, model.movingAverages, movingAverageDataByKey, shouldRenderChart]);

  return (
    <div className="stock-market-history">
      <div className="stock-market-section-head">
        <span><LineChartOutlined /> 近期走势</span>
        <span className={getStockMarketToneClassName(latestTone)}>
          {latestPriceText} {latestChangeText}
        </span>
      </div>
      {loading ? (
        <div className="stock-market-history-loading">
          <Spin size="small" />
        </div>
      ) : null}
      {!loading && !hasChartData ? (
        <div className="stock-market-muted">暂无走势记录</div>
      ) : null}
      {shouldRenderChart ? (
        <div className="stock-market-kline-chart" aria-label="股票近期K线">
          <div className="stock-market-kline-ma-list" aria-hidden="true">
            {model.movingAverages.map((average) => (
              <span key={average.key} className={`stock-market-kline-ma ${average.key}`}>
                {average.labelText}: {average.valueText}
              </span>
            ))}
          </div>
          <div ref={containerRef} className="stock-market-kline-canvas" />
          <div ref={tooltipRootRef} className="stock-market-kline-tooltip" aria-hidden="true">
            <div className="stock-market-kline-tooltip-head">
              <div ref={tooltipTimeRef} className="stock-market-kline-tooltip-time" />
              <div ref={tooltipChangeRef} className="stock-market-kline-tooltip-change" />
            </div>
            <div className="stock-market-kline-tooltip-price-grid">
              <div ref={tooltipOpenRef} className="stock-market-kline-tooltip-price" />
              <div ref={tooltipHighRef} className="stock-market-kline-tooltip-price" />
              <div ref={tooltipLowRef} className="stock-market-kline-tooltip-price" />
              <div ref={tooltipCloseRef} className="stock-market-kline-tooltip-price" />
            </div>
            <div ref={tooltipReasonRef} className="stock-market-kline-tooltip-reason" />
          </div>
        </div>
      ) : null}
    </div>
  );
});

export default StockMarketCandlestickChart;
