/**
 * 装备强化/精炼费用模块
 *
 * 作用：
 * 1. 统一构建强化、精炼的基础费用。
 * 2. 统一叠加宗门铁匠铺的费用折扣，确保预览与实际扣费使用同一口径。
 * 不做：
 * 1. 不处理强化/精炼成功率与等级变化。
 * 2. 不处理材料/货币扣减事务。
 *
 * 输入 / 输出：
 * - 输入：角色 ID、成长模式、目标等级、装备需求境界档位。
 * - 输出：折后费用方案，以及当前角色宗门铁匠铺折扣上下文。
 *
 * 数据流 / 状态流：
 * - 角色 ID -> 宗门铁匠铺等级 -> 折扣率。
 * - 成长模式 + 目标等级 + 装备境界 -> 基础费用 -> 折扣率 -> 折后费用。
 *
 * 复用设计说明：
 * - 强化执行、精炼执行、成长预览都会用到同一套费用口径，集中在这里后能避免三处分别算折扣。
 * - 被 `inventory/equipment.ts` 复用，后续若出现批量强化或其他展示入口，也直接复用这里。
 * - 折扣规则属于高频业务变化点，收口后只需改一处。
 *
 * 关键边界条件与坑点：
 * 1. 材料数量折扣后仍必须至少保留 1，避免正成本被折成 0 导致白嫖。
 * 2. 折扣只影响强化/精炼，不影响洗炼、镶嵌等其他装备成长链路。
 */
import {
  buildEnhanceCostPlan,
  buildRefineCostPlan,
  type GrowthCostPlan,
} from "../../equipmentGrowthRules.js";
import {
  getForgeHouseEquipmentCostDiscountRate,
  getForgeHouseLevelByCharacterId,
} from "../../sect/buildingConfig.js";

export type EquipmentGrowthMode = "enhance" | "refine";

export interface SectEquipmentGrowthDiscountContext {
  forgeHouseLevel: number;
  discountRate: number;
}

export const applyEquipmentGrowthCostDiscount = (
  basePlan: GrowthCostPlan,
  discountRate: number,
): GrowthCostPlan => {
  const normalizedRate = Math.max(0, Math.min(1, discountRate));
  const multiplier = 1 - normalizedRate;

  return {
    materialItemDefId: basePlan.materialItemDefId,
    materialQty:
      basePlan.materialQty <= 0
        ? 0
        : Math.max(1, Math.floor(basePlan.materialQty * multiplier)),
    silverCost: Math.max(0, Math.floor(basePlan.silverCost * multiplier)),
    spiritStoneCost: Math.max(
      0,
      Math.floor(basePlan.spiritStoneCost * multiplier),
    ),
  };
};

export const getSectEquipmentGrowthDiscountContext = async (
  characterId: number,
): Promise<SectEquipmentGrowthDiscountContext> => {
  const forgeHouseLevel = await getForgeHouseLevelByCharacterId(characterId);
  return {
    forgeHouseLevel,
    discountRate: getForgeHouseEquipmentCostDiscountRate(forgeHouseLevel),
  };
};

export const buildDiscountedEquipmentGrowthCostPlan = (
  mode: EquipmentGrowthMode,
  targetLevel: number,
  equipReqRealmRank: number,
  discountRate: number,
): GrowthCostPlan => {
  const basePlan =
    mode === "enhance"
      ? buildEnhanceCostPlan(targetLevel, equipReqRealmRank)
      : buildRefineCostPlan(targetLevel, equipReqRealmRank);
  return applyEquipmentGrowthCostDiscount(basePlan, discountRate);
};
