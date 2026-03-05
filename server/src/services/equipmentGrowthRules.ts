import { QUALITY_MULTIPLIER_BY_RANK } from "./shared/itemQuality.js";
import { getItemDefinitionById } from "./staticConfigLoader.js";

export type CharacterAttrRecord = Record<string, number>;

export type SocketApplyType = "flat" | "percent" | "special";

export interface SocketEffect {
  attrKey: string;
  value: number;
  applyType: SocketApplyType;
}

export interface SocketedGemEntry {
  slot: number;
  itemDefId: string;
  gemType: string;
  effects: SocketEffect[];
  name?: string;
  icon?: string;
}

const DEFAULT_SOCKET_MAX_BY_QUALITY_RANK: Record<number, number> = {
  1: 1,
  2: 2,
  3: 3,
  4: 4,
};

export const ENHANCE_MAX_LEVEL = 15;
export const REFINE_MAX_LEVEL = 10;

const ENHANCE_SUCCESS_RATE_PERCENT: Record<number, number> = {
  1: 1,
  2: 1,
  3: 1,
  4: 1,
  5: 1,
  6: 0.8,
  7: 0.7,
  8: 0.6,
  9: 0.5,
  10: 0.4,
  11: 0.35,
  12: 0.3,
  13: 0.25,
  14: 0.2,
  15: 0.15,
};

const REFINE_SUCCESS_RATE_PERCENT: Record<number, number> = {
  1: 1,
  2: 1,
  3: 1,
  4: 0.9,
  5: 0.8,
  6: 0.7,
  7: 0.6,
  8: 0.5,
  9: 0.4,
  10: 0.3,
};

const GEM_TYPE_SYNONYMS: Record<string, string> = {
  all: "all",
  any: "all",
  universal: "all",
  "*": "all",

  atk: "attack",
  attack: "attack",
  gongji: "attack",
  offense: "attack",

  def: "defense",
  defense: "defense",
  fangyu: "defense",

  hp: "survival",
  life: "survival",
  survival: "survival",
  shengming: "survival",

  util: "utility",
  utility: "utility",
  support: "utility",
};

const GEM_SUB_CATEGORY_TO_TYPE: Record<string, string> = {
  gem_attack: "attack",
  gem_defense: "defense",
  gem_survival: "survival",
  gem_all: "all",
};

const ATTACK_ATTR_KEYS = new Set([
  "wugong",
  "fagong",
  "mingzhong",
  "baoji",
  "baoshang",
  "zengshang",
]);

const DEFENSE_ATTR_KEYS = new Set([
  "wufang",
  "fafang",
  "shanbi",
  "zhaojia",
  "kangbao",
  "jianliao",
  "kongzhi_kangxing",
  "jin_kangxing",
  "mu_kangxing",
  "shui_kangxing",
  "huo_kangxing",
  "tu_kangxing",
]);

const SURVIVAL_ATTR_KEYS = new Set([
  "qixue",
  "max_qixue",
  "lingqi",
  "max_lingqi",
  "zhiliao",
  "xixue",
  "qixue_huifu",
  "lingqi_huifu",
]);

const RATIO_ATTR_KEYS = new Set([
  "shuxing_shuzhi",
  "mingzhong",
  "shanbi",
  "zhaojia",
  "baoji",
  "baoshang",
  "kangbao",
  "zengshang",
  "zhiliao",
  "jianliao",
  "xixue",
  "lengque",
  "kongzhi_kangxing",
  "jin_kangxing",
  "mu_kangxing",
  "shui_kangxing",
  "huo_kangxing",
  "tu_kangxing",
]);

export const clampInt = (value: number, min: number, max: number): number => {
  const n = Number(value);
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, Math.floor(n)));
};

const toNumber = (value: unknown): number => {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : 0;
};

const toObject = (value: unknown): Record<string, unknown> => {
  if (!value) return {};
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown;
      return toObject(parsed);
    } catch {
      return {};
    }
  }
  if (typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
};

const toArray = (value: unknown): unknown[] => {
  if (!value) return [];
  if (Array.isArray(value)) return value;
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown;
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
};

export const normalizeGemType = (value: unknown): string => {
  const raw = String(value || "")
    .trim()
    .toLowerCase();
  if (!raw) return "all";
  return GEM_TYPE_SYNONYMS[raw] ?? raw;
};

