import assert from 'node:assert/strict';
import test from 'node:test';

import { shouldContinueOnlineBattleSettlementDispatch } from '../onlineBattleSettlementDrainPolicy.js';

/**
 * 在线战斗延迟结算分片调度策略回归测试
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：锁定常规 tick 在达到派发截止时间或单轮派发上限后必须停止补派，避免 backlog 稍大时单轮耗时持续膨胀。
 * 2. 做什么：验证显式 `flush` 走 `drainAll` 时不会被分片预算截断，保留“清空队列”的强语义。
 * 3. 不做什么：不执行真实 runner、不创建 Promise，也不验证任务执行结果。
 *
 * 输入 / 输出：
 * - 输入：不同的预算模式、累计耗时、已派发任务数、派发预算窗口与最大派发数。
 * - 输出：当前 tick 是否允许继续补派新任务。
 *
 * 数据流 / 状态流：
 * runner 计算本轮状态 -> 调用纯函数策略 -> true 继续补派 / false 停止补派。
 *
 * 复用设计说明：
 * 1. 测试和 runner 共享同一个预算函数，避免测试再手写一套阈值判断造成口径漂移。
 * 2. 这里把“派发截止时间”“收尾预留窗口”和“派发上限”拆成独立断言，后续调参时只需要改常量，不需要重写测试结构。
 *
 * 关键边界条件与坑点：
 * 1. 常规 tick 只要任一预算命中就必须停止补派，不能继续抢新任务。
 * 2. `drainAll` 模式必须无视预算直接放行，否则显式 flush 会意外退化。
 */

test('shouldContinueOnlineBattleSettlementDispatch: 常规 tick 未超预算时应允许继续补派', () => {
  assert.equal(
    shouldContinueOnlineBattleSettlementDispatch({
      drainAll: false,
      elapsedMs: 400,
      dispatchedTaskCount: 3,
      dispatchBudgetMs: 1150,
      maxDispatchedTaskCount: 8,
    }),
    true,
  );
});

test('shouldContinueOnlineBattleSettlementDispatch: 命中派发截止时间时应停止补派', () => {
  assert.equal(
    shouldContinueOnlineBattleSettlementDispatch({
      drainAll: false,
      elapsedMs: 1150,
      dispatchedTaskCount: 3,
      dispatchBudgetMs: 1150,
      maxDispatchedTaskCount: 8,
    }),
    false,
  );
});

test('shouldContinueOnlineBattleSettlementDispatch: 收尾预留窗口内应停止补派最后一批任务', () => {
  assert.equal(
    shouldContinueOnlineBattleSettlementDispatch({
      drainAll: false,
      elapsedMs: 1149,
      dispatchedTaskCount: 7,
      dispatchBudgetMs: 1150,
      maxDispatchedTaskCount: 8,
    }),
    true,
  );

  assert.equal(
    shouldContinueOnlineBattleSettlementDispatch({
      drainAll: false,
      elapsedMs: 1150,
      dispatchedTaskCount: 7,
      dispatchBudgetMs: 1150,
      maxDispatchedTaskCount: 8,
    }),
    false,
  );
});

test('shouldContinueOnlineBattleSettlementDispatch: 命中单轮派发上限时应停止补派', () => {
  assert.equal(
    shouldContinueOnlineBattleSettlementDispatch({
      drainAll: false,
      elapsedMs: 200,
      dispatchedTaskCount: 8,
      dispatchBudgetMs: 1150,
      maxDispatchedTaskCount: 8,
    }),
    false,
  );
});

test('shouldContinueOnlineBattleSettlementDispatch: drainAll 模式应始终允许继续补派', () => {
  assert.equal(
    shouldContinueOnlineBattleSettlementDispatch({
      drainAll: true,
      elapsedMs: 30_000,
      dispatchedTaskCount: 999,
      dispatchBudgetMs: 1150,
      maxDispatchedTaskCount: 8,
    }),
    true,
  );
});
