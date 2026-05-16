/**
 * 物品坊市自动下架启动补偿服务
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：worker 启动时一次性补偿 active 历史挂单，确保部署前或 RabbitMQ 短暂不可用期间的挂单也有自动下架路径。
 * 2. 做什么：过期挂单立即复用 `marketService.cancelExpiredMarketListing` 下架；未过期挂单按剩余时间补发 RabbitMQ 延迟消息。
 * 3. 不做什么：不注册定时器，不替代上架实时投递，不把失败消息写入数据库死信表。
 *
 * 输入 / 输出：
 * - 输入：`market_listing` 中当前 active 的物品挂单，以及 RabbitMQ 队列启停配置。
 * - 输出：启动补偿统计；副作用是取消已过期挂单或补发未过期挂单的延迟消息。
 *
 * 数据流 / 状态流：
 * worker 启动 -> advisory lock -> keyset 批量读取启动快照内的 active 挂单 -> 计算 expireAt
 * -> 已过期调用 marketService 自动下架 -> 未过期 publish delayMs 消息 -> 释放 advisory lock。
 *
 * 复用设计说明：
 * - 下架逻辑继续复用 marketService，避免启动补偿单独维护物品迁移、邮件返还和手续费退回。
 * - RabbitMQ 发布继续复用 shared queue，实时上架和启动补偿共用一套拓扑、消息体和 confirm 规则。
 *
 * 关键边界条件与坑点：
 * 1. 启动补偿必须使用 advisory lock，避免 all/worker 多进程或重启重叠时并发补偿同一批挂单。
 * 2. 未过期历史挂单必须按 `expireAt - now` 发布剩余延迟，不能重新延迟完整 72 小时。
 * 3. 查询必须按 `listed_at ASC, id ASC` keyset 批处理，并限制在启动快照内，避免补偿长时间运行时重复处理新上架数据。
 */
import type { PoolClient } from 'pg';
import { scheduleSafeCharacterUpdate } from '../middleware/pushUpdate.js';
import { createScopedLogger } from '../utils/logger.js';
import { marketService } from './marketService.js';
import {
  isMarketListingAutoCancelQueueEnabled,
  publishMarketListingAutoCancelMessage,
} from './shared/marketListingAutoCancelQueue.js';
import { MARKET_LISTING_AUTO_CANCEL_AFTER_HOURS } from './shared/marketListingRules.js';
import { withSessionAdvisoryLock } from './shared/sessionAdvisoryLock.js';

type MarketListingAutoCancelReconcileRow = {
  id: number | string;
  listed_at: Date | string;
};

type MarketListingAutoCancelReconcileCursor = {
  listedAt: Date;
  listingId: number;
};

export type MarketListingAutoCancelStartupReconcileSummary = {
  enabled: boolean;
  lockAcquired: boolean;
  scannedCount: number;
  cancelledCount: number;
  publishedCount: number;
  skippedCount: number;
};

type MarketListingAutoCancelReconcileOutcome =
  | 'cancelled'
  | 'published'
  | 'skipped';

const MARKET_LISTING_AUTO_CANCEL_RECONCILE_LOCK_KEY_1 = 2026;
const MARKET_LISTING_AUTO_CANCEL_RECONCILE_LOCK_KEY_2 = 517;
const MARKET_LISTING_AUTO_CANCEL_RECONCILE_BATCH_SIZE = 200;
const MARKET_LISTING_AUTO_CANCEL_AFTER_MS =
  MARKET_LISTING_AUTO_CANCEL_AFTER_HOURS * 60 * 60 * 1000;

const logger = createScopedLogger('market.listing.autoCancelReconcile');

const buildStartupReconcileSummary = (
  params: Pick<MarketListingAutoCancelStartupReconcileSummary, 'enabled' | 'lockAcquired'>,
): MarketListingAutoCancelStartupReconcileSummary => ({
  enabled: params.enabled,
  lockAcquired: params.lockAcquired,
  scannedCount: 0,
  cancelledCount: 0,
  publishedCount: 0,
  skippedCount: 0,
});

const toListingDate = (value: Date | string): Date | null => {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
};

const resolveExpireAt = (listedAt: Date): Date => {
  return new Date(listedAt.getTime() + MARKET_LISTING_AUTO_CANCEL_AFTER_MS);
};

const resolveStartupReconcileDelayMs = (expireAt: Date, now: Date): number => {
  const remainingMs = expireAt.getTime() - now.getTime();
  return Math.min(MARKET_LISTING_AUTO_CANCEL_AFTER_MS, Math.max(1, remainingMs));
};