export const getQualityMultiplier = (rank: number): number => {
  return QUALITY_MULTIPLIER_BY_RANK[clampInt(rank, 1, 99)] ?? 1;
};

export const getStrengthenMultiplier = (strengthenLevel: number): number => {
  const level = clampInt(strengthenLevel, 0, ENHANCE_MAX_LEVEL);
  return 1 + level * 0.03;
};

export const getRefineMultiplier = (refineLevel: number): number => {
  const level = clampInt(refineLevel, 0, REFINE_MAX_LEVEL);
  return 1 + level * 0.02;
};

export const getEnhanceSuccessRatePercent = (targetLevel: number): number => {
  const level = clampInt(targetLevel, 1, ENHANCE_MAX_LEVEL);
  const value = ENHANCE_SUCCESS_RATE_PERCENT[level] ?? 0;
  return Math.max(0, Math.min(1, value));
};

export const getRefineSuccessRatePercent = (targetLevel: number): number => {
  const level = clampInt(targetLevel, 1, REFINE_MAX_LEVEL);
  const value = REFINE_SUCCESS_RATE_PERCENT[level] ?? 0;
  return Math.max(0, Math.min(1, value));
};

export const getEnhanceFailResultLevel = (
  currentLevel: number,
  targetLevel: number,
): number => {
  const current = clampInt(currentLevel, 0, ENHANCE_MAX_LEVEL);
  const target = clampInt(targetLevel, 1, ENHANCE_MAX_LEVEL);
  if (target >= 8) return Math.max(0, current - 1);
  return current;
};

export const getRefineFailResultLevel = (
  currentLevel: number,
  targetLevel: number,
): number => {
  const current = clampInt(currentLevel, 0, REFINE_MAX_LEVEL);
  const target = clampInt(targetLevel, 1, REFINE_MAX_LEVEL);
  if (target >= 6) return Math.max(0, current - 1);
  return current;
};

export interface GrowthCostPlan {
  materialItemDefId: string;
  materialQty: number;
  silverCost: number;
  spiritStoneCost: number;
}

export const buildEnhanceCostPlan = (
  targetLevel: number,
  equipReqRealm: number,
): GrowthCostPlan => {
  const target = clampInt(targetLevel, 1, ENHANCE_MAX_LEVEL);
  const realmMultiplier = Math.max(1, clampInt(equipReqRealm, 1, 99));
  return {
    materialItemDefId: target <= 10 ? "enhance-001" : "enhance-002",
    materialQty: target * realmMultiplier,
    silverCost: Math.max(100, Math.floor(125 * target * realmMultiplier)),
    spiritStoneCost: Math.max(0, 25 * target * realmMultiplier),
  };
};

export const buildRefineCostPlan = (
  targetLevel: number,
  equipReqRealm: number,
): GrowthCostPlan => {
  const target = clampInt(targetLevel, 1, REFINE_MAX_LEVEL);
  const realmMultiplier = Math.max(1, clampInt(equipReqRealm, 1, 99));
  return {
    materialItemDefId: "enhance-002",
    materialQty: target * realmMultiplier,
    silverCost: Math.max(100, Math.floor(125 * target * realmMultiplier)),
    spiritStoneCost: Math.max(0, 25 * target * realmMultiplier),
  };
};

export const scaleNumberRecord = (
  record: Record<string, unknown>,
  factor: number,
): CharacterAttrRecord => {
  const out: CharacterAttrRecord = {};
  const mul = Number.isFinite(factor) ? factor : 1;
  for (const [k, v] of Object.entries(record)) {
    const n = toNumber(v);
    if (!Number.isFinite(n)) continue;
    const scaled = mul !== 1 ? n * mul : n;
    out[k] = RATIO_ATTR_KEYS.has(k)
      ? Number(scaled.toFixed(6))
      : Math.round(scaled);
  }
  return out;
};

export const mergeNumberRecord = (
  base: Record<string, number>,
  extra: Record<string, number>,
): CharacterAttrRecord => {
  const out: CharacterAttrRecord = { ...base };
  for (const [k, v] of Object.entries(extra)) {
    const n = toNumber(v);
    if (!Number.isFinite(n) || n === 0) continue;
    out[k] = (out[k] ?? 0) + n;
  }
  return out;
};

