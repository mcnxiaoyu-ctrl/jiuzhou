/**
 * 宗门建筑配置与效果模块
 *
 * 作用：
 * 1. 统一维护可升级建筑的名称、升级成本曲线与等级上限。
 * 2. 统一维护铁匠铺对强化/精炼费用的折扣规则与查询入口。
 * 不做：
 * 1. 不处理路由参数校验。
 * 2. 不处理宗门权限、资金扣减与建筑升级事务。
 *
 * 输入 / 输出：
 * - 输入：建筑类型、建筑等级、角色 ID。
 * - 输出：建筑配置、建筑展示名、铁匠铺等级折扣、角色所在宗门铁匠铺等级。
 *
 * 数据流 / 状态流：
 * - 建筑升级链路：buildingType -> 建筑配置 -> 升级成本/上限。
 * - 装备成长链路：characterId -> sect_member/sect_building -> 铁匠铺等级 -> 强化/精炼折扣率。
 *
 * 复用设计说明：
 * - 把“哪些建筑可升级”“每级怎么收费”“铁匠铺怎么折扣”集中在这里，避免路由、宗门服务、装备服务各写一套条件分支。
 * - 被 `sect/buildingRequirement.ts`、`sect/buildings.ts`、`inventory/shared/equipmentGrowthCost.ts`、`sect/bonuses.ts` 复用。
 * - 建筑效果与升级规则属于高频业务变化点，收口后后续调整不会散落到多处。
 *
 * 关键边界条件与坑点：
 * 1. 铁匠铺折扣按建筑等级线性增长，但必须强制钳制在 0~50 级范围内，避免脏数据把折扣抬高。
 * 2. 角色未加入宗门或宗门没有铁匠铺记录时，折扣严格为 0，不在其他模块再加额外分支。
 */
import { query } from "../../config/database.js";

export interface SectBuildingUpgradeCost {
  funds: number;
  buildPoints: number;
}

export interface SectBuildingUpgradeConfig {
  name: string;
  maxLevel: number;
  getUpgradeCost: (currentLevel: number) => SectBuildingUpgradeCost;
}

export const SECT_BUILDING_MAX_LEVEL = 50;
export const HALL_BUILDING_TYPE = "hall";
export const FORGE_HOUSE_BUILDING_TYPE = "forge_house";

type UpgradableSectBuildingType =
  | typeof HALL_BUILDING_TYPE
  | typeof FORGE_HOUSE_BUILDING_TYPE;

const FORGE_HOUSE_COST_DISCOUNT_PER_LEVEL = 0.005;
const FORGE_HOUSE_MAX_COST_DISCOUNT =
  SECT_BUILDING_MAX_LEVEL * FORGE_HOUSE_COST_DISCOUNT_PER_LEVEL;

const buildQuadraticUpgradeCost = (
  currentLevel: number,
): SectBuildingUpgradeCost => {
  const nextLevel = Math.max(1, Math.floor(currentLevel) + 1);
  return {
    funds: Math.floor(1200 * nextLevel * nextLevel),
    buildPoints: Math.floor(10 * nextLevel),
  };
};

const BUILDING_UPGRADE_CONFIG_MAP: Record<
  UpgradableSectBuildingType,
  SectBuildingUpgradeConfig
> = {
  [HALL_BUILDING_TYPE]: {
    name: "宗门大殿",
    maxLevel: SECT_BUILDING_MAX_LEVEL,
    getUpgradeCost: buildQuadraticUpgradeCost,
  },
  [FORGE_HOUSE_BUILDING_TYPE]: {
    name: "铁匠铺",
    maxLevel: SECT_BUILDING_MAX_LEVEL,
    getUpgradeCost: buildQuadraticUpgradeCost,
  },
};

export const clampSectBuildingLevel = (level: number): number => {
  if (!Number.isFinite(level)) return 0;
  return Math.max(0, Math.min(SECT_BUILDING_MAX_LEVEL, Math.floor(level)));
};

export const getSectBuildingUpgradeConfig = (
  buildingType: string,
): SectBuildingUpgradeConfig | null => {
  if (buildingType === HALL_BUILDING_TYPE) {
    return BUILDING_UPGRADE_CONFIG_MAP[HALL_BUILDING_TYPE];
  }
  if (buildingType === FORGE_HOUSE_BUILDING_TYPE) {
    return BUILDING_UPGRADE_CONFIG_MAP[FORGE_HOUSE_BUILDING_TYPE];
  }
  return null;
};

export const getSectBuildingDisplayName = (buildingType: string): string => {
  return getSectBuildingUpgradeConfig(buildingType)?.name ?? buildingType;
};

export const getForgeHouseEquipmentCostDiscountRate = (
  forgeHouseLevel: number,
): number => {
  const level = clampSectBuildingLevel(forgeHouseLevel);
  return Math.max(
    0,
    Math.min(
      FORGE_HOUSE_MAX_COST_DISCOUNT,
      level * FORGE_HOUSE_COST_DISCOUNT_PER_LEVEL,
    ),
  );
};

export const getForgeHouseLevelByCharacterId = async (
  characterId: number,
): Promise<number> => {
  const result = await query(
    `
      SELECT sb.level
      FROM sect_member sm
      INNER JOIN sect_building sb
        ON sb.sect_id = sm.sect_id
       AND sb.building_type = $2
      WHERE sm.character_id = $1
      LIMIT 1
    `,
    [characterId, FORGE_HOUSE_BUILDING_TYPE],
  );

  if (result.rows.length === 0) {
    return 0;
  }

  return clampSectBuildingLevel(Number(result.rows[0].level));
};
