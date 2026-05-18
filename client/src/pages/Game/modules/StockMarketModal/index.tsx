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
  Drawer,
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
  LeftOutlined,
  ReloadOutlined,
  RightOutlined,
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
  getStockMarketToneClassName,
  resolveStockMarketTone,
} from './stockMarketView';
import StockMarketCandlestickChart from './StockMarketCandlestickChart';
import { useIsMobile } from '../../shared/responsive';
import './index.scss';

interface StockMarketModalProps {
  open: boolean;
  onClose: () => void;
}

type StockMarketRefreshMode = 'initial' | 'background';
type StockMarketActionKey = '' | 'buy' | 'sell';

const STOCK_MARKET_DEFAULT_TRADE_PAGE_SIZE = 20;

const StockMarketModal: React.FC<StockMarketModalProps> = ({ open, onClose }) => {
  const { message } = App.useApp();
  const isMobile = useIsMobile();
  const [overview, setOverview] = useState<StockMarketOverviewDto | null>(null);
  const [selectedStockId, setSelectedStockId] = useState('');
  const [mobileDetailOpen, setMobileDetailOpen] = useState(false);
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
  const [newsIndex, setNewsIndex] = useState(0);

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
        return exists ? current : isMobile ? '' : nextOverview.stocks[0]?.stockId ?? '';
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
  }, [isMobile]);

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
  const selectedStockView = overviewModel?.selectedStock ?? null;
  const tradePreview = useMemo(() => {
    if (!selectedStock || !overview) return null;
    return buildStockMarketTradePreview(selectedStock, quantity, overview.tradeRules.feeBps);
  }, [overview, quantity, selectedStock]);
  const historyModel = useMemo(() => buildStockMarketHistoryViewModel(historyPoints), [historyPoints]);
  const tradeRecordViews = useMemo(() => buildStockMarketTradeRecordViews(tradeRecords), [tradeRecords]);
  const newsRecords = overview?.newsRecords ?? [];
  const activeNews = newsRecords[newsIndex] ?? null;

  useEffect(() => {
    setNewsIndex(0);
  }, [overview?.latestNews?.tickId]);

  useEffect(() => {
    setNewsIndex((current) => Math.min(current, Math.max(0, newsRecords.length - 1)));
  }, [newsRecords.length]);

  const handleShowNewerNews = useCallback(() => {
    setNewsIndex((current) => Math.max(0, current - 1));
  }, []);

  const handleShowOlderNews = useCallback(() => {
    setNewsIndex((current) => Math.min(Math.max(0, newsRecords.length - 1), current + 1));
  }, [newsRecords.length]);

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

  useEffect(() => {
    if (!isMobile) {
      setMobileDetailOpen(false);
    }
  }, [isMobile]);

  const handleQuantityChange = useCallback((value: number | null) => {
    setQuantity(value === null ? 1 : Math.max(1, Math.trunc(value)));
  }, []);

  useEffect(() => {
    if (!tradePreview) return;
    setQuantity((current) => {
      const normalized = Math.max(1, Math.trunc(current));
      return normalized > tradePreview.maxTradeQty ? tradePreview.maxTradeQty : normalized;
    });
  }, [tradePreview]);

  const handleSelectStock = useCallback((stockId: string) => {
    setSelectedStockId(stockId);
    if (isMobile) {
      setMobileDetailOpen(true);
    }
  }, [isMobile]);

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

  const maxTradeQty = tradePreview?.maxTradeQty ?? 1;
  const canBuy = Boolean(
    selectedStock && tradePreview && tradePreview.quantity > 0 && tradePreview.quantity <= tradePreview.maxBuyQty,
  );
  const canSell = Boolean(
    selectedStock && tradePreview && tradePreview.quantity > 0 && tradePreview.quantity <= tradePreview.maxSellQty,
  );

  const stockDetailContent = useMemo(() => {
    if (!overview || !selectedStockView || !selectedStock || !tradePreview) {
      return <Empty description="请选择股票" />;
    }

    return (
      <>
        <div className="stock-market-detail-head">
          <div>
            <div className="stock-market-selected-name">
              {selectedStock.name}
              <Tag>{selectedStock.code}</Tag>
            </div>
            <div className="stock-market-selected-desc">{selectedStock.description}</div>
          </div>
        </div>

        <div className="stock-market-trade-box">
          <div className="stock-market-trade-input">
            <span>数量</span>
            <InputNumber<number>
              size="small"
              min={1}
              max={maxTradeQty}
              precision={0}
              value={quantity}
              onChange={handleQuantityChange}
            />
          </div>
          <div className="stock-market-trade-preview">
            <span className="stock-market-trade-preview-item">
              <span>成交额</span>
              <strong>{tradePreview.grossAmountText}</strong>
            </span>
            <span className="stock-market-trade-preview-item">
              <span>手续费</span>
              <strong>{tradePreview.feeAmountText}</strong>
            </span>
            <span className="stock-market-trade-preview-item">
              <span>买入扣款</span>
              <strong>{tradePreview.buyCostText}</strong>
            </span>
            <span className="stock-market-trade-preview-item">
              <span>卖出到账</span>
              <strong>{tradePreview.sellReceiveText}</strong>
            </span>
          </div>
          <div className="stock-market-trade-limits">
            <span>可买 {tradePreview.maxBuyQtyText}</span>
            <span>可卖 {tradePreview.maxSellQtyText}</span>
          </div>
          <div className="stock-market-trade-actions">
            <Button
              type="primary"
              size="small"
              icon={<ShoppingCartOutlined />}
              disabled={!canBuy}
              loading={actionKey === 'buy'}
              onClick={() => void handleTrade('buy')}
            >
              买入
            </Button>
            <Button
              size="small"
              icon={<FallOutlined />}
              disabled={!canSell}
              loading={actionKey === 'sell'}
              onClick={() => void handleTrade('sell')}
            >
              卖出
            </Button>
          </div>
        </div>

        <StockMarketCandlestickChart
          loading={historyLoading}
          model={historyModel}
          latestPriceText={selectedStockView.priceText}
          latestChangeText={selectedStockView.changeText}
          latestTone={selectedStockView.changeTone}
        />
      </>
    );
  }, [
    actionKey,
    canBuy,
    canSell,
    handleQuantityChange,
    handleTrade,
    historyLoading,
    historyModel,
    maxTradeQty,
    overview,
    quantity,
    selectedStock,
    selectedStockView,
    tradePreview,
  ]);

  return (
    <Modal
      open={open}
      onCancel={onClose}
      footer={null}
      title={null}
      centered
      width={1040}
      className="stock-market-modal"
      wrapClassName="stock-market-modal-wrap"
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
          setMobileDetailOpen(false);
          setActiveTab('market');
          setActionKey('');
          setNewsIndex(0);
          return;
        }
        void refreshOverview();
      }}
    >
      <div className="stock-market-shell">
        <div className="stock-market-header">
          <div className="stock-market-header-main">
            <div className="stock-market-title">股市</div>
          </div>
          <Button
            className="stock-market-refresh-button"
            size="small"
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
                        <span>股市新闻</span>
                        <div className="stock-market-news-tools">
                          {newsRecords.length > 0 ? (
                            <>
                              <span className="stock-market-news-counter">
                                {newsIndex + 1}/{newsRecords.length}
                              </span>
                              <Tooltip title="查看更新的新闻">
                                <Button
                                  className="stock-market-news-nav"
                                  size="small"
                                  icon={<LeftOutlined />}
                                  aria-label="查看更新的股市新闻"
                                  disabled={newsIndex <= 0}
                                  onClick={handleShowNewerNews}
                                />
                              </Tooltip>
                              <Tooltip title="查看更早的新闻">
                                <Button
                                  className="stock-market-news-nav"
                                  size="small"
                                  icon={<RightOutlined />}
                                  aria-label="查看更早的股市新闻"
                                  disabled={newsIndex >= newsRecords.length - 1}
                                  onClick={handleShowOlderNews}
                                />
                              </Tooltip>
                            </>
                          ) : null}
                          <Tag color="processing">下次 {overviewModel.nextRefreshText}</Tag>
                        </div>
                      </div>
                      {activeNews ? (
                        <div className="stock-market-news-content">
                          <div className="stock-market-news-title">{activeNews.headline}</div>
                          <div className="stock-market-news-summary">{activeNews.summary}</div>
                          {activeNews.impacts.length > 0 ? (
                            <div className="stock-market-impact-list">
                              {activeNews.impacts.map((impact) => {
                                const tone = resolveStockMarketTone(impact.changeBps);
                                return (
                                  <Tag
                                    key={impact.stockId}
                                    className={`stock-market-impact ${getStockMarketToneClassName(tone)}`}
                                  >
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
                          <strong className={getStockMarketToneClassName(overviewModel.portfolio.totalUnrealizedPnlTone)}>
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
                            onClick={() => handleSelectStock(item.stock.stockId)}
                          >
                            <span className="stock-market-stock-main">
                              <strong>{item.stock.name}</strong>
                              <span>{item.stock.code} · {item.stock.sector}</span>
                              <span
                                className={`stock-market-stock-holding${item.hasHolding ? ' is-holding' : ''}`}
                              >
                                {item.holdingSummaryText}
                              </span>
                            </span>
                            <span className="stock-market-stock-price">
                              <strong>{item.priceText}</strong>
                              <em className={getStockMarketToneClassName(item.changeTone)}>{item.changeText}</em>
                              {item.hasHolding ? (
                                <span className={getStockMarketToneClassName(item.unrealizedPnlTone)}>
                                  {item.unrealizedPnlText}
                                </span>
                              ) : null}
                            </span>
                          </button>
                        ))}
                      </div>
                    </section>

                    <section className="stock-market-panel stock-market-detail stock-market-detail--inline">
                      {isMobile ? null : stockDetailContent}
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
                              <Tag className={getStockMarketToneClassName(record.sideTone)}>
                                {record.sideText}
                              </Tag>
                              <strong>{record.stockText}</strong>
                              <span>{record.quantityText} · 单价 {record.unitPriceText}</span>
                            </div>
                            <div className="stock-market-record-meta">
                              <span>成交 {record.grossAmountText}</span>
                              <span>手续费 {record.feeText}</span>
                              <span>净额 {record.netAmountText}</span>
                              <span className={getStockMarketToneClassName(record.realizedPnlTone)}>盈亏 {record.realizedPnlText}</span>
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

      {isMobile ? (
        <Drawer
          placement="bottom"
          open={mobileDetailOpen && Boolean(selectedStockView)}
          onClose={() => {
            setMobileDetailOpen(false);
            setSelectedStockId('');
          }}
          height="72dvh"
          title={selectedStock ? selectedStock.name : '股票详情'}
          className="stock-market-detail-drawer"
          styles={{ body: { padding: '10px 12px 12px' } }}
        >
          <div className="stock-market-panel stock-market-detail stock-market-detail--drawer">
            {stockDetailContent}
          </div>
        </Drawer>
      ) : null}
      </div>
    </Modal>
  );
};

export default StockMarketModal;