export const parseSocketEffectsFromItemEffectDefs = (
  effectDefsRaw: unknown,
): SocketEffect[] => {
  const effects: SocketEffect[] = [];
  const defs = toArray(effectDefsRaw);
  for (const raw of defs) {
    const effect = toObject(raw);
    if (String(effect.trigger || "") !== "socket") continue;
    if (String(effect.effect_type || "") !== "buff") continue;
    const params = toObject(effect.params);
    const attrKey = String(params.attr_key || "").trim();
    const value = toNumber(params.value);
    const applyType = String(params.apply_type || "flat")
      .trim()
      .toLowerCase();
    if (!attrKey) continue;
    if (!Number.isFinite(value) || value === 0) continue;
    const normalizedApplyType: SocketApplyType =
      applyType === "percent"
        ? "percent"
        : applyType === "special"
          ? "special"
          : "flat";
    effects.push({ attrKey, value, applyType: normalizedApplyType });
  }
  return effects;
};

export const inferGemTypeFromEffects = (effects: SocketEffect[]): string => {
  let hasAttack = false;
  let hasDefense = false;
  let hasSurvival = false;
  for (const effect of effects) {
    const key = String(effect.attrKey || "").trim();
    if (!key) continue;
    if (ATTACK_ATTR_KEYS.has(key)) hasAttack = true;
    else if (DEFENSE_ATTR_KEYS.has(key)) hasDefense = true;
    else if (SURVIVAL_ATTR_KEYS.has(key)) hasSurvival = true;
  }

  const count = Number(hasAttack) + Number(hasDefense) + Number(hasSurvival);
  if (count === 0) return "utility";
  if (count >= 2) return "all";
  if (hasAttack) return "attack";
  if (hasDefense) return "defense";
  return "survival";
};

interface DynamicSocketGemMeta {
  effects: SocketEffect[];
  gemType: string;
  name?: string;
  icon?: string;
}

const resolveSocketGemMetaFromItemDef = (
  itemDefId: string,
): DynamicSocketGemMeta | null => {
  const itemDef = getItemDefinitionById(itemDefId);
  if (!itemDef) return null;
  if (
    String(itemDef.category || "")
      .trim()
      .toLowerCase() !== "gem"
  )
    return null;

  const effects = parseSocketEffectsFromItemEffectDefs(itemDef.effect_defs);
  const subCategory = String(itemDef.sub_category || "")
    .trim()
    .toLowerCase();
  const gemTypeBySubCategory = GEM_SUB_CATEGORY_TO_TYPE[subCategory];
  const inferredGemType =
    effects.length > 0 ? inferGemTypeFromEffects(effects) : "all";
  const gemType = normalizeGemType(
    gemTypeBySubCategory || inferredGemType || "all",
  );
  const name =
    typeof itemDef.name === "string" && itemDef.name.trim()
      ? itemDef.name.trim()
      : undefined;
  const icon =
    typeof itemDef.icon === "string" && itemDef.icon.trim()
      ? itemDef.icon.trim()
      : undefined;
  return { effects, gemType, name, icon };
};

const parseSocketEntry = (raw: unknown): SocketedGemEntry | null => {
  const src = toObject(raw);
  const slot = clampInt(toNumber(src.slot), 0, 999);
  const itemDefId = String(src.itemDefId || src.item_def_id || "").trim();
  if (!itemDefId) return null;

  // 只按静态定义动态解析宝石效果，不回退历史快照 effects。
  const dynamicMeta = resolveSocketGemMetaFromItemDef(itemDefId);
  if (!dynamicMeta || dynamicMeta.effects.length === 0) return null;
  const effects: SocketEffect[] = dynamicMeta.effects.map((effect) => ({
    ...effect,
  }));
  const gemType = normalizeGemType(dynamicMeta.gemType);
  const name = dynamicMeta.name;
  const icon = dynamicMeta.icon;

  return { slot, itemDefId, gemType, effects, name, icon };
};

export const parseSocketedGems = (raw: unknown): SocketedGemEntry[] => {
  const arr = toArray(raw);
  const dedupBySlot = new Map<number, SocketedGemEntry>();
  for (const item of arr) {
    const parsed = parseSocketEntry(item);
    if (!parsed) continue;
    dedupBySlot.set(parsed.slot, parsed);
  }
  return [...dedupBySlot.values()].sort((a, b) => a.slot - b.slot);
};

