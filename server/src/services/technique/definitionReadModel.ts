/**
 * 功法静态定义读模型
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：把功法定义、功法层级、功法技能一次性构建成请求侧可直接读取的索引和预排序列表。
 * 2. 做什么：集中维护启用态、角色可见功法、层级排序、技能排序等高频读取规则。
 * 3. 不做什么：不做路由返回结构映射，不读取数据库，也不处理功法层级材料的物品名富化。
 *
 * 输入/输出：
 * - 输入：staticConfigLoader 暴露的功法、层级、技能静态定义数组。
 * - 输出：按功法 id 查询的可见/启用功法、启用层级列表、启用技能列表，以及可见功法预排序列表。
 *
 * 数据流/状态流：
 * staticConfigLoader 同步读取源数组 -> 本模块按源数组引用判断是否重建快照 -> techniqueService 读取索引结果并映射成接口行。
 *
 * 复用设计说明：
 * 1. 将原本散落在列表、详情、伙伴详情中的 `find/filter/sort` 合并为单一读模型入口，避免多个请求入口重复扫描同一批静态数据。
 * 2. `visibleTechniqueById` 服务角色侧列表与详情，`enabledTechniqueById` 服务伙伴详情，层级与技能索引被角色和伙伴详情共同复用。
 * 3. 启用态、可见性和排序是高频业务变化点，集中放在这里能减少后续新增入口时的重复维护。
 *
 * 关键边界条件与坑点：
 * 1. 缓存失效必须同时比较功法、技能、层级三个源数组引用，否则任一静态配置刷新后都可能继续读取旧索引。
 * 2. 角色可见功法与伙伴可读功法口径不同：角色入口只能读 `visibleTechniqueById`，伙伴入口需要读所有启用功法。
 * 3. 层级和技能只按启用态纳入索引，不在这里判断功法是否存在，调用方必须先按自己的可见性口径确认功法。
 */

import {
  getSkillDefinitions,
  getTechniqueDefinitions,
  getTechniqueLayerDefinitions,
  type SkillDefConfig,
  type TechniqueDefConfig,
  type TechniqueLayerConfig,
} from '../staticConfigLoader.js';
import { resolveQualityRankFromName } from '../shared/itemQuality.js';
import { isCharacterVisibleTechniqueDefinition } from '../shared/techniqueUsageScope.js';

export type TechniqueDefinitionReadModelSnapshot = {
  techniqueSource: readonly TechniqueDefConfig[];
  skillSource: readonly SkillDefConfig[];
  layerSource: readonly TechniqueLayerConfig[];
  visibleTechniqueById: ReadonlyMap<string, TechniqueDefConfig>;
  enabledTechniqueById: ReadonlyMap<string, TechniqueDefConfig>;
  visibleTechniqueList: readonly TechniqueDefConfig[];
  layersByTechniqueId: ReadonlyMap<string, readonly TechniqueLayerConfig[]>;
  skillsByTechniqueId: ReadonlyMap<string, readonly SkillDefConfig[]>;
};

let snapshot: TechniqueDefinitionReadModelSnapshot | null = null;

const freezeReadonlyArray = <TEntry>(rows: TEntry[]): readonly TEntry[] => {
  return Object.freeze(rows);
};

const EMPTY_TECHNIQUE_LAYERS = freezeReadonlyArray<TechniqueLayerConfig>([]);
const EMPTY_TECHNIQUE_SKILLS = freezeReadonlyArray<SkillDefConfig>([]);

const compareVisibleTechniqueDefinitions = (
  left: TechniqueDefConfig,
  right: TechniqueDefConfig,
): number => {
  return Number(right.sort_weight ?? 0) - Number(left.sort_weight ?? 0) ||
    resolveQualityRankFromName(right.quality, 1) - resolveQualityRankFromName(left.quality, 1) ||
    left.id.localeCompare(right.id);
};

const compareTechniqueLayers = (
  left: TechniqueLayerConfig,
  right: TechniqueLayerConfig,
): number => {
  return Number(left.layer) - Number(right.layer);
};

const compareTechniqueSkills = (
  left: SkillDefConfig,
  right: SkillDefConfig,
): number => {
  return Number(right.sort_weight ?? 0) - Number(left.sort_weight ?? 0) ||
    left.id.localeCompare(right.id);
};

const appendGroupedEntry = <TEntry>(
  groupMap: Map<string, TEntry[]>,
  groupKey: string,
  entry: TEntry,
): void => {
  const rows = groupMap.get(groupKey);
  if (rows) {
    rows.push(entry);
    return;
  }
  groupMap.set(groupKey, [entry]);
};

