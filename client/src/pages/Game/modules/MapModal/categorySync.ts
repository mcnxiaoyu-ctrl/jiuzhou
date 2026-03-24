import type { MapModalCategory } from './lastDungeonSelection';

/**
 * MapModal 默认分类同步规则。
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：集中判断 `initialCategory` 何时应该同步到弹窗内部分类状态，避免组件 effect 散落“打开时默认值”和“用户手动切换”两套判断。
 * 2. 做什么：让 MapModal 在“首次打开”或“父层明确切换入口分类”时更新当前 tab，同时保留用户在弹窗内主动切换的结果。
 * 3. 不做什么：不持有 React state、不直接清理查询词/选中项，也不决定地图列表如何请求。
 *
 * 输入/输出：
 * - 输入：弹窗是否打开、当前分类、父层传入的默认分类、当前打开周期里最近一次已消费的默认分类。
 * - 输出：是否需要同步、同步后的分类，以及本次应记录为“已消费”的默认分类。
 *
 * 数据流/状态流：
 * - Game 传入入口默认分类 -> 本模块判定是否应该同步 -> MapModal 在需要时更新 category 与关联 UI 状态。
 *
 * 关键边界条件与坑点：
 * 1. 同一个打开周期里，已经消费过的 `initialCategory` 不能再次覆盖用户点击结果，否则 tab 会看起来“点了没反应”。
 * 2. 父层若在弹窗打开期间明确切换入口分类，必须允许再次同步，否则从功能菜单切换入口时会停留在旧 tab。
 */

type ResolveMapModalCategorySyncParams = {
  open: boolean;
  category: MapModalCategory;
  initialCategory?: MapModalCategory;
  appliedInitialCategory: MapModalCategory | null;
};

type ResolveMapModalCategorySyncResult = {
  shouldSync: boolean;
  nextCategory: MapModalCategory;
  nextAppliedInitialCategory: MapModalCategory | null;
};

export const resolveMapModalCategorySync = (
  params: ResolveMapModalCategorySyncParams,
): ResolveMapModalCategorySyncResult => {
  if (!params.open) {
    return {
      shouldSync: false,
      nextCategory: params.category,
      nextAppliedInitialCategory: null,
    };
  }

  const nextInitialCategory = params.initialCategory;
  if (!nextInitialCategory) {
    return {
      shouldSync: false,
      nextCategory: params.category,
      nextAppliedInitialCategory: params.appliedInitialCategory,
    };
  }

  if (nextInitialCategory === params.appliedInitialCategory) {
    return {
      shouldSync: false,
      nextCategory: params.category,
      nextAppliedInitialCategory: params.appliedInitialCategory,
    };
  }

  return {
    shouldSync: true,
    nextCategory: nextInitialCategory,
    nextAppliedInitialCategory: nextInitialCategory,
  };
};
