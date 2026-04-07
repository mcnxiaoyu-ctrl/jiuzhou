/**
 * 宗门默认建筑收口模块
 *
 * 作用：
 * 1. 统一声明宗门应具备的默认建筑集合。
 * 2. 提供“补齐缺失默认建筑”的单一入口，避免创建宗门、宗门详情读取、建筑面板读取各写一套插入逻辑。
 * 不做：
 * 1. 不处理建筑升级、效果计算和权限判断。
 * 2. 不决定建筑展示文案；展示仍由建筑配置模块负责。
 *
 * 输入 / 输出：
 * - 输入：宗门 ID。
 * - 输出：无返回；副作用是确保默认建筑行存在。
 *
 * 数据流 / 状态流：
 * - 创建宗门 / 宗门详情回源 -> 本模块 -> `sect_building` -> 后续读链路读取统一建筑集合。
 *
 * 复用设计说明：
 * - 把默认建筑集合和补齐逻辑集中到这里，新增建筑时只需要改一处，避免 `core.ts`、`cache.ts`、`buildings.ts` 再次出现重复名单。
 * - 被 `sect/core.ts` 与 `sect/cache.ts` 复用。
 * - 默认建筑集合属于高频业务变化点，独立模块可以减少未来接入新建筑时的修改面。
 *
 * 关键边界条件与坑点：
 * 1. 补齐必须使用 `ON CONFLICT DO NOTHING`，避免并发读取/创建时重复插入报错。
 * 2. 这里只保证“行存在”，初始等级和状态必须与新建宗门保持同一口径，不能出现两套默认值。
 */
import { query } from '../../config/database.js';
import {
  BLESSING_HALL_BUILDING_TYPE,
  FORGE_HOUSE_BUILDING_TYPE,
  HALL_BUILDING_TYPE,
} from './buildingConfig.js';

export const DEFAULT_SECT_BUILDING_TYPES: readonly string[] = [
  HALL_BUILDING_TYPE,
  'library',
  'training_hall',
  'alchemy_room',
  FORGE_HOUSE_BUILDING_TYPE,
  'spirit_array',
  'defense_array',
  BLESSING_HALL_BUILDING_TYPE,
] as const;

export const ensureSectDefaultBuildings = async (
  sectId: string,
): Promise<void> => {
  for (const buildingType of DEFAULT_SECT_BUILDING_TYPES) {
    await query(
      `
        INSERT INTO sect_building (sect_id, building_type, level, status)
        VALUES ($1, $2, 1, 'normal')
        ON CONFLICT (sect_id, building_type) DO NOTHING
      `,
      [sectId, buildingType],
    );
  }
};
