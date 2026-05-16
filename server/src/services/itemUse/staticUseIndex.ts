/**
 * 物品使用静态索引
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：为物品使用流程提供只依赖静态配置的高频查询索引，目前集中提供随机宝石候选 id 查询。
 * 2. 做什么：按 getItemDefinitions 返回的数组引用自动失效，静态配置刷新后重建候选缓存。
 * 3. 不做什么：不执行随机抽取、不读取数据库、不处理背包写入和掉落展示。
 *
 * 输入 / 输出：
 * - 输入：随机宝石 scope，包含子分类列表、最小宝石等级、最大宝石等级。
 * - 输出：满足启用态、宝石语义、子分类和等级范围的物品定义 id 只读数组。
 *
 * 数据流 / 状态流：
 * staticConfigLoader 读取物品定义数组 -> 本模块按数组引用维护快照
 * -> 按排序后的 scope key 缓存候选 id -> itemService.useItem 读取候选并执行随机抽取。
 *
 * 复用设计说明：
 * - 将随机宝石候选筛选从 useItem 分支抽到单一入口，避免礼包、宝石袋或后续掉落扩展重复维护 category/sub_category/gem_level 规则。
 * - getGemLevel 与 isGemItemDefinition 继续复用共享宝石语义，宝石身份和等级口径只保留一个业务来源。
 * - 子分类和等级范围是高频变化点，因此进入 scope key；物品定义数组是配置刷新边界，因此进入快照失效条件。
 *
 * 关键边界条件与坑点：
 * 1. 缓存失效必须比较源数组引用，不能只比较长度；热更新可能替换同长度数组。
 * 2. scope key 必须用结构化序列化包含排序后的子分类和等级范围，否则分隔符拼接可能产生碰撞。
 * 3. 返回数组会冻结并复用，调用方不能写入；如需聚合结果，应在调用方维护自己的 Map。
 */
import { getItemDefinitions, type ItemDefConfig } from '../staticConfigLoader.js';
import { getGemLevel, isGemItemDefinition } from '../shared/gemItemSemantics.js';

export type RandomGemItemDefinitionScope = {
  subCategories: readonly string[];
  minLevel: number;
  maxLevel: number;
};

type StaticUseIndexSnapshot = {
  source: readonly ItemDefConfig[];
  randomGemIdsByScope: Map<string, readonly string[]>;
};

let snapshot: StaticUseIndexSnapshot | null = null;

const normalizeScopeSubCategories = (
  subCategories: readonly string[],
): readonly string[] => {
  return Object.freeze(
    Array.from(
      new Set(
        subCategories
          .map((entry) => entry.trim())
          .filter((entry) => entry.length > 0),
      ),
    ).sort(),
  );
};

const buildRandomGemScopeKey = (
  subCategories: readonly string[],
  minLevel: number,
  maxLevel: number,
): string => {
  return JSON.stringify([subCategories, minLevel, maxLevel]);
};

const ensureSnapshot = (): StaticUseIndexSnapshot => {
  const itemDefinitions = getItemDefinitions();
  if (snapshot === null || snapshot.source !== itemDefinitions) {
    snapshot = {
      source: itemDefinitions,
      randomGemIdsByScope: new Map<string, readonly string[]>(),
    };
  }
  return snapshot;
};

const buildRandomGemItemDefinitionIds = (
  itemDefinitions: readonly ItemDefConfig[],
  subCategories: readonly string[],
  minLevel: number,
  maxLevel: number,
): readonly string[] => {
  const subCategorySet = new Set(subCategories);
  const gemIds: string[] = [];

  for (const definition of itemDefinitions) {
    if (definition.enabled === false) continue;
    if (!isGemItemDefinition(definition)) continue;

    const subCategory = String(definition.sub_category || '').trim();
    if (!subCategorySet.has(subCategory)) continue;

    const gemLevel = getGemLevel(definition);
    if (gemLevel === null || gemLevel < minLevel || gemLevel > maxLevel) continue;

    const id = String(definition.id || '').trim();
    if (id.length === 0) continue;
    gemIds.push(id);
  }

  return Object.freeze(gemIds);
};

export const getRandomGemItemDefinitionIds = (
  scope: RandomGemItemDefinitionScope,
): readonly string[] => {
  const minLevel = Math.floor(scope.minLevel);
  const maxLevel = Math.floor(scope.maxLevel);
  const subCategories = normalizeScopeSubCategories(scope.subCategories);
  const scopeKey = buildRandomGemScopeKey(subCategories, minLevel, maxLevel);
  const currentSnapshot = ensureSnapshot();
  const cachedIds = currentSnapshot.randomGemIdsByScope.get(scopeKey);
  if (cachedIds) return cachedIds;

  const gemIds = buildRandomGemItemDefinitionIds(
    currentSnapshot.source,
    subCategories,
    minLevel,
    maxLevel,
  );
  currentSnapshot.randomGemIdsByScope.set(scopeKey, gemIds);
  return gemIds;
};
