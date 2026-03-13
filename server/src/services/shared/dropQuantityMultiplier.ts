/**
 * 掉落数量倍率规则（战斗结算 + UI 预览共用）
 *
 * 作用：
 * 1. 统一“哪些物品允许吃掉落数量倍率”的判定规则
 * 2. 统一“怪物境界数量倍率”的应用方式
 * 3. 统一“最小/最大数量随怪物境界步进增长”的配置解释
 * 4. 给展示层提供与结算层一致的数量区间计算，避免前后端观感不一致
 *
 * 输入：
 * - itemDefId：物品定义 ID
 * - qtyMin/qtyMax：基础数量区间
 * - sourceType/sourcePoolId：掉落条目来源（专属池/通用池）
 * - dropMultiplierOptions：掉落倍率场景（秘境/世界、普通/精英/BOSS）
 * - qtyMinAddByMonsterRealm/qtyMaxAddByMonsterRealm：数量区间随怪物境界的步进增量
 * - qtyMultiplyByMonsterRealm：条目上的怪物境界数量倍率
 *
 * 输出：
 * - 经过同一套规则计算后的数量区间（qtyMin/qtyMax）
 */
import { getItemDefinitionById } from '../staticConfigLoader.js';
import {
  getAdjustedQuantity,
  type DropEntrySourceType,
  type DropMultiplierContext,
} from './dropRateMultiplier.js';
import {
  getRealmRankOneBasedStrict,
  getRealmRankZeroBased,
} from './realmRules.js';

const dropQtyMultiplierEligibilityCache = new Map<string, boolean>();

const hasLearnTechniqueEffect = (effectDefs: unknown): boolean => {
  if (!Array.isArray(effectDefs)) return false;
  return effectDefs.some((raw) => {
    if (!raw || typeof raw !== 'object') return false;
    const effectType = (raw as { effect_type?: unknown }).effect_type;
    return String(effectType || '').trim().toLowerCase() === 'learn_technique';
  });
};

/**
 * 数量倍率仅作用于“非装备、非功法类”物品：
 * 1. 排除装备（category=equipment）
 * 2. 排除功法材料/功法书（sub_category=technique / technique_book）
 * 3. 排除带 learn_technique 效果的道具（覆盖特殊功法书）
 */
export const shouldApplyDropQuantityMultiplier = (itemDefId: string): boolean => {
  const cached = dropQtyMultiplierEligibilityCache.get(itemDefId);
  if (typeof cached === 'boolean') return cached;

  const def = getItemDefinitionById(itemDefId);
  const category = String(def?.category || '').trim().toLowerCase();
  const subCategory = String(def?.sub_category || '').trim().toLowerCase();
  const isTechniqueLike =
    subCategory === 'technique' ||
    subCategory === 'technique_book' ||
    hasLearnTechniqueEffect(def?.effect_defs);
  const shouldApply = category !== 'equipment' && !isTechniqueLike;

  dropQtyMultiplierEligibilityCache.set(itemDefId, shouldApply);
  return shouldApply;
};

export const applyMonsterRealmDropQtyMultiplier = (
  baseQuantity: number,
  multiplierRaw: number,
  monsterRealmRaw?: string | null,
): number => {
  const multiplier = Number(multiplierRaw);
  const safeBase = Math.max(1, Math.floor(Number(baseQuantity) || 1));
  if (!Number.isFinite(multiplier) || multiplier <= 0) return safeBase;
  if (multiplier === 1) return safeBase;
  if (multiplier < 1) return Math.max(1, Math.floor(safeBase * multiplier));
  // 规则：
  // 1. 凡人（1阶）沿用原倍率（例如配置 2 => ×2）
  // 2. 更高境界每升 1 阶，额外叠加一次 (multiplier - 1)
  // 例如：炼己期（第 5 阶）且配置 2 => 1 + (2 - 1) * 5 = ×6
  const realmRank = Math.max(1, getRealmRankOneBasedStrict(monsterRealmRaw));
  const effectiveMultiplier = 1 + (multiplier - 1) * realmRank;
  return Math.max(1, Math.floor(safeBase * effectiveMultiplier));
};

/**
 * 统一解释“数量区间随怪物境界步进增长”的配置：
 * 1. 允许使用小数步进，例如 0.5 表示每跨 2 个境界累计 +1
 * 2. 只在最终数量区间落地时取整，避免入口层提前截断导致配置失效
 * 3. 若 max 步进小于 min，统一按 min 对齐，保证区间始终合法
 */
