/**
 * 分解奖励规划器
 *
 * 作用：
 * - 统一计算“单个物品在指定数量下”的分解奖励
 * - 保留特殊分解（装备、功法书），其余走默认银两公式
 *
 * 输入：
 * - 物品分类、子分类、效果定义、品质、成长参数、分解数量
 *
 * 输出：
 * - rewards.silver：银两奖励
 * - rewards.items：物品奖励（不含实例ID，实例ID由调用方在入包后补充）
 */
import {
  calculateDefaultDisassembleSilver,
  clampQualityRank,
  resolveDisassembleRewardItemDefIdByQualityRank,
  resolveTechniqueBookDisassembleRewardByQualityRank,
} from './equipmentDisassembleRules.js';

export type DisassembleItemRewardPlan = {
  itemDefId: string;
  qty: number;
};

export type DisassembleRewardsPlan = {
  silver: number;
  items: DisassembleItemRewardPlan[];
};

export type DisassembleRewardPlanInput = {
  category: string;
  subCategory: string | null;
  effectDefs: unknown;
  qualityRankRaw: unknown;
  strengthenLevelRaw?: unknown;
  refineLevelRaw?: unknown;
  affixesRaw?: unknown;
  qty: number;
};

const clampInt = (value: unknown, min: number, max: number): number => {
  const n = Number(value);
  if (!Number.isFinite(n)) return min;
  const floored = Math.floor(n);
  if (floored < min) return min;
  if (floored > max) return max;
  return floored;
};

export const hasLearnTechniqueEffect = (effectDefs: unknown): boolean => {
  if (!Array.isArray(effectDefs)) return false;
  return effectDefs.some((raw) => {
    if (!raw || typeof raw !== 'object') return false;
    const row = raw as { effect_type?: unknown };
    return String(row.effect_type || '') === 'learn_technique';
  });
};

export const isTechniqueBookItem = (item: { subCategory: string | null; effectDefs: unknown }): boolean => {
  const subCategory = String(item.subCategory || '').trim();
  if (subCategory === 'technique_book') return true;
  return hasLearnTechniqueEffect(item.effectDefs);
};

const resolveAffixCount = (affixesRaw: unknown): number => {
  let source = affixesRaw;
  if (typeof source === 'string') {
    try {
      source = JSON.parse(source) as unknown;
    } catch {
      return 0;
    }
  }
  if (!Array.isArray(source)) return 0;
  return source.length;
};

export const buildDisassembleRewardPlan = (
  params: DisassembleRewardPlanInput
): { success: boolean; message: string; rewards: DisassembleRewardsPlan } => {
  const qty = clampInt(params.qty, 1, 999999);
  const qualityRank = clampQualityRank(params.qualityRankRaw, 1);
  const rewards: DisassembleRewardsPlan = { silver: 0, items: [] };

  if (params.category === 'equipment') {
    const rewardItemDefId = resolveDisassembleRewardItemDefIdByQualityRank(qualityRank);
    if (!rewardItemDefId) {
      return { success: false, message: '装备品质异常', rewards };
    }
    rewards.items.push({ itemDefId: rewardItemDefId, qty });
    return { success: true, message: 'ok', rewards };
  }

  const isTechniqueBook = isTechniqueBookItem({
    subCategory: params.subCategory,
    effectDefs: params.effectDefs,
  });
  if (isTechniqueBook) {
    const reward = resolveTechniqueBookDisassembleRewardByQualityRank(qualityRank);
    if (!reward) {
      return { success: false, message: '功法书品质异常', rewards };
    }
    rewards.items.push({ itemDefId: reward.itemDefId, qty: reward.qty * qty });
    return { success: true, message: 'ok', rewards };
  }

  const affixCount = resolveAffixCount(params.affixesRaw);
  const silverResult = calculateDefaultDisassembleSilver({
    qualityRank,
    strengthenLevel: Number(params.strengthenLevelRaw) || 0,
    refineLevel: Number(params.refineLevelRaw) || 0,
    affixCount,
    qty,
  });
  rewards.silver = silverResult.totalSilver;
  return { success: true, message: 'ok', rewards };
};
