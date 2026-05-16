/**
 * 物品坊市超时自动下架服务
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：按固定 72 小时未售出口径扫描 active 物品挂单，并复用物品坊市下架入口返还实例与手续费。
 * 2. 做什么：用会话级 advisory lock、批量读取和逐单事务处理控制后台任务并发与锁持有范围。
 * 3. 不做什么：不处理伙伴坊市，不改写公开列表查询，也不绕过 `marketService` 自己拼装下架 SQL。
 *
 * 输入/输出：
 * - 输入：`market_listing` 中 active 且 listed_at 超过规则时长的挂单。
 * - 输出：`runCleanupOnce()` 返回本轮扫描、取消、跳过数量；`getScheduleConfig()` 返回 cleanup worker 调度配置。
 *
 * 数据流/状态流：
 * cleanupWorker -> runCleanupOnce -> advisory lock -> 按 listed_at 批量读取过期挂单 ID
 * -> marketService.cancelExpiredMarketListing -> 邮件返还与缓存失效 -> 在线角色异步刷新。
 *
 * 复用设计说明：
 * - 手动下架与自动下架共用 `marketService` 的取消入口，避免物品迁移、邮件附件、手续费退回各维护一套。
 * - 过期时长来自 `marketListingRules`，列表过滤、购买拦截和后台清理读取同一份规则。
 *
 * 关键边界条件与坑点：
 * 1. 同一轮内已尝试的挂单不会重复读取，避免异常挂单卡住当前批次。
 * 2. 这里只选择 ID，不在扫描 SQL 中搬动物品；真实状态变更必须进入逐单事务，才能与购买/手动下架共享锁顺序。
 */
import type { PoolClient } from 'pg';
import { scheduleSafeCharacterUpdate } from '../middleware/pushUpdate.js';
import { marketService } from './marketService.js';
import {
  buildMarketListingAutoCancelCutoff,
  MARKET_LISTING_AUTO_CANCEL_AFTER_HOURS,
} from './shared/marketListingRules.js';
import { withSessionAdvisoryLock } from './shared/sessionAdvisoryLock.js';

type MarketListingAutoCancelConfig = {
  intervalMs: number;
  batchSize: number;
  maxBatchesPerRun: number;
};

export type MarketListingAutoCancelScheduleConfig = {
  enabled: boolean;
  intervalMs: number;
};

export type MarketListingAutoCancelSummary = {
  scannedCount: number;
  cancelledCount: number;
  skippedCount: number;
};

type DueMarketListingRow = {
  id: number | string;
};

const MARKET_LISTING_AUTO_CANCEL_LOG_SCOPE = 'MarketListingAutoCancel';
const MARKET_LISTING_AUTO_CANCEL_LOCK_KEY_1 = 2026;
const MARKET_LISTING_AUTO_CANCEL_LOCK_KEY_2 = 516;
const DEFAULT_INTERVAL_MS = 10 * 60 * 1000;
const DEFAULT_BATCH_SIZE = 100;
const DEFAULT_MAX_BATCHES_PER_RUN = 10;

const loadMarketListingAutoCancelConfig = (): MarketListingAutoCancelConfig => ({
  intervalMs: DEFAULT_INTERVAL_MS,
  batchSize: DEFAULT_BATCH_SIZE,
  maxBatchesPerRun: DEFAULT_MAX_BATCHES_PER_RUN,
});

class MarketListingAutoCancelService {
  private readonly config: MarketListingAutoCancelConfig = loadMarketListingAutoCancelConfig();
  private inFlight = false;

  getScheduleConfig(): MarketListingAutoCancelScheduleConfig {
    return {
      enabled: true,
      intervalMs: this.config.intervalMs,
    };
  }

  getConfigSummaryText(): string {
    return `active 挂单超过 ${MARKET_LISTING_AUTO_CANCEL_AFTER_HOURS} 小时自动下架，间隔 ${Math.floor(
      this.config.intervalMs / 1000,
    )} 秒，单批 ${this.config.batchSize} 条，单轮最多 ${this.config.maxBatchesPerRun} 批`;
  }

  private async loadDueListingIds(
    client: PoolClient,
    cutoff: Date,
    attemptedListingIds: number[],
  ): Promise<number[]> {
    const result = await client.query<DueMarketListingRow>(
      `
        SELECT id
        FROM market_listing
        WHERE status = 'active'
          AND listed_at <= $1
          AND NOT (id = ANY($3::bigint[]))
        ORDER BY listed_at ASC, id ASC
        LIMIT $2
      `,
      [cutoff, this.config.batchSize, attemptedListingIds],
    );
    return result.rows.map((row) => Number(row.id));
  }

  async runCleanupOnce(): Promise<MarketListingAutoCancelSummary> {
    const emptySummary: MarketListingAutoCancelSummary = {
      scannedCount: 0,
      cancelledCount: 0,
      skippedCount: 0,
    };
    if (this.inFlight) return emptySummary;
    this.inFlight = true;

    try {
      const execution = await withSessionAdvisoryLock(
        MARKET_LISTING_AUTO_CANCEL_LOCK_KEY_1,
        MARKET_LISTING_AUTO_CANCEL_LOCK_KEY_2,
        async (client) => {
          const now = new Date();
          const cutoff = buildMarketListingAutoCancelCutoff(now);
          const attemptedListingIds: number[] = [];
          const summary: MarketListingAutoCancelSummary = {
            scannedCount: 0,
            cancelledCount: 0,
            skippedCount: 0,
          };

          for (let batchNo = 0; batchNo < this.config.maxBatchesPerRun; batchNo += 1) {
            const listingIds = await this.loadDueListingIds(client, cutoff, attemptedListingIds);
            if (listingIds.length <= 0) break;
            summary.scannedCount += listingIds.length;

            for (const listingId of listingIds) {
              attemptedListingIds.push(listingId);
              const cancelResult = await marketService.cancelExpiredMarketListing({
                listingId,
                now,
              });
              if (cancelResult.success) {
                summary.cancelledCount += 1;
                scheduleSafeCharacterUpdate(cancelResult.sellerUserId);
              } else {
                summary.skippedCount += 1;
              }
            }

            if (listingIds.length < this.config.batchSize) break;
          }

          if (summary.cancelledCount > 0 || summary.skippedCount > 0) {
            console.log(
              `[${MARKET_LISTING_AUTO_CANCEL_LOG_SCOPE}] 本轮处理过期物品挂单 ${summary.scannedCount} 条，自动下架 ${summary.cancelledCount} 条，跳过 ${summary.skippedCount} 条`,
            );
          }

          return summary;
        },
      );

      if (!execution.acquired) {
        return emptySummary;
      }

      return execution.result ?? emptySummary;
    } catch (error) {
      console.error(`[${MARKET_LISTING_AUTO_CANCEL_LOG_SCOPE}] 清理失败:`, error);
      return emptySummary;
    } finally {
      this.inFlight = false;
    }
  }
}

export const marketListingAutoCancelService = new MarketListingAutoCancelService();
