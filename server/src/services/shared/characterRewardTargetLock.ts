import { lockCharacterInventoryMutexes } from '../inventoryMutex.js';
import {
  lockCharacterRowsInOrder,
  normalizeCharacterRowLockIds,
} from './characterRowLock.js';

/**
 * Character Reward Target Lock - 奖励结算目标统一加锁工具
 *
 * 作用（做什么 / 不做什么）：
 * - 做什么：统一奖励发放场景里的锁顺序，先拿角色背包互斥锁，再按角色 ID 升序锁定 `characters` 行。
 * - 不做什么：不计算奖励数值，不写入角色资源，也不负责事务开启与重试。
 *
 * 输入/输出：
 * - normalizeCharacterRewardTargetIds(characterIds)：输入角色 ID 列表，输出去重、过滤非法值并升序后的结果。
 * - lockCharacterRewardSettlementTargets(characterIds)：输入角色 ID 列表，输出实际完成加锁的升序角色 ID 列表。
 *
 * 复用点：
 * - battleDropService 与 dungeon/combat 共用这一套加锁顺序，避免相同锁协议散落在多个奖励入口。
 *
 * 数据流/状态流：
 * - 奖励结算服务先收集参与角色 ID；
 * - 本模块先统一获取背包 advisory xact lock，确保背包写入串行化；
 * - 再对同一批角色执行 `SELECT ... FOR UPDATE`，把后续 `UPDATE characters` 的行锁顺序固定下来。
 *
 * 关键边界条件与坑点：
 * 1. 本模块必须运行在事务上下文中；背包互斥锁与行锁都依赖同一事务连接生命周期。
 * 2. 只锁合法正整数角色 ID；非法 ID 会被直接过滤，避免把无效参数带进锁语句。
 */
export const normalizeCharacterRewardTargetIds = (
  characterIds: number[],
): number[] => normalizeCharacterRowLockIds(characterIds);

export const lockCharacterRewardSettlementTargets = async (
  characterIds: number[],
): Promise<number[]> => {
  const normalizedCharacterIds = normalizeCharacterRewardTargetIds(characterIds);
  if (normalizedCharacterIds.length === 0) {
    return normalizedCharacterIds;
  }

  await lockCharacterInventoryMutexes(normalizedCharacterIds);
  await lockCharacterRowsInOrder(normalizedCharacterIds);

  return normalizedCharacterIds;
};
