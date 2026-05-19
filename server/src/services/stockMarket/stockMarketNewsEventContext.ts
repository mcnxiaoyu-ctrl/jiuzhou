/**
 * 股市新闻事件上下文选择器。
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：维护 AI 新闻多事件池的轻量选择规则，按事件状态、近期股票热度和随机扰动决定本轮延续旧事件或开启新事件。
 * 2. 不做什么：不访问数据库、不调用 AI、不直接改价，也不把事件线暴露给前端。
 *
 * 输入 / 输出：
 * - 输入：服务层读取到的活跃/冷却事件、启用股票 ID 集合、近期已进入行情的股票 ID、本轮 seed。
 * - 输出：本轮 prompt 使用的候选事件、事件动作指令和权重明细。
 *
 * 数据流 / 状态流：
 * stockMarketService 读取事件池与近期影响 -> 本模块过滤 resolved 和非法股票 -> 计算事件/新事件权重 -> stockMarketAi 写入 prompt。
 *
 * 复用设计说明：
 * - 事件延续、冷却和新事件开局的权重集中在这里，避免 prompt、service 和测试各自维护一套规则。
 * - “事件不是锁定剧情、近期高频股票仍降权、新事件保留入口”是高频调参点，因此独立为纯函数。
 *
 * 关键边界条件与坑点：
 * 1. resolved 事件不能进入候选池，否则已收尾新闻会被下一轮反复续写。
 * 2. 事件股票只作为概率调节，不替代 AI payload 的白名单校验；最终落价仍必须通过 stockMarketAi 校验。
 */
export type StockMarketNewsEventStatus = 'active' | 'cooling' | 'resolved';

export type StockMarketNewsEventDirective = 'new' | 'continue';

export type StockMarketNewsEventPromptContext = {
  eventId: string;
  status: StockMarketNewsEventStatus;
  theme: string;
  headline: string;
  summary: string;
  stage: string;
  affectedStockIds: readonly string[];
};

export type StockMarketNewsEventSelectionWeight = {
  eventId: string;
  weight: number;
  hotStockScore: number;
  coldStockCount: number;
};

export type StockMarketNewsEventSelectionResult = {
  selectedEvent: StockMarketNewsEventPromptContext | null;
  directive: StockMarketNewsEventDirective;
  weights: StockMarketNewsEventSelectionWeight[];
};

export const STOCK_MARKET_NEWS_EVENT_CONTEXT_LIMIT = 6;

const STOCK_MARKET_NEWS_EVENT_BASE_WEIGHT = 72;
const STOCK_MARKET_NEWS_EVENT_ACTIVE_BONUS = 28;
const STOCK_MARKET_NEWS_EVENT_COOLING_PENALTY = 18;
const STOCK_MARKET_NEWS_EVENT_COLD_STOCK_BONUS = 16;
const STOCK_MARKET_NEWS_EVENT_HOT_STOCK_PENALTY = 4;
const STOCK_MARKET_NEWS_EVENT_MIN_WEIGHT = 10;
const STOCK_MARKET_NEWS_EVENT_NEW_BASE_WEIGHT = 64;
const STOCK_MARKET_NEWS_EVENT_NEW_EMPTY_POOL_BONUS = 80;
const STOCK_MARKET_NEWS_EVENT_NEW_CAPACITY_BONUS = 8;
const STOCK_MARKET_NEWS_EVENT_RANDOM_JITTER = 18;
const STOCK_MARKET_NEWS_EVENT_RECENT_STOCK_WINDOW = 32;

const normalizeStockMarketNewsEventSeed = (seed: number): number => {
  return Number.isSafeInteger(seed) && seed > 0 ? Math.trunc(seed) : 1;
};

const buildStockMarketNewsEventHash = (seed: number, eventId: string): number => {
  let hash = normalizeStockMarketNewsEventSeed(seed) >>> 0;
  for (let index = 0; index < eventId.length; index += 1) {
    hash = Math.imul(hash ^ eventId.charCodeAt(index), 16_777_619) >>> 0;
  }
  return hash;
};

const buildRecentStockHeatMap = (
  recentStockIds: readonly string[],
  enabledStockIdSet: ReadonlySet<string>,
): Map<string, number> => {
  const heatByStockId = new Map<string, number>();
  const windowedStockIds = recentStockIds.slice(0, STOCK_MARKET_NEWS_EVENT_RECENT_STOCK_WINDOW);
  for (let index = 0; index < windowedStockIds.length; index += 1) {
    const stockId = windowedStockIds[index];
    if (!stockId || !enabledStockIdSet.has(stockId)) continue;
    const heat = STOCK_MARKET_NEWS_EVENT_RECENT_STOCK_WINDOW - index;
    heatByStockId.set(stockId, (heatByStockId.get(stockId) ?? 0) + heat);
  }
  return heatByStockId;
};

