/**
 * EventLoopMonitorService — 事件循环健康度监控
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：周期采样事件循环利用率与延迟分位值，统一输出主线程拥塞告警，并向 HTTP 慢请求等链路提供最近一次健康快照。
 * 2. 做什么：把监控的启动、停止、快照读取集中到单一服务，避免 app、中间件、后台任务各自重复创建 `monitorEventLoopDelay`。
 * 3. 不做什么：不拦截请求，不保存历史时序数据，不额外引入外部监控系统。
 *
 * 输入 / 输出：
 * - 输入：服务启动时调用 `initializeEventLoopMonitor()`，服务关闭时调用 `stopEventLoopMonitor()`。
 * - 输出：`getLatestEventLoopHealthSnapshot()` 返回最近一次采样结果；超过阈值时输出结构化 warn 日志。
 *
 * 数据流 / 状态流：
 * startupPipeline -> initializeEventLoopMonitor
 * -> 定时采样 event loop utilization + delay histogram
 * -> 更新 latest snapshot / 必要时输出告警
 * -> HTTP 慢请求与其他诊断链路读取最近快照辅助定位。
 *
 * 复用设计说明：
 * 1. 事件循环压力属于全局运行时状态，最适合放在单一服务里集中采样，避免多个调用点各自启一个 histogram 造成监控口径漂移。
 * 2. 慢请求日志和后续 battle 诊断都只读同一份最新快照，减少重复系统调用，也避免不同模块各自解释 ELU 阈值。
 *
 * 关键边界条件与坑点：
 * 1. `performance.eventLoopUtilization` 必须按“当前值、上一基线”做差分，不能直接把累计值当成本轮采样结果。
 * 2. histogram 采样后必须 reset，否则延迟分位数会越积越大，失去“最近窗口”诊断意义。
 */

import {
  monitorEventLoopDelay,
  performance,
  type EventLoopUtilization,
} from 'node:perf_hooks';

import { createScopedLogger } from '../utils/logger.js';

export type EventLoopHealthSnapshot = {
  sampledAt: number;
  sampleIntervalMs: number;
  utilization: number;
  activeMs: number;
  idleMs: number;
  minDelayMs: number;
  meanDelayMs: number;
  p95DelayMs: number;
  maxDelayMs: number;
};

const EVENT_LOOP_MONITOR_SAMPLE_INTERVAL_MS = 2_000;
const EVENT_LOOP_MONITOR_RESOLUTION_MS = 20;
const EVENT_LOOP_UTILIZATION_WARN_THRESHOLD = 0.7;
const EVENT_LOOP_DELAY_P95_WARN_THRESHOLD_MS = 40;
const EVENT_LOOP_DELAY_MAX_WARN_THRESHOLD_MS = 100;

const eventLoopMonitorLogger = createScopedLogger('event-loop.monitor');

let eventLoopDelayHistogram: ReturnType<typeof monitorEventLoopDelay> | null = null;
let eventLoopMonitorTimer: ReturnType<typeof setInterval> | null = null;
let previousEventLoopUtilization: EventLoopUtilization | null = null;
let latestEventLoopHealthSnapshot: EventLoopHealthSnapshot | null = null;

const roundMetric = (value: number): number => {
  if (!Number.isFinite(value) || value < 0) {
    return 0;
  }
  return Math.round(value * 100) / 100;
};

const nanosecondsToMilliseconds = (value: number): number => {
  if (!Number.isFinite(value) || value < 0) {
    return 0;
  }
  return roundMetric(value / 1_000_000);
};

const sampleEventLoopHealth = (): EventLoopHealthSnapshot | null => {
  if (!eventLoopDelayHistogram || !previousEventLoopUtilization) {
    return null;
  }

  const currentEventLoopUtilization = performance.eventLoopUtilization();
  const deltaEventLoopUtilization = performance.eventLoopUtilization(
    currentEventLoopUtilization,
    previousEventLoopUtilization,
  );
  previousEventLoopUtilization = currentEventLoopUtilization;

  const snapshot: EventLoopHealthSnapshot = {
    sampledAt: Date.now(),
    sampleIntervalMs: EVENT_LOOP_MONITOR_SAMPLE_INTERVAL_MS,
    utilization: roundMetric(deltaEventLoopUtilization.utilization),
    activeMs: roundMetric(deltaEventLoopUtilization.active),
    idleMs: roundMetric(deltaEventLoopUtilization.idle),
    minDelayMs: nanosecondsToMilliseconds(eventLoopDelayHistogram.min),
    meanDelayMs: nanosecondsToMilliseconds(eventLoopDelayHistogram.mean),
    p95DelayMs: nanosecondsToMilliseconds(eventLoopDelayHistogram.percentile(95)),
    maxDelayMs: nanosecondsToMilliseconds(eventLoopDelayHistogram.max),
  };

  eventLoopDelayHistogram.reset();
  latestEventLoopHealthSnapshot = snapshot;
  return snapshot;
};

const shouldWarnForEventLoopHealth = (
  snapshot: EventLoopHealthSnapshot,
): boolean => {
  return snapshot.utilization >= EVENT_LOOP_UTILIZATION_WARN_THRESHOLD
    || snapshot.p95DelayMs >= EVENT_LOOP_DELAY_P95_WARN_THRESHOLD_MS
    || snapshot.maxDelayMs >= EVENT_LOOP_DELAY_MAX_WARN_THRESHOLD_MS;
};

export const getLatestEventLoopHealthSnapshot = (): EventLoopHealthSnapshot | null => {
  return latestEventLoopHealthSnapshot;
};

export const initializeEventLoopMonitor = async (): Promise<void> => {
  if (eventLoopMonitorTimer) {
    return;
  }

  eventLoopDelayHistogram = monitorEventLoopDelay({
    resolution: EVENT_LOOP_MONITOR_RESOLUTION_MS,
  });
  eventLoopDelayHistogram.enable();
  previousEventLoopUtilization = performance.eventLoopUtilization();

  eventLoopMonitorTimer = setInterval(() => {
    const snapshot = sampleEventLoopHealth();
    if (!snapshot || !shouldWarnForEventLoopHealth(snapshot)) {
      return;
    }

    eventLoopMonitorLogger.warn({
      kind: 'event_loop_busy',
      ...snapshot,
      utilizationWarnThreshold: EVENT_LOOP_UTILIZATION_WARN_THRESHOLD,
      p95DelayWarnThresholdMs: EVENT_LOOP_DELAY_P95_WARN_THRESHOLD_MS,
      maxDelayWarnThresholdMs: EVENT_LOOP_DELAY_MAX_WARN_THRESHOLD_MS,
    }, 'event loop busy');
  }, EVENT_LOOP_MONITOR_SAMPLE_INTERVAL_MS);
  eventLoopMonitorTimer.unref();

  eventLoopMonitorLogger.info({
    sampleIntervalMs: EVENT_LOOP_MONITOR_SAMPLE_INTERVAL_MS,
    resolutionMs: EVENT_LOOP_MONITOR_RESOLUTION_MS,
  }, 'event loop monitor started');
};

export const stopEventLoopMonitor = (): void => {
  if (eventLoopMonitorTimer) {
    clearInterval(eventLoopMonitorTimer);
    eventLoopMonitorTimer = null;
  }

  if (eventLoopDelayHistogram) {
    eventLoopDelayHistogram.disable();
    eventLoopDelayHistogram = null;
  }

  previousEventLoopUtilization = null;
  latestEventLoopHealthSnapshot = null;
};
