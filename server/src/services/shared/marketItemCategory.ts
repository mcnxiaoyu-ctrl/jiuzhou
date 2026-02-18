import type { ItemDefConfig } from '../staticConfigLoader.js';

/**
 * 作用：
 * - 统一坊市“物品定义 -> 展示/筛选分类”的语义，避免在多个服务里重复写 category/sub_category/effect_defs 判断。
 * - 不做什么：不负责 SQL 查询、不处理价格/品质筛选、不改动物品定义本身。
 *
 * 输入/输出：
 * - 输入：物品定义中的 `category`、`sub_category`、`effect_defs`，以及外部传入的分类筛选参数。
 * - 输出：
 *   1) `resolveMarketItemCategory`：返回坊市稳定分类（consumable/material/gem/equipment/skillbook/other）。
 *   2) `normalizeMarketCategoryFilter`：把查询参数归一为可用分类（含 all）或 null（非法值）。
 *
 * 数据流/状态流：
 * - 路由层接收 `category` 查询参数 -> `normalizeMarketCategoryFilter` 标准化。
 * - 列表服务遍历 item definitions -> `resolveMarketItemCategory` 计算每个物品的坊市分类 -> 用于筛选与返回 DTO。
 * - 全链路不持有状态，仅做纯函数映射，便于在 Market/Inventory 等模块复用同一规则。
 *
 * 关键边界条件与坑点：
 * - 历史功法书可能存成 `category=consumable`，但 `sub_category=technique_book` 或 `effect_defs` 含 `learn_technique`；
 *   该模块会统一归一为 `skillbook`，避免被误判为丹药。
 * - `effect_defs` 可能是数组、单对象或脏数据；内部会先归一为对象数组再判断，避免结构差异导致漏判。
 */

export type MarketItemCategory = 'consumable' | 'material' | 'gem' | 'equipment' | 'skillbook' | 'other';
export type MarketCategoryFilter = MarketItemCategory | 'all';

type ItemCategoryLike = Pick<ItemDefConfig, 'category' | 'sub_category' | 'effect_defs'>;

const normalizeToken = (value: unknown): string => {
  return String(value ?? '').trim().toLowerCase();
};

const coerceEffectDefs = (value: unknown): Array<Record<string, unknown>> => {
  if (Array.isArray(value)) {
    return value.filter(
      (entry): entry is Record<string, unknown> =>
        Boolean(entry) && typeof entry === 'object' && !Array.isArray(entry),
    );
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return [value as Record<string, unknown>];
  }
  return [];
};

const hasLearnTechniqueEffect = (effectDefs: unknown): boolean => {
  return coerceEffectDefs(effectDefs).some((row) => normalizeToken(row.effect_type) === 'learn_technique');
};

const isTechniqueLikeItemDef = (itemDef: ItemCategoryLike | null | undefined): boolean => {
  if (!itemDef) return false;
  const category = normalizeToken(itemDef.category);
  const subCategory = normalizeToken(itemDef.sub_category);
  if (category === 'skillbook' || category === 'skill' || category === 'technique' || category === 'technique_book') {
    return true;
  }
  if (subCategory === 'technique' || subCategory === 'technique_book') return true;
  return hasLearnTechniqueEffect(itemDef.effect_defs);
};

export const resolveMarketItemCategory = (itemDef: ItemCategoryLike | null | undefined): MarketItemCategory => {
  if (!itemDef) return 'other';
  if (isTechniqueLikeItemDef(itemDef)) return 'skillbook';
  const category = normalizeToken(itemDef.category);
  if (category === 'consumable') return 'consumable';
  if (category === 'material') return 'material';
  if (category === 'gem') return 'gem';
  if (category === 'equipment') return 'equipment';
  if (category === 'skillbook') return 'skillbook';
  return 'other';
};

export const normalizeMarketCategoryFilter = (value: unknown): MarketCategoryFilter | null => {
  const raw = normalizeToken(value);
  if (!raw || raw === 'all' || raw === '全部' || raw === '全部分类') return 'all';
  if (raw === 'consumable' || raw === '丹药') return 'consumable';
  if (raw === 'material' || raw === '材料') return 'material';
  if (raw === 'gem' || raw === '宝石') return 'gem';
  if (raw === 'equipment' || raw === '装备') return 'equipment';
  if (raw === 'skillbook' || raw === 'skill' || raw === 'technique' || raw === '功法' || raw === '功法书') {
    return 'skillbook';
  }
  if (raw === 'other' || raw === '其他') return 'other';
  return null;
};
