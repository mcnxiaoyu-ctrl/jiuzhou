import { query } from '../config/database.js';
import { getItemDefinitionsByIds } from './staticConfigLoader.js';
import { resolveSkillTriggerType } from '../shared/skillTriggerType.js';
import { resolveQualityRankFromName } from './shared/itemQuality.js';
import {
  getEnabledTechniqueDefinitionById,
  getEnabledTechniqueLayersByTechniqueId,
  getEnabledTechniqueSkillsByTechniqueId,
  getVisibleTechniqueDefinitionById,
  getVisibleTechniqueDefinitionsSorted,
} from './technique/definitionReadModel.js';

export type TechniqueDefRow = {
  id: string;
  code: string | null;
  name: string;
  type: string;
  quality: string;
  quality_rank: number;
  max_layer: number;
  required_realm: string;
  attribute_type: string;
  attribute_element: string;
  tags: string[];
  description: string | null;
  long_desc: string | null;
  icon: string | null;
  obtain_type: string | null;
  obtain_hint: string[];
  sort_weight: number;
  version: number;
  enabled: boolean;
};

export type TechniqueLayerRow = {
  technique_id: string;
  layer: number;
  cost_spirit_stones: number;
  cost_exp: number;
  cost_materials: unknown;
  passives: unknown;
  unlock_skill_ids: string[];
  upgrade_skill_ids: string[];
  required_realm: string | null;
  required_quest_id: string | null;
  layer_desc: string | null;
};

export type SkillDefRow = {
  id: string;
  code: string | null;
  name: string;
  description: string | null;
  icon: string | null;
  source_type: string;
  source_id: string | null;
  cost_lingqi: number;
  cost_lingqi_rate: number;
  cost_qixue: number;
  cost_qixue_rate: number;
  cooldown: number;
  target_type: string;
  target_count: number;
  damage_type: string | null;
  element: string;
  effects: unknown[];
  trigger_type: string;
  conditions: unknown;
  ai_priority: number;
  ai_conditions: unknown;
  upgrades: unknown;
  sort_weight: number;
  version: number;
  enabled: boolean;
};

export type TechniqueDetailRow = {
  technique: TechniqueDefRow;
  layers: TechniqueLayerRow[];
  skills: SkillDefRow[];
};

export type TechniqueLayerVisibility = 'preview' | 'learned';

const coerceCostMaterials = (raw: unknown): Array<{ itemId: string; qty: number }> => {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((x) => {
      if (!x || typeof x !== 'object') return null;
      const itemId = (x as { itemId?: unknown }).itemId;
      const qty = (x as { qty?: unknown }).qty;
      if (typeof itemId !== 'string') return null;
      if (typeof qty !== 'number') return null;
      return { itemId, qty };
    })
    .filter((v): v is { itemId: string; qty: number } => !!v);
};

const getItemMetaMap = async (itemIds: string[]): Promise<Map<string, { name: string; icon: string | null }>> => {
  const uniq = Array.from(new Set(itemIds.filter((x) => typeof x === 'string' && x.trim().length > 0)));
  if (uniq.length === 0) return new Map();
  const defs = getItemDefinitionsByIds(uniq);
  const out = new Map<string, { name: string; icon: string | null }>();
  for (const id of uniq) {
    const def = defs.get(id);
    if (!def || def.enabled === false) continue;
    out.set(id, {
      name: String(def.name || id),
      icon: typeof def.icon === 'string' ? def.icon : null,
    });
  }
  return out;
};

const resolveTechniqueCostMultiplierByQuality = (qualityRaw: unknown): number => {
  return Math.max(1, Math.floor(resolveQualityRankFromName(qualityRaw, 1)));
};

const scaleTechniqueBaseCostByQuality = (baseCost: number, qualityMultiplier: number): number => {
  const normalizedBaseCost = Math.max(0, Math.floor(Number(baseCost) || 0));
  const normalizedMultiplier = Math.max(1, Math.floor(Number(qualityMultiplier) || 1));
  return normalizedBaseCost * normalizedMultiplier;
};

const normalizeCharacterId = (characterIdRaw: number | null | undefined): number | null => {
  const characterId = Number(characterIdRaw);
  if (!Number.isFinite(characterId) || characterId <= 0) return null;
  return Math.floor(characterId);
};