class MarketListingAutoCancelReconcileService {
  private async loadActiveListingRows(
    client: PoolClient,
    cursor: MarketListingAutoCancelReconcileCursor | null,
    snapshotUpperBound: Date,
  ): Promise<MarketListingAutoCancelReconcileRow[]> {
    const result = await client.query<MarketListingAutoCancelReconcileRow>(
      `
        SELECT id, listed_at
        FROM market_listing
        WHERE status = 'active'
          AND listed_at <= $3::timestamptz
          AND (
            $1::timestamptz IS NULL
            OR (listed_at, id) > ($1::timestamptz, $2::bigint)
          )
        ORDER BY listed_at ASC, id ASC
        LIMIT $4
      `,
      [
        cursor?.listedAt ?? null,
        cursor?.listingId ?? 0,
        snapshotUpperBound,
        MARKET_LISTING_AUTO_CANCEL_RECONCILE_BATCH_SIZE,
      ],
    );
    return result.rows;
  }

  private resolveCursor(
    row: MarketListingAutoCancelReconcileRow,
  ): MarketListingAutoCancelReconcileCursor | null {
    const listedAt = toListingDate(row.listed_at);
    const listingId = Number(row.id);
    if (!listedAt || !Number.isInteger(listingId) || listingId <= 0) {
      return null;
    }
    return {
      listedAt,
      listingId,
    };
  }

  private async processListingRow(
    row: MarketListingAutoCancelReconcileRow,
    now: Date,
  ): Promise<MarketListingAutoCancelReconcileOutcome> {
    const listingId = Number(row.id);
    const listedAt = toListingDate(row.listed_at);
    if (!listedAt || !Number.isInteger(listingId) || listingId <= 0) {
      return 'skipped';
    }

    const expireAt = resolveExpireAt(listedAt);
    if (expireAt.getTime() <= now.getTime()) {
      const result = await marketService.cancelExpiredMarketListing({
        listingId,
        now,
      });
      if (result.success) {
        scheduleSafeCharacterUpdate(result.sellerUserId);
        return 'cancelled';
      }
      logger.warn(
        {
          listingId,
          reason: result.message,
        },
        '启动补偿跳过无法自动下架的历史挂单',
      );
      return 'skipped';
    }

    await publishMarketListingAutoCancelMessage({
      listingId,
      listedAt,
      delayMs: resolveStartupReconcileDelayMs(expireAt, now),
    });
    return 'published';
  }

  private async runLockedReconcile(
    client: PoolClient,
    now: Date,
  ): Promise<MarketListingAutoCancelStartupReconcileSummary> {
    const summary = buildStartupReconcileSummary({
      enabled: true,
      lockAcquired: true,
    });
    let cursor: MarketListingAutoCancelReconcileCursor | null = null;

    for (;;) {
      const rows = await this.loadActiveListingRows(client, cursor, now);
      if (rows.length <= 0) {
        break;
      }

      for (const row of rows) {
        const nextCursor = this.resolveCursor(row);
        if (nextCursor) {
          cursor = nextCursor;
        }

        summary.scannedCount += 1;
        const outcome = await this.processListingRow(row, now);
        if (outcome === 'cancelled') {
          summary.cancelledCount += 1;
        } else if (outcome === 'published') {
          summary.publishedCount += 1;
        } else {
          summary.skippedCount += 1;
        }
      }

      if (rows.length < MARKET_LISTING_AUTO_CANCEL_RECONCILE_BATCH_SIZE) {
        break;
      }
    }

    return summary;
  }

  async runStartupReconcileOnce(): Promise<MarketListingAutoCancelStartupReconcileSummary> {
    if (!isMarketListingAutoCancelQueueEnabled()) {
      logger.info('坊市自动下架 RabbitMQ 队列未启用，已跳过启动补偿');
      return buildStartupReconcileSummary({
        enabled: false,
        lockAcquired: false,
      });
    }

    const execution = await withSessionAdvisoryLock(
      MARKET_LISTING_AUTO_CANCEL_RECONCILE_LOCK_KEY_1,
      MARKET_LISTING_AUTO_CANCEL_RECONCILE_LOCK_KEY_2,
      async (client) => this.runLockedReconcile(client, new Date()),
    );

    if (!execution.acquired) {
      logger.info('其他进程正在执行坊市自动下架启动补偿，本进程已跳过');
      return buildStartupReconcileSummary({
        enabled: true,
        lockAcquired: false,
      });
    }

    const summary = execution.result ?? buildStartupReconcileSummary({
      enabled: true,
      lockAcquired: true,
    });
    logger.info(
      {
        scannedCount: summary.scannedCount,
        cancelledCount: summary.cancelledCount,
        publishedCount: summary.publishedCount,
        skippedCount: summary.skippedCount,
      },
      '坊市自动下架启动补偿完成',
    );
    return summary;
  }
}

export const marketListingAutoCancelReconcileService =
  new MarketListingAutoCancelReconcileService();
