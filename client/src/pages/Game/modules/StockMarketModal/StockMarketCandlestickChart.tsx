/**
 * 股市 K 线图组件。
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：渲染选中股票的近期标准 K 线、最新价和加载/空状态。
 * 2. 不做什么：不发起历史请求、不计算开高低收、不决定涨跌业务规则。
 *
 * 输入 / 输出：
 * - 输入：`model` 为 `stockMarketView` 已派生好的 K 线模型，`loading` 表示历史请求状态，当前价和涨跌来自选中股票概览。
 * - 输出：只包含展示用 DOM，父级弹窗不需要关心每根 K 线的坐标细节。
 *
 * 数据流 / 状态流：
 * history DTO -> `buildStockMarketHistoryViewModel` 一次性派生 K 线坐标 -> 本组件按坐标渲染；概览 DTO -> 选中股票当前价 -> 图表标题。
 *
 * 复用设计说明：
 * - 把 K 线 DOM 和 tooltip 结构从弹窗主文件拆出，避免主弹窗同时维护交易表单、新闻和图表细节。
 * - 色调 class 复用 `getStockMarketToneClassName`，和列表、持仓、记录保持同一涨跌颜色入口。
 * - K 线是近期走势的高频表现变化点，集中到本组件后后续改视觉样式不影响数据派生与交易逻辑。
 *
 * 关键边界条件与坑点：
 * 1. `loading` 和空数据要互斥展示，避免请求中同时出现暂无记录。
 * 2. 坐标值来自纯函数派生，本组件不能重新扫描价格区间，否则会把计算重复带回渲染层。
 * 3. 标题涨跌必须用概览 quote 数据，不能用连续 K 线补点的 `0.00%` 覆盖当前股票涨跌。
 */
import { LineChartOutlined } from '@ant-design/icons';
import { Spin } from 'antd';
import {
  memo,
  useCallback,
  useMemo,
  useState,
  type CSSProperties,
  type FocusEvent,
  type PointerEvent,
} from 'react';
import {
  getStockMarketToneClassName,
  type StockMarketCandlestickView,
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

type StockMarketKlineTooltipStyle = CSSProperties & {
  '--stock-market-kline-tooltip-x': string;
  '--stock-market-kline-tooltip-y': string;
};

const buildStockMarketKlineTooltipStyle = (
  candlestick: StockMarketCandlestickView,
): StockMarketKlineTooltipStyle => ({
  '--stock-market-kline-tooltip-x': `${candlestick.tooltipLeftPercent}%`,
  '--stock-market-kline-tooltip-y': `${candlestick.tooltipTopPercent}%`,
});

const StockMarketCandlestickChart = memo(function StockMarketCandlestickChart({
  model,
  loading,
  latestPriceText,
  latestChangeText,
  latestTone,
}: StockMarketCandlestickChartProps) {
  const [hoveredKey, setHoveredKey] = useState<string | null>(null);
  const hoveredCandlestick = useMemo(() => {
    return hoveredKey ? model.candlestickLookup.get(hoveredKey) ?? null : null;
  }, [hoveredKey, model.candlestickLookup]);
  const tooltipStyle = useMemo(() => {
    return hoveredCandlestick ? buildStockMarketKlineTooltipStyle(hoveredCandlestick) : undefined;
  }, [hoveredCandlestick]);
  const handleCandlestickPointerEnter = useCallback((event: PointerEvent<SVGRectElement>) => {
    setHoveredKey(event.currentTarget.dataset.candlestickKey ?? null);
  }, []);
  const handleCandlestickFocus = useCallback((event: FocusEvent<SVGRectElement>) => {
    setHoveredKey(event.currentTarget.dataset.candlestickKey ?? null);
  }, []);
  const handleCandlestickLeave = useCallback(() => {
    setHoveredKey(null);
  }, []);

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
      {!loading && model.candlesticks.length <= 0 ? (
        <div className="stock-market-muted">暂无走势记录</div>
      ) : null}
      {!loading && model.candlesticks.length > 0 ? (
        <div className="stock-market-kline-chart" aria-label="股票近期K线">
          <div className="stock-market-kline-ma-list" aria-hidden="true">
            {model.movingAverages.map((average) => (
              <span key={average.key} className={`stock-market-kline-ma ${average.key}`}>
                {average.labelText}: {average.valueText}
              </span>
            ))}
          </div>
          <svg
            className="stock-market-kline-svg"
            viewBox={model.chartViewBox}
            preserveAspectRatio="none"
            role="img"
            aria-label="股票近期K线图"
          >
            {model.priceAxis.map((axis) => (
              <g key={axis.key}>
                <line
                  className="stock-market-kline-grid"
                  x1="0"
                  x2={model.chartPriceAxisX - 8}
                  y1={axis.y}
                  y2={axis.y}
                />
                <text
                  className="stock-market-kline-axis-text"
                  x={model.chartPriceAxisX}
                  y={axis.y}
                >
                  {axis.priceText}
                </text>
              </g>
            ))}
            {model.movingAverages.map((average) => (
              average.path ? (
                <path
                  key={average.key}
                  className={`stock-market-kline-ma-line ${average.key}`}
                  d={average.path}
                />
              ) : null
            ))}
            {model.candlesticks.map((candlestick) => (
              <g
                key={candlestick.key}
                className={`stock-market-kline-svg-candle ${getStockMarketToneClassName(candlestick.tone)}${hoveredKey === candlestick.key ? ' is-hovered' : ''}`}
                aria-label={candlestick.tooltipText}
              >
                <line
                  className="stock-market-kline-svg-wick"
                  x1={candlestick.x}
                  x2={candlestick.x}
                  y1={candlestick.wickTopY}
                  y2={candlestick.wickBottomY}
                />
                <rect
                  className="stock-market-kline-svg-body"
                  x={candlestick.bodyX}
                  y={candlestick.bodyY}
                  width={candlestick.bodyWidth}
                  height={candlestick.bodyHeight}
                />
                <rect
                  className="stock-market-kline-svg-hit"
                  x={candlestick.hitX}
                  y={candlestick.hitY}
                  width={candlestick.hitWidth}
                  height={candlestick.hitHeight}
                  data-candlestick-key={candlestick.key}
                  aria-label={candlestick.tooltipText}
                  tabIndex={0}
                  onPointerEnter={handleCandlestickPointerEnter}
                  onPointerLeave={handleCandlestickLeave}
                  onFocus={handleCandlestickFocus}
                  onBlur={handleCandlestickLeave}
                />
              </g>
            ))}
          </svg>
          {hoveredCandlestick && tooltipStyle ? (
            <div
              className={`stock-market-kline-tooltip stock-market-kline-tooltip--${hoveredCandlestick.tooltipPlacement} ${getStockMarketToneClassName(hoveredCandlestick.tone)}`}
              style={tooltipStyle}
              role="tooltip"
            >
              <div className="stock-market-kline-tooltip-head">
                <span>{hoveredCandlestick.timeText}</span>
                <strong>{hoveredCandlestick.changeText}</strong>
              </div>
              <div className="stock-market-kline-tooltip-grid">
                <span>开 <strong>{hoveredCandlestick.openPriceText}</strong></span>
                <span>高 <strong>{hoveredCandlestick.highPriceText}</strong></span>
                <span>低 <strong>{hoveredCandlestick.lowPriceText}</strong></span>
                <span>收 <strong>{hoveredCandlestick.closePriceText}</strong></span>
              </div>
              {hoveredCandlestick.reason ? (
                <div className="stock-market-kline-tooltip-reason">
                  {hoveredCandlestick.reason}
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
});

export default StockMarketCandlestickChart;