const canCharacterViewTechniqueSensitiveLayers = async (
  techniqueId: string,
  characterIdRaw: number | null | undefined,
): Promise<boolean> => {
  const characterId = normalizeCharacterId(characterIdRaw);
  if (!characterId) return false;

  const result = await query(
    'SELECT 1 FROM character_technique WHERE character_id = $1 AND technique_id = $2 LIMIT 1',
    [characterId, techniqueId],
  );
  return Number(result.rowCount ?? 0) > 0;
};

export const applyTechniqueLayerVisibility = (
  layers: TechniqueLayerRow[],
  visibility: TechniqueLayerVisibility,
): TechniqueLayerRow[] => {
  if (visibility === 'learned') return layers;

  // 把“未学习只能看预览”的裁剪规则收敛在这里，避免坊市、背包和详情页各自维护一套敏感字段判断。
  // 预览态只允许保留公开基础信息；层级消耗、被动与技能解锁进度都视为敏感成长数据，不能继续外露。
  return layers.map((layer) => ({
    ...layer,
    cost_spirit_stones: 0,
    cost_exp: 0,
    cost_materials: [],
    passives: [],
    unlock_skill_ids: [],
    upgrade_skill_ids: [],
  }));
};

type TechniqueDefEntry = ReturnType<typeof getVisibleTechniqueDefinitionsSorted>[number];

/**
 * 将静态功法定义映射为路由层返回结构。
 * 统一映射可避免“列表接口”和“详情接口”字段漂移。
 */
const mapTechniqueDefRow = (entry: TechniqueDefEntry): TechniqueDefRow => {
  return {
    id: entry.id,
    code: entry.code ?? null,
    name: entry.name,
    type: entry.type,
    quality: entry.quality,
    quality_rank: resolveQualityRankFromName(entry.quality, 1),
    max_layer: Number(entry.max_layer ?? 1),
    required_realm: entry.required_realm ?? '凡人',
    attribute_type: entry.attribute_type ?? 'physical',
    attribute_element: entry.attribute_element ?? 'none',
    tags: Array.isArray(entry.tags) ? entry.tags : [],
    description: entry.description ?? null,
    long_desc: entry.long_desc ?? null,
    icon: entry.icon ?? null,
    obtain_type: entry.obtain_type ?? null,
    obtain_hint: Array.isArray(entry.obtain_hint) ? entry.obtain_hint : [],
    sort_weight: Number(entry.sort_weight ?? 0),
    version: Number(entry.version ?? 1),
    enabled: true,
  };
};

export const getEnabledTechniqueDefs = async (): Promise<TechniqueDefRow[]> => {
  return getVisibleTechniqueDefinitionsSorted().map(mapTechniqueDefRow);
};

export const getTechniqueDefById = async (techniqueId: string): Promise<TechniqueDefRow | null> => {
  const id = String(techniqueId || '').trim();
  if (!id) return null;
  const entry = getVisibleTechniqueDefinitionById(id);
  if (!entry) return null;
  return mapTechniqueDefRow(entry);
};

export const getTechniqueLayersByTechniqueId = async (techniqueId: string): Promise<TechniqueLayerRow[]> => {
  const techniqueDef = getVisibleTechniqueDefinitionById(techniqueId);
  if (!techniqueDef) return [];
  const qualityMultiplier = resolveTechniqueCostMultiplierByQuality(techniqueDef.quality);
  return buildTechniqueLayerRows(techniqueId, qualityMultiplier);
};

const buildTechniqueLayerRows = async (
  techniqueId: string,
  qualityMultiplier: number,
): Promise<TechniqueLayerRow[]> => {
  const itemIds: string[] = [];
  const layerEntries: Array<{
    row: TechniqueLayerRow;
    costMaterials: Array<{ itemId: string; qty: number }>;
  }> = [];

  for (const entry of getEnabledTechniqueLayersByTechniqueId(techniqueId)) {
    const costMaterials = coerceCostMaterials(entry.cost_materials);
    for (const material of costMaterials) {
      itemIds.push(material.itemId);
    }
    layerEntries.push({
      row: {
        technique_id: entry.technique_id,
        layer: Number(entry.layer),
        cost_spirit_stones: scaleTechniqueBaseCostByQuality(Number(entry.cost_spirit_stones ?? 0), qualityMultiplier),
        cost_exp: scaleTechniqueBaseCostByQuality(Number(entry.cost_exp ?? 0), qualityMultiplier),
        cost_materials: costMaterials,
        passives: Array.isArray(entry.passives) ? entry.passives : [],
        unlock_skill_ids: Array.isArray(entry.unlock_skill_ids) ? entry.unlock_skill_ids : [],
        upgrade_skill_ids: Array.isArray(entry.upgrade_skill_ids) ? entry.upgrade_skill_ids : [],
        required_realm: typeof entry.required_realm === 'string' ? entry.required_realm : null,
        required_quest_id: typeof entry.required_quest_id === 'string' ? entry.required_quest_id : null,
        layer_desc: typeof entry.layer_desc === 'string' ? entry.layer_desc : null,
      },
      costMaterials,
    });
  }

  const metaMap = await getItemMetaMap(itemIds);
  return layerEntries.map((entry) => {
    const materials = entry.costMaterials.map((material) => {
      const meta = metaMap.get(material.itemId) ?? null;
      return { itemId: material.itemId, qty: material.qty, itemName: meta?.name, itemIcon: meta?.icon };
    });
    return { ...entry.row, cost_materials: materials };
  });
};

