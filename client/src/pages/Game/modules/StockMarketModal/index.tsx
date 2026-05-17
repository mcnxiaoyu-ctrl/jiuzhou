/**
 * 股市弹窗。
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：提供游戏内股市概览、AI 新闻、选中股票走势、持仓摘要、买卖和交易记录。
 * 2. 不做什么：不复用坊市物品/伙伴交易 UI，不在前端决定实际成交价与资金扣增。
 *
 * 输入 / 输出：
 * - 输入：`open`、`onClose`。
 * - 输出：用户完成买卖后刷新股市概览，并通过后端推送同步角色灵石。
 *
 * 数据流 / 状态流：
 * 打开弹窗 -> 拉取 overview -> 选中股票时单独拉取 history -> 买卖成功后后台刷新 overview/trades。
 *
 * 复用设计说明：
 * - 请求 DTO 统一来自 `services/api/stockMarket`，展示派生统一来自 `stockMarketView`，弹窗只负责交互状态。
 * - 历史走势按选中股票延迟请求，避免概览首屏携带所有股票历史点。
 * - 买入/卖出共用同一个数量输入和交易预览，避免两套表单重复维护手续费展示。
 *
 * 关键边界条件与坑点：
 * 1. 自动错误 toast 由 axios 拦截器负责，买卖 catch 不重复弹失败提示。
 * 2. 组件卸载或关闭时清空本地状态，避免下次打开沿用过期选中股票与历史点。
 */
import {
  App,
  Button,
  Empty,
  InputNumber,
  Modal,
  Pagination,
  Spin,
  Tabs,
  Tag,
  Tooltip,
} from 'antd';
import {
  FallOutlined,
  LineChartOutlined,
  ReloadOutlined,
  ShoppingCartOutlined,
} from '@ant-design/icons';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  buyStockMarketStock,
  getStockMarketHistory,
  getStockMarketOverview,
  getStockMarketTrades,
  sellStockMarketStock,
  type StockMarketHistoryPointDto,
  type StockMarketOverviewDto,
  type StockMarketTradeRecordDto,
} from '../../../../services/api';
import { SILENT_API_REQUEST_CONFIG } from '../../../../services/api/requestConfig';
import {
  buildStockMarketHistoryViewModel,
  buildStockMarketOverviewViewModel,
  buildStockMarketTradePreview,
  buildStockMarketTradeRecordViews,
  formatStockMarketBps,
  formatStockMarketCurrency,
  resolveStockMarketTone,
  type StockMarketTone,
} from './stockMarketView';
import './index.scss';

interface StockMarketModalProps {
  open: boolean;
  onClose: () => void;
}

type StockMarketRefreshMode = 'initial' | 'background';
type StockMarketActionKey = '' | 'buy' | 'sell';

const STOCK_MARKET_DEFAULT_TRADE_PAGE_SIZE = 20;

const getToneClassName = (tone: StockMarketTone): string => `is-${tone}`;

