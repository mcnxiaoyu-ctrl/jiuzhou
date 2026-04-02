/**
 * 在线战斗延迟结算任务可调度性纯函数回归测试
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：锁定 `failed` 任务只有在未耗尽 `maxAttempts` 时才允许再次进入 runner，避免无限重试。
 * 2. 做什么：覆盖 `pending`、可重试 `failed`、已耗尽 `failed` 三种核心状态，确保调度筛选语义稳定。
 * 3. 不做什么：不触发真实 Redis 读写、不执行 runner，也不验证数据库落库行为。
 *
 * 输入/输出：
 * - 输入：不同状态与重试计数的 `DeferredSettlementTask` 样本。
 * - 输出：`isDeferredSettlementTaskRunnable` 返回的布尔值。
 *
 * 数据流/状态流：
 * task snapshot -> isDeferredSettlementTaskRunnable
 * -> 调度筛选是否允许继续执行
 * -> runner 是否会再次消费这条任务。
 *
 * 复用设计说明：
 * 1. 直接测试投影服务导出的纯函数，避免为了验证一个状态判断去搭建整套 Redis/runner mock。
 * 2. 这条断言同时约束运行时代码和后续依赖该 helper 的测试，减少状态判断分叉。
 *
 * 关键边界条件与坑点：
 * 1. `failed` 的上限判断必须使用严格小于号，否则会比配置多重试一轮。
 * 2. `pending` 任务不应被既有 attempts 值拦截，否则恢复场景会把尚未真正执行的任务误杀。
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  isDeferredSettlementTaskRunnable,
  type DeferredSettlementTask,
} from '../onlineBattleProjectionService.js';

const createTask = (
  overrides: Partial<DeferredSettlementTask>,
): DeferredSettlementTask => ({
  taskId: 'task-runnable-check',
  battleId: 'battle-runnable-check',
  status: 'pending',
  attempts: 0,
  maxAttempts: 5,
  createdAt: 0,
  updatedAt: 0,
  errorMessage: null,
  payload: {
    battleId: 'battle-runnable-check',
    battleType: 'pve',
    result: 'draw',
    participants: [],
    rewardParticipants: [],
    isDungeonBattle: false,
    isTowerBattle: false,
    rewardsPreview: null,
    battleRewardPlan: null,
    monsters: [],
    arenaDelta: null,
    dungeonContext: null,
    dungeonStartConsumption: null,
    dungeonSettlement: null,
    session: null,
  },
  ...overrides,
});

test('isDeferredSettlementTaskRunnable: pending 任务始终可调度', () => {
  assert.equal(
    isDeferredSettlementTaskRunnable(createTask({
      status: 'pending',
      attempts: 5,
      maxAttempts: 5,
    })),
    true,
  );
});

test('isDeferredSettlementTaskRunnable: failed 且未耗尽重试次数时仍可调度', () => {
  assert.equal(
    isDeferredSettlementTaskRunnable(createTask({
      status: 'failed',
      attempts: 4,
      maxAttempts: 5,
    })),
    true,
  );
});

test('isDeferredSettlementTaskRunnable: failed 且已耗尽重试次数时不可调度', () => {
  assert.equal(
    isDeferredSettlementTaskRunnable(createTask({
      status: 'failed',
      attempts: 5,
      maxAttempts: 5,
    })),
    false,
  );
});
