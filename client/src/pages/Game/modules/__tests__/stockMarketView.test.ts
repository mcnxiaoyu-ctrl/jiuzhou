/**
 * 股市视图派生测试。
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：锁定概览 DTO 到股票列表、持仓汇总、交易预览、K 线和记录行的纯函数转换。
 * 2. 不做什么：不挂载 React，不请求后端，也不校验样式细节。
 *
 * 输入 / 输出：
 * - 输入：构造的股市 overview、历史点和交易记录 DTO。
 * - 输出：`stockMarketView` 生成的轻量展示模型。
 *
 * 数据流 / 状态流：
 * API DTO -> `stockMarketView` 纯函数 -> 断言列表选中、交易费用、K 线开收价、涨跌色调和交易记录文案。
 *
 * 复用设计说明：
 * - 派生规则集中在纯函数模块，测试只命中这个入口，避免 JSX 中出现重复格式化逻辑后难以发现。
 * - 交易费用预览、持仓汇总和涨跌色调是股市弹窗多个区域共用的规则，因此一起锁定。
 *
 * 关键边界条件与坑点：
 * 1. 未传入有效选中股票时必须回落到第一支股票，保证打开弹窗后历史请求有稳定目标。
 * 2. 交易费用需要按服务端口径向上取整，小额成交不能显示为 0 费用。
 * 3. 股价展示保留两位小数，成交金额仍按整数灵石展示。
 */
import { describe, expect, it } from 'vitest';
import type {
  StockMarketHistoryPointDto,
  StockMarketOverviewDto,
  StockMarketTradeRecordDto,
} from '../../../../services/api';
import {
  buildStockMarketHistoryViewModel,
  buildStockMarketOverviewViewModel,
  buildStockMarketTradePreview,
  buildStockMarketTradeRecordViews,
} from '../StockMarketModal/stockMarketView';

const buildOverview = (): StockMarketOverviewDto => ({
  stocks: [
    {
      stockId: 'stock-qingyun-danfang',
      code: 'QYDF',
      name: '青云丹坊',
      shortName: '青云',
      sector: '丹药',
      description: '炼丹宗门外坊。',
      priceSpiritStones: 101.25,
      lastChangeBps: 150,
      updatedAt: 1_785_000_000_000,
      holdingQty: 2,
      holdingCostSpiritStones: 180,
      holdingMarketValueSpiritStones: 203,
      unrealizedPnlSpiritStones: 23,
      maxBuyQty: 100,
      maxSellQty: 2,
    },
    {
      stockId: 'stock-xuantie-mining',
      code: 'XTKY',
      name: '玄铁矿业',
      shortName: '玄铁',
      sector: '矿材',
      description: '北地玄铁矿脉。',
      priceSpiritStones: 80.1,
      lastChangeBps: -400,
      updatedAt: 1_785_000_000_000,
      holdingQty: 0,
      holdingCostSpiritStones: 0,
      holdingMarketValueSpiritStones: 0,
      unrealizedPnlSpiritStones: 0,
      maxBuyQty: 200,
      maxSellQty: 0,
    },
  ],
  latestNews: null,
  newsRecords: [],
  portfolio: {
    totalHoldingQty: 2,
    totalCostSpiritStones: 180,
    totalMarketValueSpiritStones: 203,
    totalUnrealizedPnlSpiritStones: 23,
  },
  tradeRules: {
    feeRateDenominator: 100_000,
    commissionRate: 30,
    stampDutyRate: 50,
    transferFeeRate: 1,
    maxOrderValueSpiritStones: 2_000_000,
    maxSingleStockValueSpiritStones: 5_000_000,
    maxTotalValueSpiritStones: 20_000_000,
    minPriceSpiritStones: 1,
  },
  nextRefreshAt: 1_785_003_600_000,
});

