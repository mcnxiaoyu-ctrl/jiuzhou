/**
 * 股市视图派生测试。
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：锁定概览 DTO 到股票列表、持仓汇总、交易预览和记录行的纯函数转换。
 * 2. 不做什么：不挂载 React，不请求后端，也不校验样式细节。
 *
 * 输入 / 输出：
 * - 输入：构造的股市 overview、历史点和交易记录 DTO。
 * - 输出：`stockMarketView` 生成的轻量展示模型。
 *
 * 数据流 / 状态流：
 * API DTO -> `stockMarketView` 纯函数 -> 断言列表选中、手续费、涨跌色调和交易记录文案。
 *
 * 复用设计说明：
 * - 派生规则集中在纯函数模块，测试只命中这个入口，避免 JSX 中出现重复格式化逻辑后难以发现。
 * - 手续费预览、持仓汇总和涨跌色调是股市弹窗多个区域共用的规则，因此一起锁定。
 *
 * 关键边界条件与坑点：
 * 1. 未传入有效选中股票时必须回落到第一支股票，保证打开弹窗后历史请求有稳定目标。
 * 2. 手续费需要按服务端口径向上取整，小额成交不能显示为 0 手续费。
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
      priceSpiritStones: 101,
      lastChangeBps: 150,
      updatedAt: 1_785_000_000_000,
      holdingQty: 2,
      holdingCostSpiritStones: 180,
      holdingMarketValueSpiritStones: 202,
      unrealizedPnlSpiritStones: 22,
    },
    {
      stockId: 'stock-xuantie-mining',
      code: 'XTKY',
      name: '玄铁矿业',
      shortName: '玄铁',
      sector: '矿材',
      description: '北地玄铁矿脉。',
      priceSpiritStones: 80,
      lastChangeBps: -400,
      updatedAt: 1_785_000_000_000,
      holdingQty: 0,
      holdingCostSpiritStones: 0,
      holdingMarketValueSpiritStones: 0,
      unrealizedPnlSpiritStones: 0,
    },
  ],
  latestNews: null,
  portfolio: {
    totalHoldingQty: 2,
    totalCostSpiritStones: 180,
    totalMarketValueSpiritStones: 202,
    totalUnrealizedPnlSpiritStones: 22,
  },
  tradeRules: {
    feeBps: 100,
    maxOrderQty: 1000,
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
    expect(model.stocks[1].changeTone).toBe('down');
    expect(model.portfolio.totalUnrealizedPnlTone).toBe('up');
    expect(model.portfolio.totalHoldingQtyText).toBe('2 股');
  });

  it('交易预览手续费应按 1% 向上取整', () => {
    const stock = buildOverview().stocks[0];
    const preview = buildStockMarketTradePreview(stock, 1, 100);

    expect(preview.grossAmount).toBe(101);
    expect(preview.feeAmount).toBe(2);
    expect(preview.buyCost).toBe(103);
    expect(preview.sellReceive).toBe(99);
  });

  it('历史走势应输出最新价与涨跌色调', () => {
    const points: StockMarketHistoryPointDto[] = [
      {
        stockId: 'stock-qingyun-danfang',
        priceSpiritStones: 96,
        changeBps: -150,
        direction: 'down',
        reason: '丹材涨价',
        createdAt: 1_785_000_000_000,
      },
      {
        stockId: 'stock-qingyun-danfang',
        priceSpiritStones: 101,
        changeBps: 150,
        direction: 'up',
        reason: '新丹热卖',
        createdAt: 1_785_003_600_000,
      },
    ];

    const model = buildStockMarketHistoryViewModel(points);

    expect(model.latestPriceText).toBe('101 灵石');
    expect(model.latestChangeText).toBe('+1.50%');
    expect(model.latestTone).toBe('up');
    expect(model.points[0].tone).toBe('down');
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
        unitPriceSpiritStones: 101,
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
