/**
 * IdleWorkerFlushPartition — Worker 挂机 flush 批次分流工具
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：把当前奖励窗口中的批次按“已落库 / 待落库”分成两组，供 Worker flush 做幂等写入。
 * 2. 做什么：集中沉淀“窗口里混入已落库旧批次时，仍需保留同窗口新批次继续兑现”的规则，避免执行器里散落过滤逻辑。
 * 3. 不做什么：不访问数据库、不结算奖励、不更新会话汇总，只负责纯内存分流。
 *
 * 输入 / 输出：
 * 1. 输入：当前窗口批次数组、数据库中已存在的批次 ID 集合。
 * 2. 输出：`persistedBatches`、`pendingBatches` 和 `hasPersistedBatches`。
 *
 * 数据流 / 状态流：
 * flushBuffer 读取窗口批次 -> 查询已存在批次 ID -> 调用本模块分流
 * -> 执行器只对 `pendingBatches` 做兑现 / INSERT
 * -> 若存在 `persistedBatches`，执行器先从 DB 同步最新会话汇总基线。
 *
 * 复用设计说明：
 * 1. “批次分流”是幂等 flush 的核心规则，独立成纯函数后，Worker 主流程和回归测试都复用这一处实现。
 * 2. 未来若普通执行器也引入相同的窗口重试语义，可直接复用本模块，不需要再复制一套过滤逻辑。
 * 3. 高频变化点是“如何判定某批次已持久化”，当前收敛为 `id` 集合输入，调用方只需负责查询，不与具体 SQL 绑定。
 *
 * 关键边界条件与坑点：
 * 1. 当窗口里同时存在“已落库旧批次”和“本轮新批次”时，不能因为检测到重复就整窗丢弃，否则会漏发本轮新增奖励。
 * 2. `persistedBatchIds` 必须被视为精确事实来源；本模块不会尝试猜测批次状态，也不会主动补默认值。
 */

import type { IdleRewardWindowBatch } from './idleRewardWindow.js';

export interface IdleWorkerFlushPartitionResult {
  persistedBatches: IdleRewardWindowBatch[];
  pendingBatches: IdleRewardWindowBatch[];
  hasPersistedBatches: boolean;
}

export function partitionIdleWorkerFlushBatches(
  batches: IdleRewardWindowBatch[],
  persistedBatchIds: ReadonlySet<string>,
): IdleWorkerFlushPartitionResult {
  if (persistedBatchIds.size === 0) {
    return {
      persistedBatches: [],
      pendingBatches: batches,
      hasPersistedBatches: false,
    };
  }

  const persistedBatches: IdleRewardWindowBatch[] = [];
  const pendingBatches: IdleRewardWindowBatch[] = [];

  for (const batch of batches) {
    if (persistedBatchIds.has(batch.id)) {
      persistedBatches.push(batch);
      continue;
    }

    pendingBatches.push(batch);
  }

  return {
    persistedBatches,
    pendingBatches,
    hasPersistedBatches: persistedBatches.length > 0,
  };
}
