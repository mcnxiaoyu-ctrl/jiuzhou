/**
 * 在线战斗延迟结算事件循环反压策略测试
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：锁定 event loop 繁忙时 runner 单轮只派发 1 个后台结算任务。
 * 2. 做什么：锁定 event loop 正常时保留现有并发预算，避免后台任务无故堆积。
 * 3. 不做什么：不启动真实 runner，不连接 Redis/数据库，不执行真实发奖。
 *
 * 输入 / 输出：
 * - 输入：dispatch budget 参数与事件循环快照。
 * - 输出：反压后的 maxConcurrency、maxDispatchedTaskCount、dispatchBudgetMs。
 *
 * 数据流 / 状态流：
 * eventLoopMonitor 快照 -> resolveOnlineBattleSettlementDispatchBudget
 * -> onlineBattleSettlementRunner.tick 使用预算控制补派任务。
 *
 * 复用设计说明：
 * - 将预算判断抽成纯函数，runner 和测试复用同一入口，避免测试复制调度条件。
 * - 后续调阈值只改策略函数，不改 runner 主循环。
 *
 * 关键边界条件与坑点：
 * 1. `drainAll=true` 是显式 flush，不能被普通反压截断。
 * 2. busy 阈值必须同时看 utilization 和 delay；CPU 空闲但事件循环 delay 高时仍要反压。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  resolveOnlineBattleSettlementDispatchBudget,
  resolveOnlineBattleSettlementTaskStartLimit,
  shouldSampleOnlineBattleSettlementTaskStage,
} from '../onlineBattleSettlementDrainPolicy.js';

const runnerSource = readFileSync(new URL('../onlineBattleSettlementRunner.ts', import.meta.url), 'utf8');

test('event loop 繁忙时应把常规 tick 限制为单任务派发', () => {
  const budget = resolveOnlineBattleSettlementDispatchBudget({
    drainAll: false,
    baseMaxConcurrency: 4,
    baseMaxDispatchedTaskCount: 8,
    tickBudgetMs: 1500,
    drainTailReserveMs: 350,
    eventLoopUtilization: 0.93,
    eventLoopDelayP95Ms: 42,
  });

  assert.equal(budget.eventLoopBackpressured, true);
  assert.equal(budget.maxConcurrency, 1);
  assert.equal(budget.maxDispatchedTaskCount, 1);
  assert.equal(budget.dispatchBudgetMs, 250);
});

test('p95 delay 单独达到强反压阈值时应限制为单任务派发', () => {
  const budget = resolveOnlineBattleSettlementDispatchBudget({
    drainAll: false,
    baseMaxConcurrency: 4,
    baseMaxDispatchedTaskCount: 8,
    tickBudgetMs: 1500,
    drainTailReserveMs: 350,
    eventLoopUtilization: 0.35,
    eventLoopDelayP95Ms: 80,
  });

  assert.equal(budget.eventLoopBackpressured, true);
  assert.equal(budget.maxConcurrency, 1);
  assert.equal(budget.maxDispatchedTaskCount, 1);
  assert.equal(budget.dispatchBudgetMs, 250);
});

test('utilization 达到中等反压阈值时应限制为两个任务派发', () => {
  const budget = resolveOnlineBattleSettlementDispatchBudget({
    drainAll: false,
    baseMaxConcurrency: 4,
    baseMaxDispatchedTaskCount: 8,
    tickBudgetMs: 1500,
    drainTailReserveMs: 350,
    eventLoopUtilization: 0.7,
    eventLoopDelayP95Ms: 23,
  });

  assert.equal(budget.eventLoopBackpressured, true);
  assert.equal(budget.maxConcurrency, 2);
  assert.equal(budget.maxDispatchedTaskCount, 2);
  assert.equal(budget.dispatchBudgetMs, 500);
});

test('p95 delay 单独达到中等反压阈值时应限制为两个任务派发', () => {
  const budget = resolveOnlineBattleSettlementDispatchBudget({
    drainAll: false,
    baseMaxConcurrency: 4,
    baseMaxDispatchedTaskCount: 8,
    tickBudgetMs: 1500,
    drainTailReserveMs: 350,
    eventLoopUtilization: 0.35,
    eventLoopDelayP95Ms: 40,
  });

  assert.equal(budget.eventLoopBackpressured, true);
  assert.equal(budget.maxConcurrency, 2);
  assert.equal(budget.maxDispatchedTaskCount, 2);
  assert.equal(budget.dispatchBudgetMs, 500);
});

test('event loop 正常时应保留基础派发预算', () => {
  const budget = resolveOnlineBattleSettlementDispatchBudget({
    drainAll: false,
    baseMaxConcurrency: 4,
    baseMaxDispatchedTaskCount: 8,
    tickBudgetMs: 1500,
    drainTailReserveMs: 350,
    eventLoopUtilization: 0.35,
    eventLoopDelayP95Ms: 23,
  });

  assert.equal(budget.eventLoopBackpressured, false);
  assert.equal(budget.maxConcurrency, 4);
  assert.equal(budget.maxDispatchedTaskCount, 8);
  assert.equal(budget.dispatchBudgetMs, 1150);
});

test('常规 tick 单轮启动数量应按剩余派发额度截断', () => {
  assert.equal(
    resolveOnlineBattleSettlementTaskStartLimit({
      drainAll: false,
      availableSlots: 4,
      dispatchedTaskCount: 6,
      maxDispatchedTaskCount: 8,
    }),
    2,
  );
});

test('常规 tick 剩余派发额度耗尽时单轮启动数量应返回 0', () => {
  assert.equal(
    resolveOnlineBattleSettlementTaskStartLimit({
      drainAll: false,
      availableSlots: 4,
      dispatchedTaskCount: 8,
      maxDispatchedTaskCount: 8,
    }),
    0,
  );
});

test('drainAll 单轮启动数量应只受可用并发槽位限制', () => {
  assert.equal(
    resolveOnlineBattleSettlementTaskStartLimit({
      drainAll: true,
      availableSlots: 4,
      dispatchedTaskCount: 8,
      maxDispatchedTaskCount: 8,
    }),
    4,
  );
});

test('无可用并发槽位时单轮启动数量应返回 0', () => {
  assert.equal(
    resolveOnlineBattleSettlementTaskStartLimit({
      drainAll: true,
      availableSlots: 0,
      dispatchedTaskCount: 0,
      maxDispatchedTaskCount: 8,
    }),
    0,
  );
});

test('任务级慢日志 stage 采样应按上限判断', () => {
  assert.equal(
    shouldSampleOnlineBattleSettlementTaskStage({
      sampledCount: 15,
      sampleLimit: 16,
    }),
    true,
  );
  assert.equal(
    shouldSampleOnlineBattleSettlementTaskStage({
      sampledCount: 16,
      sampleLimit: 16,
    }),
    false,
  );
  assert.equal(
    shouldSampleOnlineBattleSettlementTaskStage({
      sampledCount: 0,
      sampleLimit: 0,
    }),
    false,
  );
});

test('runner 应使用策略纯函数计算启动数量和任务级 stage 采样', () => {
  assert.match(runnerSource, /resolveOnlineBattleSettlementTaskStartLimit\(\{/u);
  assert.match(runnerSource, /shouldSampleOnlineBattleSettlementTaskStage\(\{/u);
});

test('runner 任务级慢日志 stage 应有采样上限并输出采样计数', () => {
  assert.match(
    runnerSource,
    /const ONLINE_BATTLE_SETTLEMENT_TASK_STAGE_SAMPLE_LIMIT = 16;/u,
  );
  assert.match(
    runnerSource,
    /taskStageSampleLimit: ONLINE_BATTLE_SETTLEMENT_TASK_STAGE_SAMPLE_LIMIT/u,
  );
  assert.match(
    runnerSource,
    /taskStageSampledCount/u,
  );
});

test('drainAll 显式 flush 不应被反压预算截断', () => {
  const budget = resolveOnlineBattleSettlementDispatchBudget({
    drainAll: true,
    baseMaxConcurrency: 4,
    baseMaxDispatchedTaskCount: 8,
    tickBudgetMs: 1500,
    drainTailReserveMs: 350,
    eventLoopUtilization: 1,
    eventLoopDelayP95Ms: 160,
  });

  assert.equal(budget.eventLoopBackpressured, false);
  assert.equal(budget.maxConcurrency, 4);
  assert.equal(budget.maxDispatchedTaskCount, 8);
  assert.equal(budget.dispatchBudgetMs, 1150);
});
