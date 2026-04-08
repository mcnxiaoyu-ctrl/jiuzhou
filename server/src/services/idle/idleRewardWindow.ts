/**
 * IdleRewardWindow — 挂机 30 秒奖励窗口纯内存模型
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：集中维护“每场已计算奖励计划”的窗口缓存，并为 flush 提供聚合视图。
 * 2. 做什么：提供统一的 30 秒 flush 判定，避免执行器和测试各自手写时间窗口逻辑。
 * 3. 不做什么：不做数据库写入，不做真实入包，不依赖外部服务。
 *
 * 输入/输出：
 * - createIdleRewardWindowState()：创建空窗口状态。
 * - appendIdleRewardWindowBatch(state, batch)：追加单场已计算奖励。
 * - getIdleRewardWindowFlushPayload(state)：导出当前窗口所有批次与聚合奖励计划。
 * - resetIdleRewardWindowDelta(state, now)：flush 成功后清空窗口。
 * - shouldFlushIdleRewardWindow(...)：判断当前窗口是否需要 flush。
 *
 * 数据流/状态流：
 * 每场战斗结果 -> 单场奖励计划 -> 窗口状态
 * -> flush 时导出 { batches, windowRewardPlan }
 * -> flush 成功后 reset
 *
 * 关键边界条件与坑点：
 * 1. 掉落计划必须按 itemDefId/bindType/qualityWeights 聚合，避免 30 秒窗口内重复入包相同堆叠物。
 * 2. reset 只能在 flush 成功后调用；失败时必须保留原窗口，供下次重试。
 */

import type {
  IdleBattleRewardSettlementPlan,
  IdleRewardPlanDropEntry,
  RewardItemEntry,
} from './types.js';
import { mergeRewardItems } from './idleSessionSummary.js';

export interface IdleRewardWindowBatch {
  result: 'attacker_win' | 'defender_win' | 'draw';
  roundCount: number;
  expGained: number;
  silverGained: number;
  previewItems: RewardItemEntry[];
  dropPlans: IdleRewardPlanDropEntry[];
}

export interface IdleRewardWindowState {
  batches: IdleRewardWindowBatch[];
  lastFlushAt: number;
}

const buildDropPlanKey = (dropPlan: IdleRewardPlanDropEntry): string => {
  const qualityWeightsKey = dropPlan.qualityWeights
    ? JSON.stringify(
        Object.keys(dropPlan.qualityWeights)
          .sort()
          .reduce<Record<string, number>>((acc, key) => {
            acc[key] = dropPlan.qualityWeights![key]!;
            return acc;
          }, {}),
      )
    : '';
  return `${dropPlan.itemDefId}|${dropPlan.bindType}|${qualityWeightsKey}`;
};

export const createIdleRewardWindowState = (): IdleRewardWindowState => ({
  batches: [],
  lastFlushAt: Date.now(),
});

export const appendIdleRewardWindowBatch = (
  state: IdleRewardWindowState,
  batch: IdleRewardWindowBatch,
): void => {
  state.batches.push(batch);
};

export const getIdleRewardWindowFlushPayload = (
  state: IdleRewardWindowState,
): {
  batches: IdleRewardWindowBatch[];
  windowRewardPlan: IdleBattleRewardSettlementPlan;
} => {
  let expGained = 0;
  let silverGained = 0;
  let previewItems: RewardItemEntry[] = [];
  const mergedDropPlans = new Map<string, IdleRewardPlanDropEntry>();

  for (const batch of state.batches) {
    expGained += batch.expGained;
    silverGained += batch.silverGained;
    previewItems = mergeRewardItems(previewItems, batch.previewItems);

    for (const dropPlan of batch.dropPlans) {
      const key = buildDropPlanKey(dropPlan);
      const existing = mergedDropPlans.get(key);
      if (existing) {
        existing.quantity += dropPlan.quantity;
        continue;
      }
      mergedDropPlans.set(key, { ...dropPlan });
    }
  }

  return {
    batches: state.batches.map((batch) => ({
      ...batch,
      previewItems: batch.previewItems.map((item) => ({ ...item })),
      dropPlans: batch.dropPlans.map((dropPlan) => ({
        ...dropPlan,
        ...(dropPlan.qualityWeights
          ? { qualityWeights: { ...dropPlan.qualityWeights } }
          : {}),
      })),
    })),
    windowRewardPlan: {
      expGained,
      silverGained,
      previewItems,
      dropPlans: Array.from(mergedDropPlans.values()).map((dropPlan) => ({
        ...dropPlan,
        ...(dropPlan.qualityWeights
          ? { qualityWeights: { ...dropPlan.qualityWeights } }
          : {}),
      })),
    },
  };
};

export const resetIdleRewardWindowDelta = (
  state: IdleRewardWindowState,
  now: number,
): void => {
  state.batches = [];
  state.lastFlushAt = now;
};

export const shouldFlushIdleRewardWindow = (options: {
  pendingBatchCount: number;
  lastFlushAt: number;
  now: number;
  flushIntervalMs: number;
}): boolean => {
  if (options.pendingBatchCount === 0) {
    return false;
  }

  return options.now - options.lastFlushAt >= options.flushIntervalMs;
};
