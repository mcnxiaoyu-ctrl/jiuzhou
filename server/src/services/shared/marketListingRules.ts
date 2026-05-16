/**
 * 物品坊市上架规则模块
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：集中维护物品坊市每日上架次数、同时在售数量、自动下架时长等硬规则。
 * 2. 做什么：提供过期时间计算与过期判断，避免服务层、清理任务和静态测试各自维护魔法数字。
 * 3. 不做什么：不读写数据库，不处理路由参数，也不决定物品是否可交易。
 *
 * 输入/输出：
 * - 输入：挂单 listedAt 与当前 now。
 * - 输出：上架限制常量、过期截止时间、过期布尔值。
 *
 * 数据流/状态流：
 * - createMarketListing 读取每日/同时上架上限；
 * - 列表与购买链路读取自动下架时长过滤过期 active 挂单；
 * - cleanupWorker 读取同一时长批量取消过期挂单。
 *
 * 复用设计说明：
 * - 上架规则属于高频业务变化点，放在单一模块后，服务校验、SQL 过滤和清理任务不会重复散落数字。
 * - 当前被 `marketService`、`marketListingAutoCancelService` 与规则静态测试复用。
 *
 * 关键边界条件与坑点：
 * 1. “每日”口径由调用方使用上海自然日工具生成窗口，本模块只维护次数上限，避免时区职责混在一起。
 * 2. 过期判断使用毫秒差值，必须和 SQL 中 `INTERVAL '1 hour'` 的小时数常量保持同源。
 */

export const MARKET_LISTING_DAILY_CREATE_LIMIT = 100;
export const MARKET_LISTING_ACTIVE_LIMIT = 30;
export const MARKET_LISTING_AUTO_CANCEL_AFTER_HOURS = 72;

const MARKET_LISTING_AUTO_CANCEL_AFTER_MS =
  MARKET_LISTING_AUTO_CANCEL_AFTER_HOURS * 60 * 60 * 1000;

export const buildMarketListingAutoCancelCutoff = (now: Date): Date => {
  return new Date(now.getTime() - MARKET_LISTING_AUTO_CANCEL_AFTER_MS);
};

export const isMarketListingExpired = (
  listedAt: Date,
  now: Date,
): boolean => {
  return listedAt.getTime() <= buildMarketListingAutoCancelCutoff(now).getTime();
};
