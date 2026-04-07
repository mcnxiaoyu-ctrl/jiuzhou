import { query } from "../../config/database.js";
import { Transactional } from "../../decorators/transactional.js";
import { assertMember, hasPermission, toNumber } from "./db.js";
import {
  buildingUpgradeConstants,
  getBuildingUpgradeRequirement,
  withBuildingRequirement,
} from "./buildingRequirement.js";
import { invalidateSectInfoCache } from "./cache.js";
import {
  getSectBuildingDisplayName,
  getSectBuildingUpgradeConfig,
  HALL_BUILDING_TYPE,
} from "./buildingConfig.js";
import { ensureSectDefaultBuildings } from "./defaultBuildings.js";
import type {
  Result,
  SectBuildingRow,
  SectBuildingView,
} from "./types.js";

const { FULLY_UPGRADED_MESSAGE, UPGRADE_CLOSED_MESSAGE } =
  buildingUpgradeConstants;

/**
 * 宗门建筑服务
 *
 * 作用：处理宗门建筑查询与升级逻辑
 * 不做：不处理路由层参数校验、不做权限判断（权限在方法内部判断）
 *
 * 数据流：
 * - getBuildings：读取 sect_building 表，计算升级需求
 * - upgradeBuilding：在事务中扣除资金与建设点，升级建筑，更新成员上限
 *
 * 边界条件：
 * 1) upgradeBuilding 使用 @Transactional 保证资金扣除与建筑升级的原子性
 * 2) getBuildings 为纯读方法，不需要事务
 */
class SectBuildingService {
  async getBuildings(
    characterId: number,
  ): Promise<{ success: boolean; message: string; data?: SectBuildingView[] }> {
    const member = await assertMember(characterId);
    await ensureSectDefaultBuildings(member.sectId);
    const res = await query(
      "SELECT * FROM sect_building WHERE sect_id = $1 ORDER BY building_type",
      [member.sectId],
    );
    return {
      success: true,
      message: "ok",
      data: res.rows.map((row) =>
        withBuildingRequirement(row as SectBuildingRow),
      ),
    };
  }

  private async addLog(
    sectId: string,
    logType: string,
    operatorId: number | null,
    targetId: number | null,
    content: string,
  ): Promise<void> {
    await query(
      `INSERT INTO sect_log (sect_id, log_type, operator_id, target_id, content) VALUES ($1, $2, $3, $4, $5)`,
      [sectId, logType, operatorId, targetId, content],
    );
  }

  private async applyHallMemberCap(sectId: string): Promise<void> {
    const hallRes = await query(
      `SELECT level FROM sect_building WHERE sect_id = $1 AND building_type = $2`,
      [sectId, HALL_BUILDING_TYPE],
    );
    const hallLevel =
      hallRes.rows.length > 0 ? toNumber(hallRes.rows[0].level) : 1;
    const cap = 20 + Math.max(0, hallLevel - 1) * 5;
    await query(
      "UPDATE sect_def SET max_members = $2, updated_at = NOW() WHERE id = $1",
      [sectId, cap],
    );
  }

  @Transactional
  async upgradeBuilding(
    characterId: number,
    buildingType: string,
  ): Promise<Result> {
    const config = getSectBuildingUpgradeConfig(buildingType);
    if (!config) {
      return { success: false, message: UPGRADE_CLOSED_MESSAGE };
    }

    const member = await assertMember(characterId);
    if (!hasPermission(member.position, "building")) {
      return { success: false, message: "无权限升级建筑" };
    }

    const buildingRes = await query(
      `SELECT * FROM sect_building WHERE sect_id = $1 AND building_type = $2 FOR UPDATE`,
      [member.sectId, buildingType],
    );
    if (buildingRes.rows.length === 0) {
      return { success: false, message: "建筑不存在" };
    }

    const building = buildingRes.rows[0] as SectBuildingRow;
    const currentLevel = toNumber(building.level);
    const requirement = getBuildingUpgradeRequirement(buildingType, currentLevel);
    if (!requirement.upgradable) {
      return { success: false, message: FULLY_UPGRADED_MESSAGE };
    }

    const cost = config.getUpgradeCost(currentLevel);
    const sectRes = await query(
      `SELECT funds, build_points FROM sect_def WHERE id = $1 FOR UPDATE`,
      [member.sectId],
    );
    if (sectRes.rows.length === 0) {
      return { success: false, message: "宗门不存在" };
    }
    const funds = toNumber(sectRes.rows[0].funds);
    const buildPoints = toNumber(sectRes.rows[0].build_points);
    if (funds < cost.funds) {
      return { success: false, message: "宗门资金不足" };
    }
    if (buildPoints < cost.buildPoints) {
      return { success: false, message: "建设点不足" };
    }

    await query(
      `UPDATE sect_def SET funds = funds - $2, build_points = build_points - $3, updated_at = NOW() WHERE id = $1`,
      [member.sectId, cost.funds, cost.buildPoints],
    );
    await query(
      `UPDATE sect_building SET level = level + 1, updated_at = NOW() WHERE id = $1`,
      [building.id],
    );

    if (buildingType === HALL_BUILDING_TYPE) {
      await this.applyHallMemberCap(member.sectId);
    }
    await this.addLog(
      member.sectId,
      "upgrade_building",
      characterId,
      null,
      `升级建筑：${getSectBuildingDisplayName(buildingType)}`,
    );
    await invalidateSectInfoCache(member.sectId);
    return { success: true, message: "升级成功" };
  }
}

export const sectBuildingService = new SectBuildingService();

// 向后兼容的命名导出
export const getBuildings = (characterId: number) =>
  sectBuildingService.getBuildings(characterId);
export const upgradeBuilding = (characterId: number, buildingType: string) =>
  sectBuildingService.upgradeBuilding(characterId, buildingType);