const StockMarketModal: React.FC<StockMarketModalProps> = ({ open, onClose }) => {
  const { message } = App.useApp();
  const [overview, setOverview] = useState<StockMarketOverviewDto | null>(null);
  const [selectedStockId, setSelectedStockId] = useState('');
  const [quantity, setQuantity] = useState(1);
  const [loading, setLoading] = useState(false);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyPoints, setHistoryPoints] = useState<StockMarketHistoryPointDto[]>([]);
  const [activeTab, setActiveTab] = useState('market');
  const [tradeRecords, setTradeRecords] = useState<StockMarketTradeRecordDto[]>([]);
  const [tradeTotal, setTradeTotal] = useState(0);
  const [tradePage, setTradePage] = useState(1);
  const [tradePageSize, setTradePageSize] = useState(STOCK_MARKET_DEFAULT_TRADE_PAGE_SIZE);
  const [tradesLoading, setTradesLoading] = useState(false);
  const [actionKey, setActionKey] = useState<StockMarketActionKey>('');

  const refreshOverview = useCallback(async (mode: StockMarketRefreshMode = 'initial') => {
    if (mode === 'initial') {
      setLoading(true);
    }
    try {
      const response = await getStockMarketOverview(mode === 'background' ? SILENT_API_REQUEST_CONFIG : undefined);
      const nextOverview = response.data ?? null;
      setOverview(nextOverview);
      setSelectedStockId((current) => {
        if (!nextOverview) return '';
        const exists = nextOverview.stocks.some((stock) => stock.stockId === current);
        return exists ? current : nextOverview.stocks[0]?.stockId ?? '';
      });
    } catch {
      if (mode === 'initial') {
        setOverview(null);
      }
    } finally {
      if (mode === 'initial') {
        setLoading(false);
      }
    }
  }, []);

  const refreshTrades = useCallback(async (
    page: number,
    mode: StockMarketRefreshMode = 'initial',
  ) => {
    if (mode === 'initial') {
      setTradesLoading(true);
    }
    try {
      const response = await getStockMarketTrades(
        { page },
        mode === 'background' ? SILENT_API_REQUEST_CONFIG : undefined,
      );
      const data = response.data;
      setTradeRecords(data?.records ?? []);
      setTradeTotal(data?.total ?? 0);
      setTradePage(data?.page ?? page);
      setTradePageSize(data?.pageSize ?? STOCK_MARKET_DEFAULT_TRADE_PAGE_SIZE);
    } catch {
      if (mode === 'initial') {
        setTradeRecords([]);
        setTradeTotal(0);
      }
    } finally {
      if (mode === 'initial') {
        setTradesLoading(false);
      }
    }
  }, []);

  const overviewModel = useMemo(() => {
    return overview ? buildStockMarketOverviewViewModel(overview, selectedStockId) : null;
  }, [overview, selectedStockId]);

  const selectedStock = overviewModel?.selectedStock?.stock ?? null;
  const tradePreview = useMemo(() => {
    if (!selectedStock || !overview) return null;
    return buildStockMarketTradePreview(selectedStock, quantity, overview.tradeRules.feeBps);
  }, [overview, quantity, selectedStock]);
  const historyModel = useMemo(() => buildStockMarketHistoryViewModel(historyPoints), [historyPoints]);
  const tradeRecordViews = useMemo(() => buildStockMarketTradeRecordViews(tradeRecords), [tradeRecords]);

  useEffect(() => {
    if (!open || !selectedStockId) {
      setHistoryPoints([]);
      return undefined;
    }

    let cancelled = false;
    setHistoryLoading(true);
    void getStockMarketHistory(selectedStockId, SILENT_API_REQUEST_CONFIG)
      .then((response) => {
        if (!cancelled) {
          setHistoryPoints(response.data?.points ?? []);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setHistoryPoints([]);
        }
      })
      .finally(() => {
        if (!cancelled) {
          setHistoryLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [open, selectedStockId]);

  useEffect(() => {
    if (!open || activeTab !== 'records') return;
    void refreshTrades(tradePage);
  }, [activeTab, open, refreshTrades, tradePage]);

  const handleQuantityChange = useCallback((value: number | null) => {
    setQuantity(value === null ? 1 : Math.max(1, Math.trunc(value)));
  }, []);

  const handleTrade = useCallback(async (side: 'buy' | 'sell') => {
    if (!selectedStock || !tradePreview || tradePreview.quantity <= 0) return;
    setActionKey(side);
    try {
      const response = side === 'buy'
        ? await buyStockMarketStock({ stockId: selectedStock.stockId, quantity: tradePreview.quantity })
        : await sellStockMarketStock({ stockId: selectedStock.stockId, quantity: tradePreview.quantity });
      message.success(response.message || (side === 'buy' ? '买入成功' : '卖出成功'));
      await refreshOverview('background');
      if (activeTab === 'records') {
        await refreshTrades(tradePage, 'background');
      }
    } finally {
      setActionKey('');
    }
  }, [activeTab, message, refreshOverview, refreshTrades, selectedStock, tradePage, tradePreview]);

  const maxOrderQty = overview?.tradeRules.maxOrderQty ?? 1;
  const orderValueExceeded = Boolean(
    overview && tradePreview && tradePreview.grossAmount > overview.tradeRules.maxOrderValueSpiritStones,
  );
  const canSubmit = Boolean(selectedStock && tradePreview && tradePreview.quantity > 0 && !orderValueExceeded);
  const canSell = Boolean(canSubmit && selectedStock && tradePreview && selectedStock.holdingQty >= tradePreview.quantity);

  return (
    <Modal
      open={open}
      onCancel={onClose}
      footer={null}
      title={null}
      centered
      width={1040}
      className="stock-market-modal"
      destroyOnHidden
      afterOpenChange={(visible) => {
        if (!visible) {
          setOverview(null);
          setSelectedStockId('');
          setQuantity(1);
          setHistoryPoints([]);
          setTradeRecords([]);
          setTradeTotal(0);
          setTradePage(1);
          setActiveTab('market');
          setActionKey('');
          return;
        }
        void refreshOverview();
      }}
    >
      <div className="stock-market-shell">
        <div className="stock-market-header">
          <div>
            <div className="stock-market-title">股市</div>
            <div className="stock-market-subtitle">系统即时做市，新闻每小时刷新，成交按当前价结算</div>
          </div>
          <Button
            icon={<ReloadOutlined />}
            onClick={() => void refreshOverview()}
            loading={loading}
          >
            刷新
          </Button>
        </div>

        <div className="stock-market-body">
          {loading && !overviewModel ? (
            <div className="stock-market-loading">
              <Spin />
            </div>
          ) : null}

          {!loading && !overviewModel ? (
            <Empty className="stock-market-empty" description="暂无股市数据" />
          ) : null}

          {overview && overviewModel ? (
            <Tabs
              activeKey={activeTab}
              onChange={setActiveTab}
              items={[
                {
                  key: 'market',
                  label: '行情',
                  children: (
                    <div className="stock-market-grid">
                      <section className="stock-market-panel stock-market-news">
                        <div className="stock-market-section-head">
                          <span>本时辰新闻</span>
                          <Tag color="processing">下次 {overviewModel.nextRefreshText}</Tag>
                        </div>
                        {overview.latestNews ? (
                          <div className="stock-market-news-content">
                            <div className="stock-market-news-title">{overview.latestNews.headline}</div>
                            <div className="stock-market-news-summary">{overview.latestNews.summary}</div>
                            {overview.latestNews.impacts.length > 0 ? (
                              <div className="stock-market-impact-list">
                                {overview.latestNews.impacts.map((impact) => {
                                  const tone = resolveStockMarketTone(impact.changeBps);
                                  return (
                                    <Tag key={impact.stockId} className={`stock-market-impact ${getToneClassName(tone)}`}>
                                      {impact.stockName} {formatStockMarketBps(impact.changeBps)}
                                    </Tag>
                                  );
                                })}
                              </div>
                            ) : null}
                          </div>
                        ) : (
                          <div className="stock-market-muted">暂未生成新闻，等待下一次后台刷新</div>
                        )}
                      </section>

                      <section className="stock-market-panel stock-market-portfolio">
                        <div className="stock-market-section-head">
                          <span>持仓汇总</span>
                        </div>
                        <div className="stock-market-stat-grid">
                          <div>
                            <span>总股数</span>
                            <strong>{overviewModel.portfolio.totalHoldingQtyText}</strong>
                          </div>
                          <div>
                            <span>市值</span>
                            <strong>{overviewModel.portfolio.totalMarketValueText}</strong>
                          </div>
                          <div>
                            <span>成本</span>
                            <strong>{overviewModel.portfolio.totalCostText}</strong>
                          </div>
                          <div>
                            <span>浮盈亏</span>
                            <strong className={getToneClassName(overviewModel.portfolio.totalUnrealizedPnlTone)}>
                              {overviewModel.portfolio.totalUnrealizedPnlText}
                            </strong>
                          </div>
                        </div>
                      </section>

                      <section className="stock-market-panel stock-market-list-panel">
                        <div className="stock-market-section-head">
                          <span>股票列表</span>
                          <Tag>共 {overviewModel.stocks.length} 支</Tag>
                        </div>
                        <div className="stock-market-list">
                          {overviewModel.stocks.map((item) => (
                            <button
                              key={item.stock.stockId}
                              type="button"
                              className={`stock-market-stock-row${item.selected ? ' is-selected' : ''}`}
                              onClick={() => setSelectedStockId(item.stock.stockId)}
                            >
                              <span className="stock-market-stock-main">
                                <strong>{item.stock.name}</strong>
                                <span>{item.stock.code} · {item.stock.sector}</span>
                              </span>
                              <span className="stock-market-stock-price">
                                <strong>{item.priceText}</strong>
                                <em className={getToneClassName(item.changeTone)}>{item.changeText}</em>
                              </span>
                            </button>
                          ))}
                        </div>
                      </section>

                      <section className="stock-market-panel stock-market-detail">
                        {overviewModel.selectedStock && selectedStock && tradePreview ? (
                          <>
                            <div className="stock-market-detail-head">
                              <div>
                                <div className="stock-market-selected-name">
                                  {selectedStock.name}
                                  <Tag>{selectedStock.code}</Tag>
                                </div>
                                <div className="stock-market-selected-desc">{selectedStock.description}</div>
                              </div>
                              <div className="stock-market-selected-price">
                                <strong>{overviewModel.selectedStock.priceText}</strong>
                                <span className={getToneClassName(overviewModel.selectedStock.changeTone)}>
                                  {overviewModel.selectedStock.changeText}
                                </span>
                              </div>
                            </div>

                            <div className="stock-market-holding-grid">
                              <div>
                                <span>持仓</span>
                                <strong>{overviewModel.selectedStock.holdingQtyText}</strong>
                              </div>
                              <div>
                                <span>市值</span>
                                <strong>{overviewModel.selectedStock.holdingValueText}</strong>
                              </div>
                              <div>
                                <span>成本</span>
                                <strong>{overviewModel.selectedStock.holdingCostText}</strong>
                              </div>
                              <div>
                                <span>浮盈亏</span>
                                <strong className={getToneClassName(overviewModel.selectedStock.unrealizedPnlTone)}>
                                  {overviewModel.selectedStock.unrealizedPnlText}
                                </strong>
                              </div>
                            </div>

                            <div className="stock-market-trade-box">
                              <div className="stock-market-trade-input">
                                <span>数量</span>
                                <InputNumber<number>
                                  min={1}
                                  max={maxOrderQty}
                                  precision={0}
                                  value={quantity}
                                  onChange={handleQuantityChange}
                                />
                              </div>
                              <div className="stock-market-trade-preview">
                                <span>成交额 {tradePreview.grossAmountText}</span>
                                <span>手续费 {tradePreview.feeAmountText}</span>
                                <span>买入扣款 {tradePreview.buyCostText}</span>
                                <span>卖出到账 {tradePreview.sellReceiveText}</span>
                              </div>
                              {orderValueExceeded ? (
                                <div className="stock-market-warning">
                                  单笔成交额不可超过 {formatStockMarketCurrency(overview.tradeRules.maxOrderValueSpiritStones)}
                                </div>
                              ) : null}
                              <div className="stock-market-trade-actions">
                                <Button
                                  type="primary"
                                  icon={<ShoppingCartOutlined />}
                                  disabled={!canSubmit}
                                  loading={actionKey === 'buy'}
                                  onClick={() => void handleTrade('buy')}
                                >
                                  买入
                                </Button>
                                <Button
                                  icon={<FallOutlined />}
                                  disabled={!canSell}
                                  loading={actionKey === 'sell'}
                                  onClick={() => void handleTrade('sell')}
                                >
                                  卖出
                                </Button>
                              </div>
                            </div>

                            <div className="stock-market-history">
                              <div className="stock-market-section-head">
                                <span><LineChartOutlined /> 近期走势</span>
                                <span className={getToneClassName(historyModel.latestTone)}>
                                  {historyModel.latestPriceText} {historyModel.latestChangeText}
                                </span>
                              </div>
                              {historyLoading ? (
                                <div className="stock-market-history-loading">
                                  <Spin size="small" />
                                </div>
                              ) : null}
                              {!historyLoading && historyModel.points.length <= 0 ? (
                                <div className="stock-market-muted">暂无走势记录</div>
                              ) : null}
                              {!historyLoading && historyModel.points.length > 0 ? (
                                <div className="stock-market-chart">
                                  {historyModel.points.map((point) => (
                                    <Tooltip
                                      key={point.key}
                                      title={`${point.timeText} · ${point.priceText} · ${point.changeText}${point.reason ? ` · ${point.reason}` : ''}`}
                                    >
                                      <span
                                        className={`stock-market-chart-bar ${getToneClassName(point.tone)}`}
                                        style={{ height: `${point.heightPercent}%` }}
                                      />
                                    </Tooltip>
                                  ))}
                                </div>
                              ) : null}
                            </div>
                          </>
                        ) : (
                          <Empty description="请选择股票" />
                        )}
                      </section>
                    </div>
                  ),
                },
                {
                  key: 'records',
                  label: '交易记录',
                  children: (
                    <section className="stock-market-panel stock-market-record-panel">
                      <div className="stock-market-section-head">
                        <span>交易记录</span>
                        <Button
                          size="small"
                          icon={<ReloadOutlined />}
                          onClick={() => void refreshTrades(tradePage)}
                          loading={tradesLoading}
                        >
                          刷新
                        </Button>
                      </div>
                      {tradesLoading ? (
                        <div className="stock-market-history-loading">
                          <Spin size="small" />
                        </div>
                      ) : null}
                      {!tradesLoading && tradeRecordViews.length <= 0 ? (
                        <Empty description="暂无交易记录" />
                      ) : null}
                      {!tradesLoading && tradeRecordViews.length > 0 ? (
                        <div className="stock-market-record-list">
                          {tradeRecordViews.map((record) => (
                            <div key={record.id} className="stock-market-record-row">
                              <div className="stock-market-record-main">
                                <Tag className={getToneClassName(record.sideTone)}>
                                  {record.sideText}
                                </Tag>
                                <strong>{record.stockText}</strong>
                                <span>{record.quantityText} · 单价 {record.unitPriceText}</span>
                              </div>
                              <div className="stock-market-record-meta">
                                <span>成交 {record.grossAmountText}</span>
                                <span>手续费 {record.feeText}</span>
                                <span>净额 {record.netAmountText}</span>
                                <span className={getToneClassName(record.realizedPnlTone)}>盈亏 {record.realizedPnlText}</span>
                                <span>{record.timeText}</span>
                              </div>
                            </div>
                          ))}
                        </div>
                      ) : null}
                      {tradeTotal > tradePageSize ? (
                        <Pagination
                          className="stock-market-pagination"
                          size="small"
                          current={tradePage}
                          pageSize={tradePageSize}
                          total={tradeTotal}
                          showSizeChanger={false}
                          onChange={(page) => setTradePage(page)}
                        />
                      ) : null}
                    </section>
                  ),
                },
              ]}
            />
          ) : null}
        </div>
      </div>
    </Modal>
  );
};

export default StockMarketModal;
