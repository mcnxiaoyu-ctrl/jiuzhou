/**
 * 背包领域门面
 * 作用：集中暴露背包相关服务，降低 routes 对 services 目录耦合。
 *
 * 设计约束：
 * 1) inventoryService 必须直接复用 services 层单例，确保写操作统一走 @Transactional。
 * 2) 不在 domains 层二次拼装“函数对象”，避免绕过事务装饰器。
 */
import { inventoryService as serviceInventoryService } from '../../services/inventory/index.js';
export { itemService } from '../../services/itemService.js';
export { craftService } from '../../services/craftService.js';
export { gemSynthesisService } from '../../services/gemSynthesisService.js';

export const inventoryService = serviceInventoryService;

export type {
  InventoryInfo,
  InventoryItem,
  InventoryItemWithDef,
  InventorySaleCandidateDto,
  InventoryLocation,
  SlottedInventoryLocation,
} from '../../services/inventory/index.js';

export * from '../../services/itemService.js';
export * from '../../services/craftService.js';
export * from '../../services/gemSynthesisService.js';
