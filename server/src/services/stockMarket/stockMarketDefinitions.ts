/**
 * 股市静态股票定义索引。
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：把 `stock_def.json` 中的股票定义归一化为稳定有序列表与按 ID 查询索引。
 * 2. 不做什么：不读取实时价格、不处理交易规则、不生成 AI 新闻。
 *
 * 输入 / 输出：
 * - 输入：`staticConfigLoader.getStockDefinitions()` 读取到的静态股票数组。
 * - 输出：启用股票列表、股票 ID 集合、按 ID 查询的只读 Map。
 *
 * 数据流 / 状态流：
 * 静态 JSON -> 本模块过滤、排序、冻结 -> 股市初始化、AI prompt、行情查询与交易校验复用。
 *
 * 复用设计说明：
 * - 初始股票、AI 可选标的、服务端交易校验都依赖同一份定义，集中在这里避免各模块重复维护 10 支股票名单。
 * - `sort_weight` 属于高频调参点，排序规则收敛在这里后前后端展示无需各自排序。
 *
 * 关键边界条件与坑点：
 * 1. 启用股票必须具备最多两位小数的正数初始价，否则初始化报价会写入无效价格。
 * 2. ID 查询索引必须基于冻结后的列表构建，避免调用方误改数组后让索引和列表不一致。
 */
import {
  getStockDefinitions,
  type StockDefConfig,
} from '../staticConfigLoader.js';
import { createStaticDefinitionIndexGetter } from '../shared/staticDefinitionIndex.js';
import { STOCK_MARKET_PRICE_SCALE_NUMBER } from './stockMarketRules.js';

export type StockMarketDefinition = StockDefConfig & {
  initial_price_spirit_stones: number;
};

const STOCK_MARKET_INITIAL_PRICE_EPSILON = 1e-9;

const isEnabledStockDefinition = (definition: StockDefConfig): definition is StockMarketDefinition => {
  const scaledInitialPrice = definition.initial_price_spirit_stones * STOCK_MARKET_PRICE_SCALE_NUMBER;
  return definition.enabled !== false
    && definition.id.trim().length > 0
    && definition.code.trim().length > 0
    && definition.name.trim().length > 0
    && Number.isFinite(definition.initial_price_spirit_stones)
    && definition.initial_price_spirit_stones > 0
    && Math.abs(scaledInitialPrice - Math.round(scaledInitialPrice)) <= STOCK_MARKET_INITIAL_PRICE_EPSILON;
};

let enabledStockDefinitionsSnapshot: readonly StockMarketDefinition[] | null = null;

export const getEnabledStockDefinitions = (): readonly StockMarketDefinition[] => {
  if (enabledStockDefinitionsSnapshot) return enabledStockDefinitionsSnapshot;

  enabledStockDefinitionsSnapshot = Object.freeze(
    getStockDefinitions()
      .filter(isEnabledStockDefinition)
      .slice()
      .sort((left, right) => {
        const sortDelta = (left.sort_weight ?? 0) - (right.sort_weight ?? 0);
        if (sortDelta !== 0) return sortDelta;
        return left.id.localeCompare(right.id);
      }),
  );
  return enabledStockDefinitionsSnapshot;
};

export const getEnabledStockDefinitionMap = createStaticDefinitionIndexGetter({
  loadDefinitions: getEnabledStockDefinitions,
  include: () => true,
});

export const getEnabledStockDefinitionById = (stockId: string): StockMarketDefinition | null => {
  const normalizedStockId = stockId.trim();
  if (!normalizedStockId) return null;
  return getEnabledStockDefinitionMap().get(normalizedStockId) ?? null;
};

export const getEnabledStockIdSet = (): ReadonlySet<string> => {
  return new Set(getEnabledStockDefinitions().map((definition) => definition.id));
};
