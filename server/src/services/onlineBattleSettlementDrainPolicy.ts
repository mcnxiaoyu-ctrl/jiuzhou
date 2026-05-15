/**
 * OnlineBattleSettlementDrainPolicy — 延迟结算 tick 分片调度策略
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：集中定义常规 tick 的事件循环反压预算，以及是否还能继续补派任务的分片规则。
 * 2. 做什么：为常规调度与测试提供同一份纯函数策略，确保线上行为与回归断言一致。
 * 3. 不做什么：不读取任务队列、不操作 Promise，也不修改任务状态。
 *
 * 输入 / 输出：
 * - 输入：事件循环快照、基础并发预算、当前是否强制 drain 全量、tick 已运行时长、已派发任务数和最大派发数。
 * - 输出：反压后的预算对象，或表示本轮 tick 是否允许继续补派新任务的布尔值。
 *
 * 数据流 / 状态流：
 * eventLoopMonitor 快照 -> resolveOnlineBattleSettlementDispatchBudget
 * -> runner.tick 根据预算计算当前启动数量、耗时、派发数和 stage 采样
 * -> true 时继续 pickRunnableTasks
 * -> false 时停止补派，仅等待已在跑任务收尾。
 *
 * 复用设计说明：
 * 1. 常规 tick 的“事件循环反压 + 分片执行”规则会同时影响调度代码和回归测试，抽成纯函数后不需要在测试里复制一套预算判断。
 * 2. 高频变化点是压力阈值和预算参数而不是 runner 主循环，因此把可变部分都收敛在本模块，后续调参不改调用方流程。
 *
 * 关键边界条件与坑点：
 * 1. `drainAll=true` 时必须始终保留基础预算并允许继续补派，否则显式 flush 会退化成和常规 tick 一样的分片语义。
 * 2. 常规 tick 命中事件循环强反压、派发截止时间或单轮派发上限任一阈值都必须停止补派；否则最后一批任务会继续挤占 HTTP 请求所在事件循环。
 */

export type OnlineBattleSettlementDispatchBudget = {
  eventLoopBackpressured: boolean;
  maxConcurrency: number;
  maxDispatchedTaskCount: number;
  dispatchBudgetMs: number;
};

const EVENT_LOOP_STRONG_BACKPRESSURE_UTILIZATION = 0.85;
const EVENT_LOOP_MEDIUM_BACKPRESSURE_UTILIZATION = 0.7;
const EVENT_LOOP_STRONG_BACKPRESSURE_P95_DELAY_MS = 80;
const EVENT_LOOP_MEDIUM_BACKPRESSURE_P95_DELAY_MS = 40;
const STRONG_BACKPRESSURE_DISPATCH_BUDGET_MS = 250;
const MEDIUM_BACKPRESSURE_DISPATCH_BUDGET_MS = 500;
const MEDIUM_BACKPRESSURE_MAX_TASK_COUNT = 2;

export const resolveOnlineBattleSettlementDispatchBudget = (params: {
  drainAll: boolean;
  baseMaxConcurrency: number;
  baseMaxDispatchedTaskCount: number;
  tickBudgetMs: number;
  drainTailReserveMs: number;
  eventLoopUtilization?: number;
  eventLoopDelayP95Ms?: number;
}): OnlineBattleSettlementDispatchBudget => {
  const baseDispatchBudgetMs = params.tickBudgetMs - params.drainTailReserveMs;
  if (params.drainAll) {
    return {
      eventLoopBackpressured: false,
      maxConcurrency: params.baseMaxConcurrency,
      maxDispatchedTaskCount: params.baseMaxDispatchedTaskCount,
      dispatchBudgetMs: baseDispatchBudgetMs,
    };
  }

  const utilization = Number(params.eventLoopUtilization ?? 0);
  const p95DelayMs = Number(params.eventLoopDelayP95Ms ?? 0);
  if (
    utilization >= EVENT_LOOP_STRONG_BACKPRESSURE_UTILIZATION
    || p95DelayMs >= EVENT_LOOP_STRONG_BACKPRESSURE_P95_DELAY_MS
  ) {
    return {
      eventLoopBackpressured: true,
      maxConcurrency: 1,
      maxDispatchedTaskCount: 1,
      dispatchBudgetMs: Math.min(baseDispatchBudgetMs, STRONG_BACKPRESSURE_DISPATCH_BUDGET_MS),
    };
  }

  if (
    utilization >= EVENT_LOOP_MEDIUM_BACKPRESSURE_UTILIZATION
    || p95DelayMs >= EVENT_LOOP_MEDIUM_BACKPRESSURE_P95_DELAY_MS
  ) {
    return {
      eventLoopBackpressured: true,
      maxConcurrency: Math.min(params.baseMaxConcurrency, MEDIUM_BACKPRESSURE_MAX_TASK_COUNT),
      maxDispatchedTaskCount: Math.min(
        params.baseMaxDispatchedTaskCount,
        MEDIUM_BACKPRESSURE_MAX_TASK_COUNT,
      ),
      dispatchBudgetMs: Math.min(baseDispatchBudgetMs, MEDIUM_BACKPRESSURE_DISPATCH_BUDGET_MS),
    };
  }

  return {
    eventLoopBackpressured: false,
    maxConcurrency: params.baseMaxConcurrency,
    maxDispatchedTaskCount: params.baseMaxDispatchedTaskCount,
    dispatchBudgetMs: baseDispatchBudgetMs,
  };
};

export const resolveOnlineBattleSettlementTaskStartLimit = (params: {
  drainAll: boolean;
  availableSlots: number;
  dispatchedTaskCount: number;
  maxDispatchedTaskCount: number;
}): number => {
  if (params.availableSlots <= 0) {
    return 0;
  }

  if (params.drainAll) {
    return params.availableSlots;
  }

  return Math.max(
    0,
    Math.min(
      params.availableSlots,
      params.maxDispatchedTaskCount - params.dispatchedTaskCount,
    ),
  );
};

export const shouldContinueOnlineBattleSettlementDispatch = (params: {
  drainAll: boolean;
  elapsedMs: number;
  dispatchedTaskCount: number;
  dispatchBudgetMs: number;
  maxDispatchedTaskCount: number;
}): boolean => {
  if (params.drainAll) {
    return true;
  }

  if (params.dispatchedTaskCount >= params.maxDispatchedTaskCount) {
    return false;
  }

  return params.elapsedMs < params.dispatchBudgetMs;
};

export const shouldSampleOnlineBattleSettlementTaskStage = (params: {
  sampledCount: number;
  sampleLimit: number;
}): boolean => {
  if (params.sampleLimit <= 0) {
    return false;
  }

  return params.sampledCount < params.sampleLimit;
};
