/**
 * 股市行情周期时间工具。
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：统一计算股市 30 分钟 tick、下一次刷新时间和调度延迟。
 * 2. 不做什么：不启动定时器、不访问数据库、不处理 AI 新闻。
 *
 * 输入 / 输出：
 * - 输入：任意 `Date`。
 * - 输出：当前 30 分钟边界、下一次 30 分钟边界和毫秒延迟。
 *
 * 数据流 / 状态流：
 * scheduler / overview -> 本模块计算周期边界 -> tick 表唯一键与前端倒计时复用。
 *
 * 复用设计说明：
 * - 调度器和概览接口都需要“下一次刷新”口径，集中到这里避免前端显示和后台实际触发时间漂移。
 * - 30 分钟 tick 是股市幂等核心键，统一 floor 规则后不会出现同一周期多种 key。
 *
 * 关键边界条件与坑点：
 * 1. 使用 UTC 毫秒时间戳按周期取整作为数据库唯一键，避免服务器本地时区变化影响幂等。
 * 2. 当前时间刚好落在周期边界时，下一次刷新必须是下一个周期，不重复返回当前周期。
 */
import { STOCK_MARKET_TICK_INTERVAL_MS } from './stockMarketRules.js';

export const floorStockMarketTickTime = (date: Date): Date => {
  const tickTime = Math.floor(date.getTime() / STOCK_MARKET_TICK_INTERVAL_MS) * STOCK_MARKET_TICK_INTERVAL_MS;
  return new Date(tickTime);
};

export const getNextStockMarketRefreshAt = (date: Date = new Date()): Date => {
  const currentTick = floorStockMarketTickTime(date);
  const nextTick = new Date(currentTick.getTime() + STOCK_MARKET_TICK_INTERVAL_MS);
  return nextTick.getTime() <= date.getTime()
    ? new Date(nextTick.getTime() + STOCK_MARKET_TICK_INTERVAL_MS)
    : nextTick;
};

export const getStockMarketRefreshDelayMs = (date: Date = new Date()): number => {
  return Math.max(0, getNextStockMarketRefreshAt(date).getTime() - date.getTime());
};