const buildTechniqueDefinitionReadModelSnapshot = (
  techniqueDefinitions: readonly TechniqueDefConfig[],
  skillDefinitions: readonly SkillDefConfig[],
  layerDefinitions: readonly TechniqueLayerConfig[],
): TechniqueDefinitionReadModelSnapshot => {
  const visibleTechniqueById = new Map<string, TechniqueDefConfig>();
  const enabledTechniqueById = new Map<string, TechniqueDefConfig>();
  const visibleTechniqueList: TechniqueDefConfig[] = [];

  for (const definition of techniqueDefinitions) {
    if (definition.enabled === false) continue;

    enabledTechniqueById.set(definition.id, definition);
    if (!isCharacterVisibleTechniqueDefinition(definition)) continue;

    visibleTechniqueById.set(definition.id, definition);
    visibleTechniqueList.push(definition);
  }
  const sortedVisibleTechniqueList = freezeReadonlyArray(
    visibleTechniqueList.sort(compareVisibleTechniqueDefinitions),
  );

  const layersByTechniqueId = new Map<string, TechniqueLayerConfig[]>();
  for (const definition of layerDefinitions) {
    if (definition.enabled === false) continue;
    appendGroupedEntry(layersByTechniqueId, definition.technique_id, definition);
  }
  const frozenLayersByTechniqueId = new Map<string, readonly TechniqueLayerConfig[]>();
  for (const [techniqueId, rows] of layersByTechniqueId.entries()) {
    frozenLayersByTechniqueId.set(
      techniqueId,
      freezeReadonlyArray(rows.sort(compareTechniqueLayers)),
    );
  }

  const skillsByTechniqueId = new Map<string, SkillDefConfig[]>();
  for (const definition of skillDefinitions) {
    if (definition.enabled === false) continue;
    if (definition.source_type !== 'technique') continue;
    if (typeof definition.source_id !== 'string') continue;
    appendGroupedEntry(skillsByTechniqueId, definition.source_id, definition);
  }
  const frozenSkillsByTechniqueId = new Map<string, readonly SkillDefConfig[]>();
  for (const [techniqueId, rows] of skillsByTechniqueId.entries()) {
    frozenSkillsByTechniqueId.set(
      techniqueId,
      freezeReadonlyArray(rows.sort(compareTechniqueSkills)),
    );
  }

  return {
    techniqueSource: techniqueDefinitions,
    skillSource: skillDefinitions,
    layerSource: layerDefinitions,
    visibleTechniqueById,
    enabledTechniqueById,
    visibleTechniqueList: sortedVisibleTechniqueList,
    layersByTechniqueId: frozenLayersByTechniqueId,
    skillsByTechniqueId: frozenSkillsByTechniqueId,
  };
};

const ensureTechniqueDefinitionReadModelSnapshot = (): TechniqueDefinitionReadModelSnapshot => {
  const techniqueDefinitions = getTechniqueDefinitions();
  const skillDefinitions = getSkillDefinitions();
  const layerDefinitions = getTechniqueLayerDefinitions();

  if (
    snapshot === null ||
    snapshot.techniqueSource !== techniqueDefinitions ||
    snapshot.skillSource !== skillDefinitions ||
    snapshot.layerSource !== layerDefinitions
  ) {
    snapshot = buildTechniqueDefinitionReadModelSnapshot(
      techniqueDefinitions,
      skillDefinitions,
      layerDefinitions,
    );
  }

  return snapshot;
};

export const getVisibleTechniqueDefinitionsSorted = (): readonly TechniqueDefConfig[] => {
  return ensureTechniqueDefinitionReadModelSnapshot().visibleTechniqueList;
};

export const getVisibleTechniqueDefinitionById = (
  techniqueId: string,
): TechniqueDefConfig | null => {
  const id = String(techniqueId || '').trim();
  if (!id) return null;
  return ensureTechniqueDefinitionReadModelSnapshot().visibleTechniqueById.get(id) ?? null;
};

export const getEnabledTechniqueDefinitionById = (
  techniqueId: string,
): TechniqueDefConfig | null => {
  const id = String(techniqueId || '').trim();
  if (!id) return null;
  return ensureTechniqueDefinitionReadModelSnapshot().enabledTechniqueById.get(id) ?? null;
};

export const getEnabledTechniqueLayersByTechniqueId = (
  techniqueId: string,
): readonly TechniqueLayerConfig[] => {
  const id = String(techniqueId || '').trim();
  if (!id) return EMPTY_TECHNIQUE_LAYERS;
  return ensureTechniqueDefinitionReadModelSnapshot().layersByTechniqueId.get(id) ?? EMPTY_TECHNIQUE_LAYERS;
};

export const getEnabledTechniqueSkillsByTechniqueId = (
  techniqueId: string,
): readonly SkillDefConfig[] => {
  const id = String(techniqueId || '').trim();
  if (!id) return EMPTY_TECHNIQUE_SKILLS;
  return ensureTechniqueDefinitionReadModelSnapshot().skillsByTechniqueId.get(id) ?? EMPTY_TECHNIQUE_SKILLS;
};
