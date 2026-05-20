/**
 * 股市弹窗。
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：提供游戏内股市概览、AI 新闻、选中股票走势、持仓摘要、买卖、清仓和交易记录。
 * 2. 不做什么：不复用坊市物品/伙伴交易 UI，不在前端决定实际成交价与资金扣增。
 *
 * 输入 / 输出：
 * - 输入：`open`、`onClose`、当前角色灵石余额。
 * - 输出：用户完成买卖后刷新股市概览，并通过后端推送同步角色灵石。
 *
 * 数据流 / 状态流：
 * 打开弹窗 -> 拉取 overview -> 选中股票时单独拉取 history -> 买卖或清仓成功后后台刷新 overview/trades。
 *
 * 复用设计说明：
 * - 请求 DTO 统一来自 `services/api/stockMarket`，展示派生统一来自 `stockMarketView`，弹窗只负责交互状态。
 * - 历史走势按选中股票延迟请求，避免概览首屏携带所有股票历史点。
 * - 买入/卖出共用同一个数量输入和交易费用预览，清仓走后端单一接口，避免前端循环卖出时重复维护交易规则。
 *
 * 关键边界条件与坑点：
 * 1. 自动错误 toast 由 axios 拦截器负责，买卖 catch 不重复弹失败提示。
 * 2. 组件卸载或关闭时清空本地状态，避免下次打开沿用过期选中股票与历史点。
 */