export const normalizeMonsterRealmQuantityStepRange = (params: {
  qtyMinAddByMonsterRealm?: number;
  qtyMaxAddByMonsterRealm?: number;
}): { qtyMinAddByMonsterRealm: number; qtyMaxAddByMonsterRealm: number } => {
  const qtyMinAddByMonsterRealmRaw = Number(params.qtyMinAddByMonsterRealm);
  const qtyMinAddByMonsterRealm =
    Number.isFinite(qtyMinAddByMonsterRealmRaw) && qtyMinAddByMonsterRealmRaw >= 0
      ? qtyMinAddByMonsterRealmRaw
      : 0;
  const qtyMaxAddByMonsterRealmRaw = Number(params.qtyMaxAddByMonsterRealm);
  const qtyMaxAddByMonsterRealmCandidate =
    Number.isFinite(qtyMaxAddByMonsterRealmRaw) && qtyMaxAddByMonsterRealmRaw >= 0
      ? qtyMaxAddByMonsterRealmRaw
      : qtyMinAddByMonsterRealm;

  return {
    qtyMinAddByMonsterRealm,
    qtyMaxAddByMonsterRealm: Math.max(
      qtyMinAddByMonsterRealm,
      qtyMaxAddByMonsterRealmCandidate,
    ),
  };
};

/**
 * 解释掉落条目上的“数量区间随怪物境界步进增长”配置。
 * - 凡人（0阶追加）保持原始区间
 * - 每升 1 阶，分别给 qtyMin/qtyMax 累加一次对应增量
 * - 允许小数步进，先累计再在最终数量上取整
 * - 若 max 的步进配置小于 min，统一按 min 对齐，保证最终区间合法
 */
export const getMonsterRealmAdjustedBaseQuantityRange = (params: {
  qtyMin: number;
  qtyMax: number;
  qtyMinAddByMonsterRealm?: number;
  qtyMaxAddByMonsterRealm?: number;
  monsterRealm?: string | null;
}): { qtyMin: number; qtyMax: number } => {
  const baseMin = Math.max(1, Math.floor(Number(params.qtyMin) || 1));
  const baseMax = Math.max(baseMin, Math.floor(Number(params.qtyMax) || baseMin));
  const realmRank = Math.max(0, getRealmRankZeroBased(params.monsterRealm));
  const { qtyMinAddByMonsterRealm, qtyMaxAddByMonsterRealm } =
    normalizeMonsterRealmQuantityStepRange({
      qtyMinAddByMonsterRealm: params.qtyMinAddByMonsterRealm,
      qtyMaxAddByMonsterRealm: params.qtyMaxAddByMonsterRealm,
    });

  const adjustedMin = Math.max(1, Math.floor(baseMin + realmRank * qtyMinAddByMonsterRealm));
  const adjustedMax = Math.max(adjustedMin, Math.floor(baseMax + realmRank * qtyMaxAddByMonsterRealm));

  return {
    qtyMin: adjustedMin,
    qtyMax: Math.max(adjustedMin, adjustedMax),
  };
};

export const getAdjustedDropQuantityRange = (params: {
  itemDefId: string;
  qtyMin: number;
  qtyMax: number;
  qtyMinAddByMonsterRealm?: number;
  qtyMaxAddByMonsterRealm?: number;
  sourceType: DropEntrySourceType;
  sourcePoolId: string;
  dropMultiplierOptions?: DropMultiplierContext;
  qtyMultiplyByMonsterRealm?: number;
  monsterRealm?: string | null;
}): { qtyMin: number; qtyMax: number } => {
  const baseQuantityRange = getMonsterRealmAdjustedBaseQuantityRange({
    qtyMin: params.qtyMin,
    qtyMax: params.qtyMax,
    qtyMinAddByMonsterRealm: params.qtyMinAddByMonsterRealm,
    qtyMaxAddByMonsterRealm: params.qtyMaxAddByMonsterRealm,
    monsterRealm: params.monsterRealm,
  });
  const shouldApplyMultiplier = shouldApplyDropQuantityMultiplier(params.itemDefId);
  const qtyMultiplyByMonsterRealm = Number(params.qtyMultiplyByMonsterRealm ?? 1);

  const adjustedMin = applyMonsterRealmDropQtyMultiplier(
    getAdjustedQuantity(
      baseQuantityRange.qtyMin,
      params.sourceType,
      params.sourcePoolId,
      params.dropMultiplierOptions,
      shouldApplyMultiplier,
    ),
    qtyMultiplyByMonsterRealm,
    params.monsterRealm,
  );
  const adjustedMax = applyMonsterRealmDropQtyMultiplier(
    getAdjustedQuantity(
      baseQuantityRange.qtyMax,
      params.sourceType,
      params.sourcePoolId,
      params.dropMultiplierOptions,
      shouldApplyMultiplier,
    ),
    qtyMultiplyByMonsterRealm,
    params.monsterRealm,
  );

  return {
    qtyMin: adjustedMin,
    qtyMax: Math.max(adjustedMin, adjustedMax),
  };
};
