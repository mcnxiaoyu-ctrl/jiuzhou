import type { ItemDefConfig } from '../staticConfigLoader.js';

/**
 * 作用：
 * - 统一坊市对“物品一级分类”的读取口径：直接使用后端真实 `item_def.category`。
 * - 不做什么：不做 skillbook/technique/effect_defs 的语义转换，不引入模块私有分类。
 *
 * 输入/输出：
 * - 输入：物品定义中的 `category`，以及外部传入的分类筛选参数。
 * - 输出：
 *   1) `resolveMarketItemCategory`：返回标准化后的一级分类（小写）；
 *   2) `normalizeMarketCategoryFilter`：返回标准化后的筛选值（仅保留 `all` 特例）。
 *
 * 数据流/状态流：
 * - 路由层接收 `category` 查询参数 -> `normalizeMarketCategoryFilter` 标准化。
 * - 列表服务读取 item definitions -> `resolveMarketItemCategory` 获取真实一级分类 -> 用于筛选与返回 DTO。
 *
 * 关键边界条件与坑点：
 * - 空 category 视为无效分类（返回空字符串），调用方需自行决定展示/过滤策略。
 * - 为保证“后端权威”，该模块禁止中文别名与历史别名映射。
 */

export type MarketItemCategory = string;
export type MarketCategoryFilter = 'all' | string;

type ItemCategoryLike = Pick<ItemDefConfig, 'category'>;

const normalizeToken = (value: unknown): string => {
  return String(value ?? '').trim().toLowerCase();
};

export const resolveMarketItemCategory = (itemDef: ItemCategoryLike | null | undefined): MarketItemCategory => {
  if (!itemDef) return '';
  return normalizeToken(itemDef.category);
};

export const normalizeMarketCategoryFilter = (value: unknown): MarketCategoryFilter | null => {
  const raw = normalizeToken(value);
  if (!raw || raw === 'all') return 'all';
  return raw;
};
