import assert from 'node:assert/strict';
import test from 'node:test';
import { partitionIdleWorkerFlushBatches } from '../idle/idleWorkerFlushPartition.js';
import type { IdleRewardWindowBatch } from '../idle/idleRewardWindow.js';

/**
 * IdleWorkerFlushPartition 回归测试
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：锁定 Worker flush 在遇到已落库批次时的分流规则，避免重复批次把同窗口新批次一起吞掉。
 * 2. 做什么：验证“无重复时不额外复制分流规则”的最小路径，保证执行器仍能整窗批量处理。
 * 3. 不做什么：不连接数据库、不执行真实 flush、不校验奖励兑现细节。
 *
 * 输入 / 输出：
 * 1. 输入：模拟的窗口批次数组、已落库批次 ID 集合。
 * 2. 输出：分流结果中的 `persistedBatches`、`pendingBatches`、`hasPersistedBatches`。
 *
 * 数据流 / 状态流：
 * 测试构造窗口批次 -> 调用分流纯函数 -> 断言执行器后续应保留的新批次集合。
 *
 * 复用设计说明：
 * 1. 该测试与 Worker 主流程共享同一个分流函数，避免测试再手写一套过滤逻辑导致“测的不是线上代码”。
 * 2. 批次样本只保留 flush 分流所需字段，减少样板代码，后续若批次结构扩展也只需维护一个构造入口。
 *
 * 关键边界条件与坑点：
 * 1. 窗口里混入旧批次时，必须只跳过旧批次，不能把同窗新批次一起清空。
 * 2. 无重复批次时，`pendingBatches` 必须保持原顺序，保证后续 batch_index 与奖励兑现顺序稳定。
 */

function createBatch(id: string, batchIndex: number): IdleRewardWindowBatch {
  return {
    id,
    sessionId: 'session-1',
    batchIndex,
    result: 'attacker_win',
    roundCount: 1,
    randomSeed: batchIndex,
    replaySnapshot: null,
    monsterIds: [`monster-${batchIndex}`],
    expGained: 10,
    silverGained: 20,
    previewItems: [],
    dropPlans: [],
  };
}

test('partitionIdleWorkerFlushBatches: 无已落库批次时应保留整窗待写数据', () => {
  const batches = [createBatch('batch-1', 1), createBatch('batch-2', 2)];

  const result = partitionIdleWorkerFlushBatches(batches, new Set<string>());

  assert.equal(result.hasPersistedBatches, false);
  assert.deepEqual(result.persistedBatches, []);
  assert.equal(result.pendingBatches, batches);
});

test('partitionIdleWorkerFlushBatches: 已落库旧批次与新批次混合时应仅过滤旧批次', () => {
  const batch1 = createBatch('batch-1', 1);
  const batch2 = createBatch('batch-2', 2);
  const batch3 = createBatch('batch-3', 3);

  const result = partitionIdleWorkerFlushBatches(
    [batch1, batch2, batch3],
    new Set<string>(['batch-1', 'batch-3']),
  );

  assert.equal(result.hasPersistedBatches, true);
  assert.deepEqual(result.persistedBatches, [batch1, batch3]);
  assert.deepEqual(result.pendingBatches, [batch2]);
});