const normalizeEventStockIds = (
  event: StockMarketNewsEventPromptContext,
  enabledStockIdSet: ReadonlySet<string>,
): string[] => {
  const stockIds: string[] = [];
  const seenStockIds = new Set<string>();
  for (const stockId of event.affectedStockIds) {
    if (!enabledStockIdSet.has(stockId) || seenStockIds.has(stockId)) continue;
    seenStockIds.add(stockId);
    stockIds.push(stockId);
  }
  return stockIds;
};

const buildNewEventWeight = (params: {
  seed: number;
  candidateEventCount: number;
}): StockMarketNewsEventSelectionWeight => {
  const jitterHash = buildStockMarketNewsEventHash(params.seed, 'new');
  const jitter = (jitterHash % (STOCK_MARKET_NEWS_EVENT_RANDOM_JITTER * 2 + 1))
    - STOCK_MARKET_NEWS_EVENT_RANDOM_JITTER;
  const capacityBonus = Math.max(0, STOCK_MARKET_NEWS_EVENT_CONTEXT_LIMIT - params.candidateEventCount)
    * STOCK_MARKET_NEWS_EVENT_NEW_CAPACITY_BONUS;
  const emptyPoolBonus = params.candidateEventCount <= 0 ? STOCK_MARKET_NEWS_EVENT_NEW_EMPTY_POOL_BONUS : 0;
  return {
    eventId: 'new',
    weight: STOCK_MARKET_NEWS_EVENT_NEW_BASE_WEIGHT + capacityBonus + emptyPoolBonus + jitter,
    hotStockScore: 0,
    coldStockCount: 0,
  };
};

export const buildStockMarketNewsEventSelectionWeights = (params: {
  seed: number;
  enabledStockIdSet: ReadonlySet<string>;
  recentStockIds: readonly string[];
  events: readonly StockMarketNewsEventPromptContext[];
}): StockMarketNewsEventSelectionWeight[] => {
  const heatByStockId = buildRecentStockHeatMap(params.recentStockIds, params.enabledStockIdSet);
  const candidateEvents = params.events
    .filter((event) => event.status !== 'resolved')
    .slice(0, STOCK_MARKET_NEWS_EVENT_CONTEXT_LIMIT);

  const weights: StockMarketNewsEventSelectionWeight[] = [];
  for (const event of candidateEvents) {
    const affectedStockIds = normalizeEventStockIds(event, params.enabledStockIdSet);
    if (affectedStockIds.length <= 0) continue;

    let hotStockScore = 0;
    let coldStockCount = 0;
    for (const stockId of affectedStockIds) {
      const heat = heatByStockId.get(stockId) ?? 0;
      if (heat > 0) {
        hotStockScore += heat;
      } else {
        coldStockCount += 1;
      }
    }

    const jitterHash = buildStockMarketNewsEventHash(params.seed, event.eventId);
    const jitter = (jitterHash % (STOCK_MARKET_NEWS_EVENT_RANDOM_JITTER * 2 + 1))
      - STOCK_MARKET_NEWS_EVENT_RANDOM_JITTER;
    const statusDelta = event.status === 'active'
      ? STOCK_MARKET_NEWS_EVENT_ACTIVE_BONUS
      : -STOCK_MARKET_NEWS_EVENT_COOLING_PENALTY;
    const weight = Math.max(
      STOCK_MARKET_NEWS_EVENT_MIN_WEIGHT,
      STOCK_MARKET_NEWS_EVENT_BASE_WEIGHT
      + statusDelta
      + coldStockCount * STOCK_MARKET_NEWS_EVENT_COLD_STOCK_BONUS
      - hotStockScore * STOCK_MARKET_NEWS_EVENT_HOT_STOCK_PENALTY
      + jitter,
    );

    weights.push({
      eventId: event.eventId,
      weight,
      hotStockScore,
      coldStockCount,
    });
  }

  weights.push(buildNewEventWeight({
    seed: params.seed,
    candidateEventCount: weights.length,
  }));
  return weights;
};

export const selectStockMarketNewsEventContext = (params: {
  seed: number;
  enabledStockIdSet: ReadonlySet<string>;
  recentStockIds: readonly string[];
  events: readonly StockMarketNewsEventPromptContext[];
}): StockMarketNewsEventSelectionResult => {
  const weights = buildStockMarketNewsEventSelectionWeights(params);
  const totalWeight = weights.reduce((total, row) => total + row.weight, 0);
  const normalizedSeed = normalizeStockMarketNewsEventSeed(params.seed);
  let cursor = normalizedSeed % totalWeight;

  for (const weight of weights) {
    if (cursor < weight.weight) {
      const selectedEvent = params.events.find((event) => event.eventId === weight.eventId) ?? null;
      return {
        selectedEvent,
        directive: selectedEvent ? 'continue' : 'new',
        weights,
      };
    }
    cursor -= weight.weight;
  }

  return {
    selectedEvent: null,
    directive: 'new',
    weights,
  };
};