import {
  App,
  Button,
  Drawer,
  Dropdown,
  Empty,
  InputNumber,
  Modal,
  Pagination,
  Spin,
  Tabs,
  Tag,
  Tooltip,
  type MenuProps,
} from 'antd';
import {
  ClearOutlined,
  FallOutlined,
  LeftOutlined,
  ReloadOutlined,
  RightOutlined,
  ShoppingCartOutlined,
} from '@ant-design/icons';
import {
  cloneElement,
  isValidElement,
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import {
  buyStockMarketStock,
  clearStockMarketPosition,
  getStockMarketHistory,
  getStockMarketOverview,
  getStockMarketProfitDetail,
  getStockMarketTrades,
  sellStockMarketStock,
  type StockMarketHistoryPointDto,
  type StockMarketOverviewDto,
  type StockMarketProfitDetailDto,
  type StockMarketTradeRecordDto,
  type StockMarketTradeSide,
} from '../../../../services/api';
import { SILENT_API_REQUEST_CONFIG } from '../../../../services/api/requestConfig';
import {
  buildStockMarketHistoryViewModel,
  buildStockMarketOverviewViewModel,
  buildStockMarketProfitDetailViewModel,
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
  spiritStones: number;
}

type StockMarketRefreshMode = 'initial' | 'background';
type StockMarketActionKey = '' | 'buy' | 'buy-all' | 'sell' | 'clear-stock' | 'clear-all';
type StockMarketActiveTab = 'market' | 'profit' | 'records';

type StockMarketDropdownButtonElementProps = {
  className?: string;
  disabled?: boolean;
};

const STOCK_MARKET_DEFAULT_TRADE_PAGE_SIZE = 20;

const renderStockMarketTradeDropdownButtons = (
  buttons: ReactNode[],
  mainButtonClassName: string,
  mainButtonDisabled: boolean,
): ReactNode[] => {
  const [leftButton, rightButton] = buttons;
  const leftButtonToRender = isValidElement<StockMarketDropdownButtonElementProps>(leftButton)
    ? cloneElement(leftButton, {
      className: `${leftButton.props.className ?? ''} ${mainButtonClassName}`.trim(),
      disabled: mainButtonDisabled,
    })
    : leftButton;
  return [leftButtonToRender, rightButton];
};

const StockMarketModal: React.FC<StockMarketModalProps> = ({ open, onClose, spiritStones }) => {
  const { message, modal } = App.useApp();
  const isMobile = useIsMobile();
  const [overview, setOverview] = useState<StockMarketOverviewDto | null>(null);
  const [selectedStockId, setSelectedStockId] = useState('');
  const [mobileDetailOpen, setMobileDetailOpen] = useState(false);
  const [quantity, setQuantity] = useState(1);
  const [loading, setLoading] = useState(false);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyPoints, setHistoryPoints] = useState<StockMarketHistoryPointDto[]>([]);
  const [activeTab, setActiveTab] = useState<StockMarketActiveTab>('market');
  const [tradeRecords, setTradeRecords] = useState<StockMarketTradeRecordDto[]>([]);
  const [tradeTotal, setTradeTotal] = useState(0);
  const [tradePage, setTradePage] = useState(1);
  const [tradePageSize, setTradePageSize] = useState(STOCK_MARKET_DEFAULT_TRADE_PAGE_SIZE);
  const [tradesLoading, setTradesLoading] = useState(false);
  const [profitDetail, setProfitDetail] = useState<StockMarketProfitDetailDto | null>(null);
  const [profitLoading, setProfitLoading] = useState(false);
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

  const refreshProfitDetail = useCallback(async (mode: StockMarketRefreshMode = 'initial') => {
    if (mode === 'initial') {
      setProfitLoading(true);
    }
    try {
      const response = await getStockMarketProfitDetail(
        mode === 'background' ? SILENT_API_REQUEST_CONFIG : undefined,
      );
      setProfitDetail(response.data ?? null);
    } catch {
      if (mode === 'initial') {
        setProfitDetail(null);
      }
    } finally {
      if (mode === 'initial') {
        setProfitLoading(false);
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
    return buildStockMarketTradePreview(selectedStock, quantity, overview.tradeRules, spiritStones);
  }, [overview, quantity, selectedStock, spiritStones]);
  const historyModel = useMemo(() => buildStockMarketHistoryViewModel(historyPoints), [historyPoints]);
  const tradeRecordViews = useMemo(() => buildStockMarketTradeRecordViews(tradeRecords), [tradeRecords]);
  const profitDetailModel = useMemo(() => (
    profitDetail ? buildStockMarketProfitDetailViewModel(profitDetail) : null
  ), [profitDetail]);
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
    if (!open || activeTab !== 'profit' || profitDetail) return;
    void refreshProfitDetail();
  }, [activeTab, open, profitDetail, refreshProfitDetail]);

  useEffect(() => {
    if (!isMobile) {
      setMobileDetailOpen(false);
    }
  }, [isMobile]);

  const handleQuantityChange = useCallback((value: number | null) => {
    setQuantity(value === null ? 1 : Math.max(1, Math.trunc(value)));
  }, []);

  const handleUseTradeLimitQuantity = useCallback((nextQuantity: number) => {
    if (nextQuantity <= 0) return;
    setQuantity(nextQuantity);
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

  const handleTrade = useCallback(async (
    side: StockMarketTradeSide,
    overrideQuantity?: number,
    nextActionKey: StockMarketActionKey = side,
  ) => {
    if (!selectedStock || !tradePreview) return;

    const tradeQuantity = Math.max(0, Math.trunc(overrideQuantity ?? tradePreview.quantity));
    if (tradeQuantity <= 0) return;
    if (side === 'buy' && tradeQuantity > tradePreview.maxAffordableBuyQty) return;
    if (side === 'sell' && tradeQuantity > tradePreview.maxSellQty) return;

    setActionKey(nextActionKey);
    try {
      const response = side === 'buy'
        ? await buyStockMarketStock({ stockId: selectedStock.stockId, quantity: tradeQuantity })
        : await sellStockMarketStock({ stockId: selectedStock.stockId, quantity: tradeQuantity });
      message.success(response.message || (side === 'buy' ? '买入成功' : '卖出成功'));
      await refreshOverview('background');
      if (activeTab === 'records') {
        await refreshTrades(tradePage, 'background');
      }
      if (activeTab === 'profit') {
        await refreshProfitDetail('background');
      }
    } finally {
      setActionKey('');
    }
  }, [
    activeTab,
    message,
    refreshOverview,
    refreshProfitDetail,
    refreshTrades,
    selectedStock,
    tradePage,
    tradePreview,
  ]);

  const handleClearPosition = useCallback((scope: 'stock' | 'all') => {
    if (scope === 'stock' && (!selectedStock || !tradePreview || tradePreview.maxSellQty <= 0)) return;
    if (scope === 'all' && (!overview || overview.portfolio.totalHoldingQty <= 0)) return;

    const actionKey: StockMarketActionKey = scope === 'stock' ? 'clear-stock' : 'clear-all';
    const title = scope === 'stock' && selectedStock
      ? `确认清仓 ${selectedStock.name}？`
      : '确认全部清仓？';
    const content = scope === 'stock' && selectedStock
      ? `将按当前价卖出该股票全部 ${selectedStock.maxSellQty} 股。`
      : `将按当前价卖出全部持仓 ${overview?.portfolio.totalHoldingQty ?? 0} 股。`;

    modal.confirm({
      title,
      content,
      okText: '清仓',
      cancelText: '取消',
      okButtonProps: { danger: true },
      onOk: async () => {
        setActionKey(actionKey);
        try {
          const response = await clearStockMarketPosition(
            scope === 'stock' && selectedStock ? { stockId: selectedStock.stockId } : {},
          );
          message.success(response.message || '清仓成功');
          await refreshOverview('background');
          if (activeTab === 'records') {
            await refreshTrades(tradePage, 'background');
          }
          if (activeTab === 'profit') {
            await refreshProfitDetail('background');
          }
        } finally {
          setActionKey('');
        }
      },
    });
  }, [
    activeTab,
    message,
    modal,
    overview,
    refreshOverview,
    refreshProfitDetail,
    refreshTrades,
    selectedStock,
    tradePage,
    tradePreview,
  ]);

  const maxTradeQty = tradePreview?.maxTradeQty ?? 1;
  const canBuy = Boolean(
    selectedStock
    && tradePreview
    && tradePreview.quantity > 0
    && tradePreview.quantity <= tradePreview.maxAffordableBuyQty,
  );
  const maxAffordableBuyQty = tradePreview?.maxAffordableBuyQty ?? 0;
  const canBuyAll = Boolean(selectedStock && maxAffordableBuyQty > 0);
  const canSell = Boolean(
    selectedStock && tradePreview && tradePreview.quantity > 0 && tradePreview.quantity <= tradePreview.maxSellQty,
  );
  const canClearSelected = Boolean(selectedStock && tradePreview && tradePreview.maxSellQty > 0);
  const canClearAll = Boolean(overview && overview.portfolio.totalHoldingQty > 0);
  const buyActionMenuItems = useMemo<NonNullable<MenuProps['items']>>(() => [
    {
      key: 'buy-all',
      label: '全部买入',
      icon: <ShoppingCartOutlined />,
      disabled: !canBuyAll || actionKey !== '',
    },
  ], [actionKey, canBuyAll]);
  const handleBuyAll = useCallback(() => {
    if (!selectedStock || !tradePreview || maxAffordableBuyQty <= 0) return;

    modal.confirm({
      title: `确认全部买入 ${selectedStock.name}？`,
      content: `将按当前价买入该股票可买上限 ${tradePreview.maxAffordableBuyQtyText}。`,
      okText: '全部买入',
      cancelText: '取消',
      onOk: async () => {
        await handleTrade('buy', maxAffordableBuyQty, 'buy-all');
      },
    });
  }, [handleTrade, maxAffordableBuyQty, modal, selectedStock, tradePreview]);
  const handleBuyActionMenuClick = useCallback<NonNullable<MenuProps['onClick']>>(({ key }) => {
    if (key === 'buy-all') {
      handleBuyAll();
    }
  }, [handleBuyAll]);
  const sellActionMenuItems = useMemo<NonNullable<MenuProps['items']>>(() => [
    {
      key: 'clear-stock',
      label: '清仓',
      icon: <ClearOutlined />,
      disabled: !canClearSelected || actionKey === 'clear-stock',
    },
  ], [actionKey, canClearSelected]);
  const handleSellActionMenuClick = useCallback<NonNullable<MenuProps['onClick']>>(({ key }) => {
    if (key === 'clear-stock') {
      handleClearPosition('stock');
    }
  }, [handleClearPosition]);
  const renderBuyDropdownButtons = useCallback((buttons: ReactNode[]): ReactNode[] => {
    return renderStockMarketTradeDropdownButtons(
      buttons,
      'stock-market-buy-main-button',
      !canBuy || actionKey === 'buy-all',
    );
  }, [actionKey, canBuy]);
  const renderSellDropdownButtons = useCallback((buttons: ReactNode[]): ReactNode[] => {
    return renderStockMarketTradeDropdownButtons(
      buttons,
      'stock-market-sell-main-button',
      !canSell || actionKey === 'clear-stock',
    );
  }, [actionKey, canSell]);

  const handleTabChange = useCallback((key: string) => {
    if (key === 'market' || key === 'profit' || key === 'records') {
      setActiveTab(key);
    }
  }, []);

  const profitDetailContent = (() => {
    if (profitLoading && !profitDetailModel) {
      return (
        <div className="stock-market-history-loading">
          <Spin size="small" />
        </div>
      );
    }

    if (!profitDetailModel) {
      return <Empty description="暂无收益数据" />;
    }

    return (
      <>
        <div className="stock-market-stat-grid stock-market-profit-summary">
          <div>
            <span>总收益</span>
            <strong className={getStockMarketToneClassName(profitDetailModel.summary.totalPnlTone)}>
              {profitDetailModel.summary.totalPnlText}
            </strong>
          </div>
          <div>
            <span>已实现盈亏</span>
            <strong className={getStockMarketToneClassName(profitDetailModel.summary.realizedPnlTone)}>
              {profitDetailModel.summary.realizedPnlText}
            </strong>
          </div>
          <div>
            <span>持仓浮盈亏</span>
            <strong className={getStockMarketToneClassName(profitDetailModel.summary.unrealizedPnlTone)}>
              {profitDetailModel.summary.unrealizedPnlText}
            </strong>
          </div>
          <div>
            <span>总股数</span>
            <strong>{profitDetailModel.summary.totalHoldingQtyText}</strong>
          </div>
          <div>
            <span>当前市值</span>
            <strong>{profitDetailModel.summary.totalMarketValueText}</strong>
          </div>
          <div>
            <span>当前成本</span>
            <strong>{profitDetailModel.summary.totalCostText}</strong>
          </div>
        </div>

        {profitDetailModel.dailyRows.length <= 0 ? (
          <Empty description="暂无每日收益" />
        ) : (
          <div className="stock-market-profit-list">
            {profitDetailModel.dailyRows.map((row) => (
              <div key={row.dayKey} className="stock-market-profit-row">
                <div className="stock-market-profit-row-header">
                  <span className="profit-date">{row.dayKey}</span>
                  <span className={`profit-badge ${getStockMarketToneClassName(row.totalPnlTone)}`}>
                    累计盈亏 {row.totalPnlText}
                  </span>
                </div>
                <div className="stock-market-profit-row-grid">
                  <div className="profit-grid-item">
                    <span className="profit-grid-label">当日收益</span>
                    <strong className={`profit-grid-val ${getStockMarketToneClassName(row.dailyPnlTone)}`}>
                      {row.dailyPnlText}
                    </strong>
                  </div>
                  <div className="profit-grid-item">
                    <span className="profit-grid-label">已实现</span>
                    <strong className={`profit-grid-val ${getStockMarketToneClassName(row.realizedPnlTone)}`}>
                      {row.realizedPnlText}
                    </strong>
                  </div>
                  <div className="profit-grid-item">
                    <span className="profit-grid-label">持仓浮盈亏</span>
                    <strong className={`profit-grid-val ${getStockMarketToneClassName(row.unrealizedPnlTone)}`}>
                      {row.unrealizedPnlText}
                    </strong>
                  </div>
                  <div className="profit-grid-item">
                    <span className="profit-grid-label">持仓市值</span>
                    <strong className="profit-grid-val">{row.totalMarketValueText}</strong>
                  </div>
                  <div className="profit-grid-item">
                    <span className="profit-grid-label">持仓成本</span>
                    <strong className="profit-grid-val">{row.totalCostText}</strong>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </>
    );
  })();

  const stockDetailContent = (() => {
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
            <div className="stock-market-trade-quantity-control">
              <InputNumber<number>
                size="small"
                min={1}
                max={maxTradeQty}
                precision={0}
                value={quantity}
                onChange={handleQuantityChange}
              />
            </div>
          </div>
          <div className="stock-market-trade-actions">
            <Dropdown.Button
              className="stock-market-trade-dropdown stock-market-buy-dropdown"
              type="primary"
              size="small"
              trigger={['click']}
              placement="bottomRight"
              disabled={!canBuy && !canBuyAll}
              loading={actionKey === 'buy' || actionKey === 'buy-all'}
              buttonsRender={renderBuyDropdownButtons}
              menu={{
                items: buyActionMenuItems,
                onClick: handleBuyActionMenuClick,
              }}
              onClick={() => void handleTrade('buy')}
            >
              <span className="stock-market-trade-dropdown-label">
                <ShoppingCartOutlined />
                <span>买入</span>
              </span>
            </Dropdown.Button>
            <Dropdown.Button
              className="stock-market-trade-dropdown stock-market-sell-dropdown"
              size="small"
              trigger={['click']}
              placement="bottomRight"
              disabled={!canSell && !canClearSelected}
              loading={actionKey === 'sell'}
              buttonsRender={renderSellDropdownButtons}
              menu={{
                items: sellActionMenuItems,
                onClick: handleSellActionMenuClick,
              }}
              onClick={() => void handleTrade('sell')}
            >
              <span className="stock-market-trade-dropdown-label">
                <FallOutlined />
                <span>卖出</span>
              </span>
            </Dropdown.Button>
          </div>
          <div className="stock-market-trade-preview">
            <span className="stock-market-trade-preview-item">
              <span>买入成交额</span>
              <strong>{tradePreview.grossAmountText}</strong>
            </span>
            <span className="stock-market-trade-preview-item">
              <span>卖出成交额</span>
              <strong>{tradePreview.sellGrossAmountText}</strong>
            </span>
            <span className="stock-market-trade-preview-item">
              <span>买入佣金</span>
              <strong>{tradePreview.commissionAmountText}</strong>
            </span>
            <span className="stock-market-trade-preview-item">
              <span>卖出佣金</span>
              <strong>{tradePreview.sellCommissionAmountText}</strong>
            </span>
            <span className="stock-market-trade-preview-item">
              <span>卖出印花税</span>
              <strong>{tradePreview.stampDutyAmountText}</strong>
            </span>
            <span className="stock-market-trade-preview-item">
              <span>买入过户费</span>
              <strong>{tradePreview.transferFeeAmountText}</strong>
            </span>
            <span className="stock-market-trade-preview-item">
              <span>卖出过户费</span>
              <strong>{tradePreview.sellTransferFeeAmountText}</strong>
            </span>
            <span className="stock-market-trade-preview-item">
              <span>买入费用</span>
              <strong>{tradePreview.buyFeeAmountText}</strong>
            </span>
            <span className="stock-market-trade-preview-item">
              <span>卖出费用</span>
              <strong>{tradePreview.sellFeeAmountText}</strong>
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
            <div className="stock-market-trade-limit-group">
              <span className="limit-label">可买</span>
              <button
                type="button"
                className="stock-market-trade-limit-action"
                disabled={tradePreview.maxAffordableBuyQty <= 0}
                onClick={() => handleUseTradeLimitQuantity(Math.max(1, Math.floor(tradePreview.maxAffordableBuyQty * 0.25)))}
              >
                25%
              </button>
              <button
                type="button"
                className="stock-market-trade-limit-action"
                disabled={tradePreview.maxAffordableBuyQty <= 0}
                onClick={() => handleUseTradeLimitQuantity(Math.max(1, Math.floor(tradePreview.maxAffordableBuyQty * 0.5)))}
              >
                50%
              </button>
              <button
                type="button"
                className="stock-market-trade-limit-action"
                disabled={tradePreview.maxAffordableBuyQty <= 0}
                onClick={() => handleUseTradeLimitQuantity(Math.max(1, Math.floor(tradePreview.maxAffordableBuyQty * 0.75)))}
              >
                75%
              </button>
              <button
                type="button"
                className="stock-market-trade-limit-action max-btn"
                disabled={tradePreview.maxAffordableBuyQty <= 0}
                onClick={() => handleUseTradeLimitQuantity(tradePreview.maxAffordableBuyQty)}
              >
                全部({tradePreview.maxAffordableBuyQtyText})
              </button>
            </div>
            <div className="stock-market-trade-limit-group">
              <span className="limit-label">可卖</span>
              <button
                type="button"
                className="stock-market-trade-limit-action"
                disabled={tradePreview.maxSellQty <= 0}
                onClick={() => handleUseTradeLimitQuantity(Math.max(1, Math.floor(tradePreview.maxSellQty * 0.25)))}
              >
                25%
              </button>
              <button
                type="button"
                className="stock-market-trade-limit-action"
                disabled={tradePreview.maxSellQty <= 0}
                onClick={() => handleUseTradeLimitQuantity(Math.max(1, Math.floor(tradePreview.maxSellQty * 0.5)))}
              >
                50%
              </button>
              <button
                type="button"
                className="stock-market-trade-limit-action"
                disabled={tradePreview.maxSellQty <= 0}
                onClick={() => handleUseTradeLimitQuantity(Math.max(1, Math.floor(tradePreview.maxSellQty * 0.75)))}
              >
                75%
              </button>
              <button
                type="button"
                className="stock-market-trade-limit-action max-btn"
                disabled={tradePreview.maxSellQty <= 0}
                onClick={() => handleUseTradeLimitQuantity(tradePreview.maxSellQty)}
              >
                全部({tradePreview.maxSellQtyText})
              </button>
            </div>
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
  })();

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
          setProfitDetail(null);
          setProfitLoading(false);
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
              onChange={handleTabChange}
              items={[
                {
                  key: 'market',
                  label: '行情',
                  children: (
                    <div className="stock-market-grid">
                      <div className="stock-market-top-row">
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
                            <div className="stock-market-news-body">
                              <div className="stock-market-news-main">
                                <div className="stock-market-news-title">{activeNews.headline}</div>
                                <div className="stock-market-news-summary">{activeNews.summary}</div>
                              </div>
                              {activeNews.impacts.length > 0 ? (
                                <div className="stock-market-news-sidebar">
                                  <div className="stock-market-news-sidebar-list">
                                    {activeNews.impacts.map((impact) => {
                                      const tone = resolveStockMarketTone(impact.changeBps);
                                      return (
                                        <div
                                          key={impact.stockId}
                                          className={`stock-market-news-impact-item ${getStockMarketToneClassName(tone)}`}
                                        >
                                          <span className="stock-name">{impact.stockName}</span>
                                          <span className="stock-change">{formatStockMarketBps(impact.changeBps)}</span>
                                        </div>
                                      );
                                    })}
                                  </div>
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
                            <Button
                              danger
                              size="small"
                              icon={<ClearOutlined />}
                              disabled={!canClearAll}
                              loading={actionKey === 'clear-all'}
                              onClick={() => handleClearPosition('all')}
                            >
                              全部清仓
                            </Button>
                          </div>
                          <div className="stock-market-stat-grid">
                            <div className="stock-market-stat-card">
                              <span className="stock-market-stat-label">总股数</span>
                              <strong className="stock-market-stat-val">{overviewModel.portfolio.totalHoldingQtyText}</strong>
                            </div>
                            <div className="stock-market-stat-card">
                              <span className="stock-market-stat-label">市值</span>
                              <strong className="stock-market-stat-val">{overviewModel.portfolio.totalMarketValueText}</strong>
                            </div>
                            <div className="stock-market-stat-card">
                              <span className="stock-market-stat-label">成本</span>
                              <strong className="stock-market-stat-val">{overviewModel.portfolio.totalCostText}</strong>
                            </div>
                            <div className="stock-market-stat-card">
                              <span className="stock-market-stat-label stock-market-stat-label--split">
                                <span>浮盈亏</span>
                                <em className={getStockMarketToneClassName(overviewModel.portfolio.totalUnrealizedPnlTone)}>
                                  {overviewModel.portfolio.totalUnrealizedPnlPercentText}
                                </em>
                              </span>
                              <strong className={`stock-market-stat-val ${getStockMarketToneClassName(overviewModel.portfolio.totalUnrealizedPnlTone)}`}>
                                {overviewModel.portfolio.totalUnrealizedPnlText}
                              </strong>
                            </div>
                          </div>
                        </section>
                      </div>

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
                              className={`stock-market-stock-row${item.selected ? ' is-selected' : ''}${item.hasHolding ? ' has-holding' : ''}`}
                              onClick={() => handleSelectStock(item.stock.stockId)}
                            >
                              <span className="stock-market-stock-main">
                                <strong>{item.stock.name}</strong>
                                <span>{item.stock.code} · {item.stock.sector}</span>
                              </span>
                              <span className="stock-market-stock-price">
                                <strong>{item.priceText}</strong>
                                <em className={getStockMarketToneClassName(item.changeTone)}>{item.changeText}</em>
                              </span>
                              <span
                                className={`stock-market-stock-holding${item.hasHolding ? ' is-holding' : ''}`}
                              >
                                {item.hasHolding ? (
                                  <>
                                    <span>持有 {item.holdingQtyText}</span>
                                    <span>市值 {item.holdingMarketValueText}</span>
                                  </>
                                ) : (
                                  <span>{item.holdingSummaryText}</span>
                                )}
                              </span>
                              {item.hasHolding ? (
                                <span
                                  className={`stock-market-stock-pnl ${getStockMarketToneClassName(item.unrealizedPnlTone)}`}
                                >
                                  <span>{item.unrealizedPnlText}</span>
                                  <em>{item.unrealizedPnlPercentText}</em>
                                </span>
                              ) : null}
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
                  key: 'profit',
                  label: '收益详情',
                  children: (
                    <section className="stock-market-panel stock-market-profit-panel">
                      <div className="stock-market-section-head">
                        <span>收益详情</span>
                        <Button
                          size="small"
                          icon={<ReloadOutlined />}
                          onClick={() => void refreshProfitDetail()}
                          loading={profitLoading}
                        >
                          刷新
                        </Button>
                      </div>
                      {profitDetailContent}
                    </section>
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
                              <div className="stock-market-record-row-info">
                                <div className="record-stock-line">
                                  <span className={`record-side-badge ${getStockMarketToneClassName(record.sideTone)}`}>
                                    {record.sideText}
                                  </span>
                                  <strong className="record-stock-name">{record.stockText}</strong>
                                </div>
                                <span className="record-time">{record.timeText}</span>
                              </div>
                              <div className="stock-market-record-row-grid">
                                <div className="record-grid-item">
                                  <span className="record-grid-label">成交数量</span>
                                  <strong className="record-grid-val">{record.quantityText}</strong>
                                </div>
                                <div className="record-grid-item">
                                  <span className="record-grid-label">成交单价</span>
                                  <strong className="record-grid-val">{record.unitPriceText}</strong>
                                </div>
                                <div className="record-grid-item">
                                  <span className="record-grid-label">交易费用</span>
                                  <strong className="record-grid-val">{record.feeText}</strong>
                                </div>
                                <div className="record-grid-item">
                                  <span className="record-grid-label">结算收支</span>
                                  <strong className="record-grid-val">{record.netAmountText}</strong>
                                </div>
                                <div className="record-grid-item">
                                  <span className="record-grid-label">实现盈亏</span>
                                  <strong className={`record-grid-val ${getStockMarketToneClassName(record.realizedPnlTone)}`}>
                                    {record.realizedPnlText}
                                  </strong>
                                </div>
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
