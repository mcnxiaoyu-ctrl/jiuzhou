/**
 * 自动分解奖励批量聚合器
 *
 * 作用：
 * - 将同一次装备自动分解调用内的物品产物按 itemDefId 聚合，减少后续 createItem 调用次数。
 * - 只处理物品产物数量与源装备 fallbackIndex 归属，不处理银两、背包入包、邮件兜底或源装备创建。
 *
 * 输入 / 输出：
 * - 输入：每个成功自动分解源装备的 fallbackIndex，以及该装备分解得到的 rewards.items。
 * - 输出：按首次出现 itemDefId 排序的聚合项，包含 itemDefId、总 qty、去重后的 fallbackIndexes。
 *
 * 数据流 / 状态流：
 * - rewardPlan.rewards.items 在装备循环内追加到 batch。
 * - batch 内部用 Map 做 itemDefId 索引，追加时同步累加 qty 与登记 fallbackIndex。
 * - 循环结束后 finalize 输出稳定数组，交给自动分解 chunk 发放函数统一入包。
 *
 * 复用设计说明：
 * - 聚合规则集中在服务层纯函数，装备奖励分支只关心何时追加、何时回退，避免把 itemDefId 聚合和 fallback 去重散落在主流程。
 * - 当前由装备自动分解批量发放复用；未来若其他单次调用内也需要“产物聚合 + 源奖励回退归属”，可复用同一入口。
 * - itemDefId、qty、fallbackIndexes 是高频变化点，统一在这里收敛可避免多处重复维护过滤和去重规则。
 *
 * 关键边界条件与坑点：
 * 1. 空 itemDefId 与非正数量必须在追加阶段过滤，否则会制造无效入包请求或错误邮件项。
 * 2. fallbackIndexes 需要按首次出现顺序去重，不能排序后存储；失败回退排序属于调用方的结算策略。
 */
import type { DisassembleItemRewardPlan } from './disassembleRewardPlanner.js';

export type AutoDisassembleRewardBatch = {
  entriesByItemDefId: Map<string, {
    itemDefId: string;
    qty: number;
    fallbackIndexes: number[];
    fallbackIndexSet: Set<number>;
  }>;
};

export type AutoDisassembleRewardBatchEntry = {
  fallbackIndex: number;
  rewards: readonly DisassembleItemRewardPlan[];
};

export type FinalizedAutoDisassembleRewardBatchItem = {
  itemDefId: string;
  qty: number;
  fallbackIndexes: number[];
};

export const createAutoDisassembleRewardBatch = (): AutoDisassembleRewardBatch => ({
  entriesByItemDefId: new Map(),
});

export const appendAutoDisassembleRewardBatchEntry = (
  batch: AutoDisassembleRewardBatch,
  entry: AutoDisassembleRewardBatchEntry,
): void => {
  if (!Number.isInteger(entry.fallbackIndex) || entry.fallbackIndex < 0) return;

  for (const reward of entry.rewards) {
    const itemDefId = reward.itemDefId.trim();
    const qty = Math.floor(reward.qty);
    if (!itemDefId || !Number.isFinite(qty) || qty <= 0) continue;

    let target = batch.entriesByItemDefId.get(itemDefId);
    if (!target) {
      target = {
        itemDefId,
        qty: 0,
        fallbackIndexes: [],
        fallbackIndexSet: new Set(),
      };
      batch.entriesByItemDefId.set(itemDefId, target);
    }

    target.qty += qty;
    if (!target.fallbackIndexSet.has(entry.fallbackIndex)) {
      target.fallbackIndexSet.add(entry.fallbackIndex);
      target.fallbackIndexes.push(entry.fallbackIndex);
    }
  }
};

export const finalizeAutoDisassembleRewardBatch = (
  batch: AutoDisassembleRewardBatch,
): FinalizedAutoDisassembleRewardBatchItem[] => {
  const items: FinalizedAutoDisassembleRewardBatchItem[] = [];

  for (const entry of batch.entriesByItemDefId.values()) {
    if (entry.qty <= 0) continue;
    items.push({
      itemDefId: entry.itemDefId,
      qty: entry.qty,
      fallbackIndexes: [...entry.fallbackIndexes],
    });
  }

  return items;
};
