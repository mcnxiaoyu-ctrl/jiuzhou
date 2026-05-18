/**
 * 股市 30 分钟行情调度器。
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：在后台调度角色中按 30 分钟边界触发股市 AI 新闻与行情 tick。
 * 2. 不做什么：不实现 AI prompt、不拼交易 SQL、不接入 cleanupWorker。
 *
 * 输入 / 输出：
 * - 输入：启动流水线调用的 initialize/stop。
 * - 输出：定时触发 `stockMarketService.runScheduledTick`，并记录日志。
 *
 * 数据流 / 状态流：
 * startupPipeline -> initializeStockMarketScheduler -> setTimeout 到下一周期边界 -> runScheduledTick -> 重新安排下一轮。
 *
 * 复用设计说明：
 * - 调度生命周期和排行夜间刷新保持同一模式，启动、互斥、停止都在一个模块中收敛。
 * - 周期边界计算复用 `stockMarketTime`，概览倒计时和后台触发不会各自计算。
 *
 * 关键边界条件与坑点：
 * 1. 不能使用固定 setInterval，否则服务重启或执行耗时会让 30 分钟 tick 逐渐漂移。
 * 2. 停止后必须清理 timeout，避免 worker 角色优雅关闭时残留后台句柄。
 */
import { stockMarketService } from './stockMarketService.js';
import { getStockMarketRefreshDelayMs } from './stockMarketTime.js';

let timer: NodeJS.Timeout | null = null;
let initialized = false;
let inFlight = false;

const clearScheduledTimer = (): void => {
  if (!timer) return;
  clearTimeout(timer);
  timer = null;
};

const scheduleNextRun = (now: Date = new Date()): void => {
  clearScheduledTimer();
  timer = setTimeout(() => {
    void runScheduledStockMarketTick();
  }, getStockMarketRefreshDelayMs(now));
};

const runScheduledStockMarketTick = async (): Promise<void> => {
  if (!initialized || inFlight) return;

  inFlight = true;
  try {
    console.log('[StockMarketScheduler] 开始生成股市新闻与行情');
    const result = await stockMarketService.runScheduledTick(new Date());
    console.log(`[StockMarketScheduler] ${result.message}`);
  } catch (error) {
    console.error('[StockMarketScheduler] 股市行情执行失败:', error);
  } finally {
    inFlight = false;
    if (initialized) {
      scheduleNextRun(new Date());
    }
  }
};

export const initializeStockMarketScheduler = async (): Promise<void> => {
  if (initialized) return;
  initialized = true;
  await stockMarketService.ensureInitialQuotes();
  scheduleNextRun(new Date());
};

export const stopStockMarketScheduler = (): void => {
  initialized = false;
  inFlight = false;
  clearScheduledTimer();
};
