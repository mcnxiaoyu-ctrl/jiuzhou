/**
 * 股市场景选择器。
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：集中维护股市 AI 新闻场景池，并根据最近已波动股票给场景做动态权重。
 * 2. 不做什么：不调用 AI、不访问数据库、不直接决定最终涨跌股票。
 *
 * 输入 / 输出：
 * - 输入：本轮随机 seed、启用股票 ID 集合、最近已进入行情影响的股票 ID。
 * - 输出：一个本轮 prompt 使用的场景，以及每个场景的权重明细。
 *
 * 数据流 / 状态流：
 * stockMarketService 读取最近行情影响 -> 本模块计算股票热度与场景权重 -> stockMarketAi 写入 prompt -> 模型输出 impacts。
 *
 * 复用设计说明：
 * - 场景池和选择规则集中在这里，避免 prompt、调度服务和测试各自维护一套题材轮换逻辑。
 * - “最近重复降权、冷门覆盖加权、保留随机扰动”是高频调参点，独立模块后后续只改权重常量。
 *
 * 关键边界条件与坑点：
 * 1. 冷却不是禁用，热门场景仍保留最小权重，避免玩家看出固定轮换顺序。
 * 2. 最近影响列表只作为概率调节，不作为模型输出白名单；最终合法性仍由 AI 校验入口保证。
 */
export type StockMarketScenarioGuide = {
  id: string;
  title: string;
  focusStockIds: readonly string[];
  guide: string;
};

export type StockMarketScenarioSelectionWeight = {
  scenarioId: string;
  weight: number;
  hotFocusScore: number;
  coldFocusCount: number;
};

export type StockMarketScenarioSelectionResult = {
  guide: StockMarketScenarioGuide;
  weights: StockMarketScenarioSelectionWeight[];
};

export const STOCK_MARKET_SCENARIO_RECENT_TICK_LIMIT = 12;

const STOCK_MARKET_SCENARIO_BASE_WEIGHT = 100;
const STOCK_MARKET_SCENARIO_MIN_WEIGHT = 12;
const STOCK_MARKET_SCENARIO_COLD_STOCK_BONUS = 28;
const STOCK_MARKET_SCENARIO_HOT_STOCK_PENALTY = 9;
const STOCK_MARKET_SCENARIO_EVENT_FOCUS_BONUS = 42;
const STOCK_MARKET_SCENARIO_RECENT_STOCK_WINDOW = 32;
const STOCK_MARKET_SCENARIO_RANDOM_JITTER = 24;

export const STOCK_MARKET_SCENARIO_GUIDES: readonly StockMarketScenarioGuide[] = [
  {
    id: 'alchemy-supply',
    title: '丹药与灵植供需轮动',
    focusStockIds: ['stock-qingyun-danfang', 'stock-yunmeng-herb', 'stock-xinghe-auction'],
    guide: '围绕丹药需求、药材收成、拍卖流转写作，至少一只受益、一只承压，不要重复写丹方突破大涨。',
  },
  {
    id: 'mining-armory',
    title: '矿材与炼器成本博弈',
    focusStockIds: ['stock-xuantie-mining', 'stock-tiangong-armory', 'stock-beizhou-treasure'],
    guide: '围绕矿脉产量、矿价、炼器订单和商贸囤货写作，矿材与炼器或商贸之间形成多空对冲。',
  },
  {
    id: 'transport-array',
    title: '交通与阵法替代竞争',
    focusStockIds: ['stock-lingzhou-shipyard', 'stock-qiankun-array', 'stock-beizhou-treasure'],
    guide: '围绕灵舟航线、传送阵、商路安全写作，可以让交通与阵法互相替代，但不要连续只利好乾坤阵台。',
  },
  {
    id: 'academy-sect',
    title: '功法与宗门声望变化',
    focusStockIds: ['stock-wanjuan-academy', 'stock-chixiao-sword', 'stock-xinghe-auction'],
    guide: '围绕秘卷、论剑、讲经会和宗门委托写作，让功法、宗门、拍卖之间有正负分化。',
  },
  {
    id: 'auction-commerce',
    title: '拍卖与商贸资金分流',
    focusStockIds: ['stock-xinghe-auction', 'stock-beizhou-treasure', 'stock-wanjuan-academy'],
    guide: '围绕压轴拍品、宝楼交易、人气分流写作，拍卖热度和商贸成交之间形成平衡。',
  },
  {
    id: 'sect-defense',
    title: '边境战事与防务委托',
    focusStockIds: ['stock-chixiao-sword', 'stock-tiangong-armory', 'stock-qiankun-array', 'stock-lingzhou-shipyard'],
    guide: '围绕边境战事、护宗委托、法器与阵法需求写作，至少包含一个受益方和一个成本或风险承压方。',
  },
  {
    id: 'weather-harvest',
    title: '节气收成与材料价格',
    focusStockIds: ['stock-yunmeng-herb', 'stock-qingyun-danfang', 'stock-xuantie-mining', 'stock-tiangong-armory'],
    guide: '围绕节气、虫害、灵草收成和材料价格写作，供应端与加工端涨跌互相抵消。',
  },
  {
    id: 'market-rotation',
    title: '市场风险偏好切换',
    focusStockIds: [
      'stock-qingyun-danfang',
      'stock-wanjuan-academy',
      'stock-xinghe-auction',
      'stock-beizhou-treasure',
    ],
    guide: '围绕修士资金在消耗品、功法、拍卖和商贸之间切换写作，不要让同一行业连续独占利好。',
  },
];

