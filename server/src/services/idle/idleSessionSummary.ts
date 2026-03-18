/**
 * IdleSessionSummary — 挂机会话汇总状态单一入口
 *
 * 作用（做什么 / 不做什么）：
 *   1. 集中维护挂机会话的汇总增量与 reward_items 快照，避免执行器和 Service 各写一套合并逻辑。
 *   2. 为 flush 阶段提供可直接落库的 summary snapshot，减少 reward_items 的重复查库。
 *   3. 不负责数据库读写，不负责战斗模拟，只负责纯内存汇总。
 *
 * 输入/输出：
 *   - createIdleSessionSummaryState(initialRewardItems, initialBagFullFlag) → 初始汇总状态
 *   - appendBattleResultToIdleSessionSummary(state, result) → 追加单场战斗结果
 *   - getIdleSessionSummaryFlushPayload(state) → 当前 flush 所需的 delta + snapshot
 *   - resetIdleSessionSummaryDelta(state) → flush 成功后清空本轮增量
 *
 * 数据流/状态流：
 *   IdleSessionRow.rewardItems / bagFullFlag → summaryState 初始化
 *   → 每场战斗结果追加到 delta 与 snapshot
 *   → flush 时导出 payload
 *   → idleSessionService.updateSessionSummary 一次性写回 DB
 *
 * 关键边界条件与坑点：
 *   1. reward_items 只按 itemDefId 合并数量，itemName 以首个条目为准；这是当前挂机汇总展示的唯一口径。
 *   2. flush 失败时不能提前清空 delta，否则会出现批次未重试但汇总已丢失；因此 reset 必须只在 flush 成功后调用。
 */

import type { IdleSessionRow, RewardItemEntry } from './types.js';

export interface IdleSessionSummaryDelta {
  totalBattlesDelta: number;
  winDelta: number;
  loseDelta: number;
  expDelta: number;
  silverDelta: number;
  newItems: RewardItemEntry[];
  bagFullFlag: boolean;
}

export interface IdleSessionSummarySnapshot {
  rewardItems: RewardItemEntry[];
  bagFullFlag: boolean;
}

export interface IdleSessionSummaryState {
  delta: IdleSessionSummaryDelta;
  snapshot: IdleSessionSummarySnapshot;
}

export type IdleSessionSummaryBattleResult = {
  result: 'attacker_win' | 'defender_win' | 'draw';
  expGained: number;
  silverGained: number;
  itemsGained: RewardItemEntry[];
  bagFullFlag: boolean;
};

function createEmptyIdleSessionSummaryDelta(): IdleSessionSummaryDelta {
  return {
    totalBattlesDelta: 0,
    winDelta: 0,
    loseDelta: 0,
    expDelta: 0,
    silverDelta: 0,
    newItems: [],
    bagFullFlag: false,
  };
}

function cloneRewardItemEntries(items: RewardItemEntry[]): RewardItemEntry[] {
  return items.map((item) => ({ ...item }));
}

/**
 * 合并挂机奖励物品（按 itemDefId 聚合数量）。
 */
export function mergeRewardItems(
  existing: RewardItemEntry[],
  newItems: RewardItemEntry[],
): RewardItemEntry[] {
  const merged = new Map<string, RewardItemEntry>();

  for (const item of existing) {
    merged.set(item.itemDefId, { ...item });
  }

  for (const item of newItems) {
    const current = merged.get(item.itemDefId);
    if (current) {
      current.quantity += item.quantity;
      continue;
    }
    merged.set(item.itemDefId, { ...item });
  }

  return Array.from(merged.values());
}

/**
 * 创建会话汇总状态。
 */
export function createIdleSessionSummaryState(
  initial: Pick<IdleSessionRow, 'rewardItems' | 'bagFullFlag'>,
): IdleSessionSummaryState {
  return {
    delta: createEmptyIdleSessionSummaryDelta(),
    snapshot: {
      rewardItems: cloneRewardItemEntries(initial.rewardItems),
      bagFullFlag: initial.bagFullFlag,
    },
  };
}

/**
 * 追加单场战斗结果到会话汇总状态。
 */
export function appendBattleResultToIdleSessionSummary(
  state: IdleSessionSummaryState,
  batchResult: IdleSessionSummaryBattleResult,
): void {
  state.delta.totalBattlesDelta += 1;
  if (batchResult.result === 'attacker_win') {
    state.delta.winDelta += 1;
  }
  if (batchResult.result === 'defender_win') {
    state.delta.loseDelta += 1;
  }
  state.delta.expDelta += batchResult.expGained;
  state.delta.silverDelta += batchResult.silverGained;
  state.delta.newItems = mergeRewardItems(state.delta.newItems, batchResult.itemsGained);
  state.snapshot.rewardItems = mergeRewardItems(state.snapshot.rewardItems, batchResult.itemsGained);

  if (batchResult.bagFullFlag) {
    state.delta.bagFullFlag = true;
    state.snapshot.bagFullFlag = true;
  }
}

/**
 * 导出当前 flush 所需的增量与快照。
 */
export function getIdleSessionSummaryFlushPayload(
  state: IdleSessionSummaryState,
): {
  delta: IdleSessionSummaryDelta;
  snapshot: IdleSessionSummarySnapshot;
} {
  return {
    delta: {
      ...state.delta,
      newItems: cloneRewardItemEntries(state.delta.newItems),
    },
    snapshot: {
      rewardItems: cloneRewardItemEntries(state.snapshot.rewardItems),
      bagFullFlag: state.snapshot.bagFullFlag,
    },
  };
}

/**
 * flush 成功后清空本轮增量，保留累计快照供下一轮继续复用。
 */
export function resetIdleSessionSummaryDelta(state: IdleSessionSummaryState): void {
  state.delta = createEmptyIdleSessionSummaryDelta();
}