export const getTechniqueLayersByTechniqueIdForPartner = async (
  techniqueId: string,
): Promise<TechniqueLayerRow[]> => {
  const techniqueDef = getEnabledTechniqueDefinitionById(techniqueId);
  if (!techniqueDef) return [];
  const qualityMultiplier = resolveTechniqueCostMultiplierByQuality(techniqueDef.quality);
  return buildTechniqueLayerRows(techniqueId, qualityMultiplier);
};

export const getSkillsByTechniqueId = async (techniqueId: string): Promise<SkillDefRow[]> => {
  return getEnabledTechniqueSkillsByTechniqueId(techniqueId)
    .map((entry) => ({
      id: entry.id,
      code: entry.code ?? null,
      name: entry.name,
      description: entry.description ?? null,
      icon: entry.icon ?? null,
      source_type: entry.source_type,
      source_id: entry.source_id ?? null,
      cost_lingqi: Number(entry.cost_lingqi ?? 0),
      cost_lingqi_rate: Number(entry.cost_lingqi_rate ?? 0),
      cost_qixue: Number(entry.cost_qixue ?? 0),
      cost_qixue_rate: Number(entry.cost_qixue_rate ?? 0),
      cooldown: Number(entry.cooldown ?? 0),
      target_type: entry.target_type,
      target_count: Number(entry.target_count ?? 1),
      damage_type: entry.damage_type ?? null,
      element: entry.element ?? 'none',
      effects: Array.isArray(entry.effects) ? entry.effects : [],
      trigger_type: resolveSkillTriggerType({
        triggerType: entry.trigger_type,
        effects: Array.isArray(entry.effects)
          ? (entry.effects as Array<{ type?: string; buffKind?: string }>)
          : [],
      }),
      conditions: entry.conditions ?? null,
      ai_priority: Number(entry.ai_priority ?? 50),
      ai_conditions: entry.ai_conditions ?? null,
      upgrades: entry.upgrades ?? [],
      sort_weight: Number(entry.sort_weight ?? 0),
      version: Number(entry.version ?? 1),
      enabled: true,
    } satisfies SkillDefRow));
};

export const getTechniqueDetailById = async (
  techniqueId: string,
  options?: { viewerCharacterId?: number | null },
): Promise<TechniqueDetailRow | null> => {
  const technique = await getTechniqueDefById(techniqueId);
  if (!technique) return null;

  const [layers, skills, canViewSensitiveLayers] = await Promise.all([
    getTechniqueLayersByTechniqueId(techniqueId),
    getSkillsByTechniqueId(techniqueId),
    canCharacterViewTechniqueSensitiveLayers(techniqueId, options?.viewerCharacterId),
  ]);

  const visibility: TechniqueLayerVisibility = canViewSensitiveLayers ? 'learned' : 'preview';
  return {
    technique,
    layers: applyTechniqueLayerVisibility(layers, visibility),
    skills,
  };
};

export const getTechniqueDetailByIdForPartner = async (
  techniqueId: string,
): Promise<TechniqueDetailRow | null> => {
  const techniqueEntry = getEnabledTechniqueDefinitionById(techniqueId);
  if (!techniqueEntry) return null;

  const [layers, skills] = await Promise.all([
    getTechniqueLayersByTechniqueIdForPartner(techniqueId),
    getSkillsByTechniqueId(techniqueId),
  ]);

  return {
    technique: mapTechniqueDefRow(techniqueEntry),
    layers,
    skills,
  };
};