describe('stockMarketView', () => {
  it('概览派生应一次确定选中股票与持仓汇总', () => {
    const model = buildStockMarketOverviewViewModel(buildOverview(), '');

    expect(model.selectedStock?.stock.stockId).toBe('stock-qingyun-danfang');
    expect(model.stocks[0].selected).toBe(true);
    expect(model.stocks[0].hasHolding).toBe(true);
    expect(model.stocks[0].priceText).toBe('101.25 灵石');
    expect(model.stocks[0].holdingSummaryText).toBe('持有 2 股 · 市值 203 灵石');
    expect(model.stocks[1].changeTone).toBe('down');
    expect(model.stocks[1].holdingSummaryText).toBe('未持有');
    expect(model.portfolio.totalUnrealizedPnlTone).toBe('up');
    expect(model.portfolio.totalHoldingQtyText).toBe('2 股');
  });

  it('交易预览应按 A 股费用拆分佣金、印花税和过户费', () => {
    const stock = buildOverview().stocks[0];
    const preview = buildStockMarketTradePreview(stock, 1, buildOverview().tradeRules);

    expect(preview.grossAmount).toBe(102);
    expect(preview.sellGrossAmount).toBe(101);
    expect(preview.commissionAmount).toBe(1);
    expect(preview.sellCommissionAmount).toBe(1);
    expect(preview.stampDutyAmount).toBe(1);
    expect(preview.transferFeeAmount).toBe(1);
    expect(preview.sellTransferFeeAmount).toBe(1);
    expect(preview.buyFeeAmount).toBe(2);
    expect(preview.sellFeeAmount).toBe(3);
    expect(preview.buyCost).toBe(104);
    expect(preview.sellReceive).toBe(98);
    expect(preview.maxBuyQty).toBe(100);
    expect(preview.maxSellQty).toBe(2);
    expect(preview.maxTradeQty).toBe(100);
  });

  it('历史走势应输出标准K线与最新涨跌', () => {
    const points: StockMarketHistoryPointDto[] = [
      {
        stockId: 'stock-qingyun-danfang',
        priceSpiritStones: 96.25,
        openPriceSpiritStones: 97.15,
        highPriceSpiritStones: 98.12,
        lowPriceSpiritStones: 95.88,
        closePriceSpiritStones: 96.25,
        changeBps: -150,
        direction: 'down',
        reason: '丹材涨价',
        createdAt: 1_785_000_000_000,
      },
      {
        stockId: 'stock-qingyun-danfang',
        priceSpiritStones: 101.25,
        openPriceSpiritStones: 96.25,
        highPriceSpiritStones: 103.54,
        lowPriceSpiritStones: 95.2,
        closePriceSpiritStones: 101.25,
        changeBps: 150,
        direction: 'up',
        reason: '新丹热卖',
        createdAt: 1_785_003_600_000,
      },
    ];

    const model = buildStockMarketHistoryViewModel(points);

    expect(model.candlesticks[0].tone).toBe('down');
    expect(model.candlesticks[1].openPriceText).toBe('96.25 灵石');
    expect(model.candlesticks[1].closePriceText).toBe('101.25 灵石');
    expect(model.candlesticks[1].highPriceText).toBe('103.54 灵石');
    expect(model.candlesticks[1].lowPriceText).toBe('95.20 灵石');
    expect(model.candlesticks[1].open).toBe(96.25);
    expect(model.candlesticks[1].high).toBe(103.54);
    expect(model.candlesticks[1].low).toBe(95.2);
    expect(model.candlesticks[1].close).toBe(101.25);
    expect(model.candlesticks[1].reasonText).toBe('影响：新丹热卖');
    expect(model.candlesticks[1].changeText).toBe('+1.50%');
    expect(model.movingAverages[0].data).toHaveLength(0);
    expect(model.movingAverages[0].valueText).toBe('98.75');
  });

  it('交易记录应集中格式化买卖方向与盈亏', () => {
    const records: StockMarketTradeRecordDto[] = [
      {
        id: 1,
        stockId: 'stock-qingyun-danfang',
        stockName: '青云丹坊',
        stockCode: 'QYDF',
        side: 'sell',
        quantity: 2,
        unitPriceSpiritStones: 101.25,
        grossAmountSpiritStones: 202,
        feeSpiritStones: 3,
        netAmountSpiritStones: 199,
        realizedPnlSpiritStones: 19,
        createdAt: 1_785_003_600_000,
      },
    ];

    const rows = buildStockMarketTradeRecordViews(records);

    expect(rows[0].sideText).toBe('卖出');
    expect(rows[0].sideTone).toBe('down');
    expect(rows[0].stockText).toBe('青云丹坊 · QYDF');
    expect(rows[0].realizedPnlText).toBe('+19 灵石');
  });
});
