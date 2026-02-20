import api from './core';

/**
 * 全局配置接口（分类字典等）
 *
 * 作用：
 * - 从后端拉取全游戏统一 taxonomy（一级分类/子分类），避免前端分模块维护分类口径。
 * - 不做什么：不缓存、不持久化，缓存策略由上层 shared loader 负责。
 *
 * 输入/输出：
 * - 输入：无参数。
 * - 输出：`GameItemTaxonomyDto`，仅包含统一 categories/subCategories。
 *
 * 关键边界条件与坑点：
 * 1) `categories.all` 仅用于 UI 过滤态；业务规则提交应使用 `categories.options` 里的真实一级分类。
 * 2) 分类值以后端 `item_def.category` 为准，前端不做别名/转换。
 */

export interface ItemTaxonomyOptionDto {
  value: string;
  label: string;
}

export interface GameItemTaxonomyDto {
  categories: {
    all: ItemTaxonomyOptionDto;
    options: ItemTaxonomyOptionDto[];
    labels: Record<string, string>;
  };
  subCategories: {
    options: ItemTaxonomyOptionDto[];
    labels: Record<string, string>;
    byCategory: Record<string, string[]>;
  };
}

export interface GameItemTaxonomyResponse {
  success: boolean;
  message?: string;
  data?: {
    taxonomy: GameItemTaxonomyDto;
  };
}

export const getGameItemTaxonomy = (): Promise<GameItemTaxonomyResponse> => {
  return api.get('/info/item-taxonomy');
};
