/**
 * 秘境模块导出聚合
 *
 * 作用：集中导出秘境模块所有对外 API 和类型，作为唯一入口。
 * 不做什么：不包含任何业务逻辑实现。
 *
 * 模块结构：
 * - types.ts — 类型定义
 * - definitions.ts — 秘境定义查询（分类/列表/预览）
 * - instance.ts — 秘境实例管理（创建/加入/查询）
 * - combat.ts — 秘境战斗（开启/推进/结算）
 * - service.ts — DungeonService 类（@Transactional 包装）
 * - shared/ — 内部工具（configLoader / entryCount / participants / stageData / rewards / typeUtils）
 */

/* 类型导出 */
export type {
  DungeonType,
  DungeonCategoryDto,
  DungeonDefDto,
  DungeonInstanceStatus,
  DungeonInstanceParticipant,
  DungeonRewardItem,
  DungeonRewardBundle,
} from './types.js';

/* 查询函数导出 */
export {
  getDungeonCategories,
  getDungeonList,
  getDungeonPreview,
  DUNGEON_TYPE_LABEL,
} from './definitions.js';

/* 实例管理函数导出 */
export {
  createDungeonInstance,
  joinDungeonInstance,
  getDungeonInstance,
} from './instance.js';

/* 战斗函数导出 */
export {
  startDungeonInstance,
  nextDungeonInstance,
} from './combat.js';

/* 服务实例导出 */
export { dungeonService } from './service.js';