const normalizeStockMarketSeed = (seed: number): number => {
  return Number.isSafeInteger(seed) && seed > 0 ? Math.trunc(seed) : 1;
};

const buildScenarioHash = (seed: number, scenarioId: string): number => {
  let hash = normalizeStockMarketSeed(seed) >>> 0;
  for (let index = 0; index < scenarioId.length; index += 1) {
    hash = Math.imul(hash ^ scenarioId.charCodeAt(index), 16_777_619) >>> 0;
  }
  return hash;
};

const buildRecentStockHeatMap = (
  recentStockIds: readonly string[],
  enabledStockIdSet: ReadonlySet<string>,
): Map<string, number> => {
  const heatByStockId = new Map<string, number>();
  const windowedStockIds = recentStockIds.slice(0, STOCK_MARKET_SCENARIO_RECENT_STOCK_WINDOW);
  for (let index = 0; index < windowedStockIds.length; index += 1) {
    const stockId = windowedStockIds[index];
    if (!stockId || !enabledStockIdSet.has(stockId)) continue;
    const heat = STOCK_MARKET_SCENARIO_RECENT_STOCK_WINDOW - index;
    heatByStockId.set(stockId, (heatByStockId.get(stockId) ?? 0) + heat);
  }
  return heatByStockId;
};

export const buildStockMarketScenarioSelectionWeights = (params: {
  seed: number;
  enabledStockIdSet: ReadonlySet<string>;
  recentStockIds: readonly string[];
  eventFocusStockIds?: readonly string[];
}): StockMarketScenarioSelectionWeight[] => {
  const heatByStockId = buildRecentStockHeatMap(params.recentStockIds, params.enabledStockIdSet);
  const eventFocusStockIdSet = new Set(
    (params.eventFocusStockIds ?? []).filter((stockId) => params.enabledStockIdSet.has(stockId)),
  );
  return STOCK_MARKET_SCENARIO_GUIDES.map((guide) => {
    let hotFocusScore = 0;
    let coldFocusCount = 0;
    let eventFocusCount = 0;
    for (const stockId of guide.focusStockIds) {
      if (!params.enabledStockIdSet.has(stockId)) continue;
      const heat = heatByStockId.get(stockId) ?? 0;
      if (heat > 0) {
        hotFocusScore += heat;
      } else {
        coldFocusCount += 1;
      }
      if (eventFocusStockIdSet.has(stockId)) {
        eventFocusCount += 1;
      }
    }

    const jitterHash = buildScenarioHash(params.seed, guide.id);
    const jitter = (jitterHash % (STOCK_MARKET_SCENARIO_RANDOM_JITTER * 2 + 1)) - STOCK_MARKET_SCENARIO_RANDOM_JITTER;
    const weight = Math.max(
      STOCK_MARKET_SCENARIO_MIN_WEIGHT,
      STOCK_MARKET_SCENARIO_BASE_WEIGHT
      + coldFocusCount * STOCK_MARKET_SCENARIO_COLD_STOCK_BONUS
      + eventFocusCount * STOCK_MARKET_SCENARIO_EVENT_FOCUS_BONUS
      - hotFocusScore * STOCK_MARKET_SCENARIO_HOT_STOCK_PENALTY
      + jitter,
    );

    return {
      scenarioId: guide.id,
      weight,
      hotFocusScore,
      coldFocusCount,
    };
  });
};

export const selectStockMarketScenarioGuide = (params: {
  seed: number;
  enabledStockIdSet: ReadonlySet<string>;
  recentStockIds: readonly string[];
  eventFocusStockIds?: readonly string[];
}): StockMarketScenarioSelectionResult => {
  const weights = buildStockMarketScenarioSelectionWeights(params);
  const totalWeight = weights.reduce((total, row) => total + row.weight, 0);
  const normalizedSeed = normalizeStockMarketSeed(params.seed);
  let cursor = normalizedSeed % totalWeight;

  for (let index = 0; index < weights.length; index += 1) {
    const weight = weights[index];
    if (cursor < weight.weight) {
      return {
        guide: STOCK_MARKET_SCENARIO_GUIDES[index]!,
        weights,
      };
    }
    cursor -= weight.weight;
  }

  return {
    guide: STOCK_MARKET_SCENARIO_GUIDES[STOCK_MARKET_SCENARIO_GUIDES.length - 1]!,
    weights,
  };
};
