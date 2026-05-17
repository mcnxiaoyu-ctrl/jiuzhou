/**
 * 股市整点时间工具。
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：统一计算股市小时 tick、下一次刷新时间和调度延迟。
 * 2. 不做什么：不启动定时器、不访问数据库、不处理 AI 新闻。
 *
 * 输入 / 输出：
 * - 输入：任意 `Date`。
 * - 输出：当前小时整点、下一小时整点和毫秒延迟。
 *
 * 数据流 / 状态流：
 * scheduler / overview -> 本模块计算整点时间 -> tick 表唯一键与前端倒计时复用。
 *
 * 复用设计说明：
 * - 调度器和概览接口都需要“下一次整点”口径，集中到这里避免前端显示和后台实际触发时间漂移。
 * - 小时 tick 是股市幂等核心键，统一 floor 规则后不会出现同一小时多种 key。
 *
 * 关键边界条件与坑点：
 * 1. 使用 UTC 小时整点作为数据库唯一键，避免服务器本地时区变化影响幂等。
 * 2. 当前时间刚好落在整点时，下一次刷新必须是下一小时，不重复返回当前小时。
 */
import { STOCK_MARKET_TICK_INTERVAL_MS } from './stockMarketRules.js';

export const floorStockMarketTickHour = (date: Date): Date => {
  const tick = new Date(date);
  tick.setUTCMinutes(0, 0, 0);
  return tick;
};

export const getNextStockMarketRefreshAt = (date: Date = new Date()): Date => {
  const currentHour = floorStockMarketTickHour(date);
  const nextHour = new Date(currentHour.getTime() + STOCK_MARKET_TICK_INTERVAL_MS);
  return nextHour.getTime() <= date.getTime()
    ? new Date(nextHour.getTime() + STOCK_MARKET_TICK_INTERVAL_MS)
    : nextHour;
};

export const getStockMarketRefreshDelayMs = (date: Date = new Date()): number => {
  return Math.max(0, getNextStockMarketRefreshAt(date).getTime() - date.getTime());
};