export const buildSocketFlatAttrDelta = (
  socketedGemsRaw: unknown,
): CharacterAttrRecord => {
  const delta: CharacterAttrRecord = {};
  const gems = parseSocketedGems(socketedGemsRaw);
  for (const gem of gems) {
    for (const effect of gem.effects) {
      if (effect.applyType !== "flat") continue;
      delta[effect.attrKey] = (delta[effect.attrKey] ?? 0) + effect.value;
    }
  }
  return delta;
};

export const resolveSocketMax = (
  socketMaxRaw: unknown,
  resolvedQualityRankRaw: unknown,
): number => {
  const configured = clampInt(toNumber(socketMaxRaw), 0, 12);
  if (configured > 0) return configured;
  const rank = clampInt(toNumber(resolvedQualityRankRaw), 1, 4);
  return DEFAULT_SOCKET_MAX_BY_QUALITY_RANK[rank] ?? 1;
};

const parseSlotAllowedGemTypes = (
  gemSlotTypesRaw: unknown,
  slot: number,
): string[] | null => {
  const rootArray = toArray(gemSlotTypesRaw);
  if (rootArray.length === 0) return null;

  const slotBased = rootArray[slot];
  if (Array.isArray(slotBased)) {
    const normalized = slotBased
      .map((v) => normalizeGemType(v))
      .filter((v) => !!v);
    return normalized.length > 0 ? normalized : null;
  }

  const allAsString = rootArray.every((v) => typeof v === "string");
  if (allAsString) {
    const normalized = rootArray
      .map((v) => normalizeGemType(v))
      .filter((v) => !!v);
    return normalized.length > 0 ? normalized : null;
  }

  const rootObj = toObject(gemSlotTypesRaw);
  if (Object.keys(rootObj).length > 0) {
    const exact = rootObj[String(slot)];
    if (Array.isArray(exact)) {
      const normalized = exact
        .map((v) => normalizeGemType(v))
        .filter((v) => !!v);
      if (normalized.length > 0) return normalized;
    }
    if (Array.isArray(rootObj.default)) {
      const normalized = (rootObj.default as unknown[])
        .map((v) => normalizeGemType(v))
        .filter((v) => !!v);
      if (normalized.length > 0) return normalized;
    }
  }

  return null;
};

export const isGemTypeAllowedInSlot = (
  gemSlotTypesRaw: unknown,
  slot: number,
  gemTypeRaw: unknown,
): boolean => {
  const allowed = parseSlotAllowedGemTypes(gemSlotTypesRaw, slot);
  if (!allowed || allowed.length === 0) return true;
  const normalizedGemType = normalizeGemType(gemTypeRaw);
  if (!normalizedGemType) return false;
  if (allowed.includes("all")) return true;
  if (normalizedGemType === "all") return true;
  return allowed.includes(normalizedGemType);
};

export const buildEquipmentDisplayBaseAttrs = (params: {
  baseAttrsRaw: unknown;
  defQualityRankRaw: unknown;
  resolvedQualityRankRaw: unknown;
  strengthenLevelRaw: unknown;
  refineLevelRaw: unknown;
  socketedGemsRaw: unknown;
}): CharacterAttrRecord => {
  const baseAttrs = toObject(params.baseAttrsRaw);
  const defQualityRank = Math.max(
    1,
    clampInt(toNumber(params.defQualityRankRaw), 1, 99),
  );
  const resolvedQualityRank = Math.max(
    1,
    clampInt(toNumber(params.resolvedQualityRankRaw), 1, 99),
  );
  const strengthenLevel = clampInt(
    toNumber(params.strengthenLevelRaw),
    0,
    ENHANCE_MAX_LEVEL,
  );
  const refineLevel = clampInt(
    toNumber(params.refineLevelRaw),
    0,
    REFINE_MAX_LEVEL,
  );

  const qualityFactor =
    getQualityMultiplier(resolvedQualityRank) /
    getQualityMultiplier(defQualityRank);
  const growthFactor =
    getStrengthenMultiplier(strengthenLevel) * getRefineMultiplier(refineLevel);
  const scaled = scaleNumberRecord(baseAttrs, qualityFactor * growthFactor);
  const socketDelta = buildSocketFlatAttrDelta(params.socketedGemsRaw);
  return mergeNumberRecord(scaled, socketDelta);
};
