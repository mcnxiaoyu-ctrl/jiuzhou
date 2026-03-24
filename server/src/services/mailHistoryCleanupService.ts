import type { PoolClient } from 'pg';
import {
  parseScheduledCleanupBooleanEnv,
  parseScheduledCleanupIntegerEnv,
} from './shared/scheduledCleanupConfig.js';
import { withSessionAdvisoryLock } from './shared/sessionAdvisoryLock.js';

/**
 * 邮件热表生命周期清理服务（仅负责清理逻辑，不负责定时调度）
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：按保留天数物理删除已经离开热生命周期的邮件，控制 `mail` 热表体积持续增长。
 * 2. 做什么：统一处理两类历史邮件：已软删超过保留期的邮件、已过期超过保留期且尚未软删的邮件。
 * 3. 不做什么：不做归档，不修改 `mail_counter` 热统计，也不在这里负责启动/停止定时器。
 *
 * 输入/输出：
 * - 输入：环境变量（是否启用、保留天数、调度间隔、单批删除量、单轮最大批次数）。
 * - 输出：`runCleanupOnce()` 返回本轮删除的总行数；`getScheduleConfig()` 返回 cleanup worker 需要的调度配置。
 *
 * 数据流/状态流：
 * cleanupWorker -> getScheduleConfig -> runCleanupOnce
 * -> advisory lock -> 分批删除历史邮件 -> 返回本轮删除统计。
 *
 * 关键边界条件与坑点：
 * 1. 这里只删热表里已经脱离可见范围的历史邮件，未过期且未删除的活跃邮件绝不能进入清理候选。
 * 2. 清理必须分批进行并限制单轮批次数，否则在高量级邮件场景下，单次 DELETE 过大会放大 WAL 和锁持有时间。
 */

type MailHistoryCleanupConfig = {
  enabled: boolean;
  retentionDays: number;
  intervalMs: number;
  deleteBatchSize: number;
  maxDeleteBatchesPerRun: number;
};

export type MailHistoryCleanupScheduleConfig = {
  enabled: boolean;
  intervalMs: number;
};

const MAIL_HISTORY_CLEANUP_LOG_SCOPE = 'MailHistoryCleanup';
const MAIL_HISTORY_CLEANUP_LOCK_KEY_1 = 2026;
const MAIL_HISTORY_CLEANUP_LOCK_KEY_2 = 312;
const DEFAULT_RETENTION_DAYS = 7;
const DEFAULT_INTERVAL_SECONDS = 600;
const DEFAULT_DELETE_BATCH_SIZE = 5_000;
const DEFAULT_MAX_DELETE_BATCHES_PER_RUN = 20;

const MAIL_SOFT_DELETED_CLEANUP_SQL = `
  WITH stale_mail AS (
    SELECT id
    FROM mail
    WHERE deleted_at IS NOT NULL
      AND deleted_at < NOW() - ($1::int * INTERVAL '1 day')
    ORDER BY deleted_at ASC, id ASC
    LIMIT $2
  )
  DELETE FROM mail
  WHERE id IN (SELECT id FROM stale_mail)
`;

const MAIL_EXPIRED_HISTORY_CLEANUP_SQL = `
  WITH stale_mail AS (
    SELECT id
    FROM mail
    WHERE deleted_at IS NULL
      AND expire_at IS NOT NULL
      AND expire_at < NOW() - ($1::int * INTERVAL '1 day')
    ORDER BY expire_at ASC, id ASC
    LIMIT $2
  )
  DELETE FROM mail
  WHERE id IN (SELECT id FROM stale_mail)
`;

const loadMailHistoryCleanupConfig = (): MailHistoryCleanupConfig => {
  const enabled = parseScheduledCleanupBooleanEnv(
    'MAIL_HISTORY_CLEANUP_ENABLED',
    true,
    MAIL_HISTORY_CLEANUP_LOG_SCOPE,
  );
  const retentionDays = parseScheduledCleanupIntegerEnv(
    'MAIL_HISTORY_RETENTION_DAYS',
    DEFAULT_RETENTION_DAYS,
    1,
    365,
    MAIL_HISTORY_CLEANUP_LOG_SCOPE,
  );
  const intervalSeconds = parseScheduledCleanupIntegerEnv(
    'MAIL_HISTORY_CLEANUP_INTERVAL_SECONDS',
    DEFAULT_INTERVAL_SECONDS,
    60,
    86_400,
    MAIL_HISTORY_CLEANUP_LOG_SCOPE,
  );
  const deleteBatchSize = parseScheduledCleanupIntegerEnv(
    'MAIL_HISTORY_CLEANUP_DELETE_BATCH_SIZE',
    DEFAULT_DELETE_BATCH_SIZE,
    100,
    50_000,
    MAIL_HISTORY_CLEANUP_LOG_SCOPE,
  );
  const maxDeleteBatchesPerRun = parseScheduledCleanupIntegerEnv(
    'MAIL_HISTORY_CLEANUP_MAX_BATCHES_PER_RUN',
    DEFAULT_MAX_DELETE_BATCHES_PER_RUN,
    1,
    200,
    MAIL_HISTORY_CLEANUP_LOG_SCOPE,
  );

  return {
    enabled,
    retentionDays,
    intervalMs: intervalSeconds * 1000,
    deleteBatchSize,
    maxDeleteBatchesPerRun,
  };
};

class MailHistoryCleanupService {
  private readonly config: MailHistoryCleanupConfig = loadMailHistoryCleanupConfig();
  private inFlight = false;

  getScheduleConfig(): MailHistoryCleanupScheduleConfig {
    return {
      enabled: this.config.enabled,
      intervalMs: this.config.intervalMs,
    };
  }

  getConfigSummaryText(): string {
    return `保留 ${this.config.retentionDays} 天，间隔 ${Math.floor(
      this.config.intervalMs / 1000,
    )} 秒，单批 ${this.config.deleteBatchSize} 条，单轮最多 ${this.config.maxDeleteBatchesPerRun} 批`;
  }

  private async deleteStaleMailOnce(client: PoolClient, sql: string): Promise<number> {
    const result = await client.query(sql, [
      this.config.retentionDays,
      this.config.deleteBatchSize,
    ]);
    return result.rowCount ?? 0;
  }

  async runCleanupOnce(): Promise<number> {
    if (!this.config.enabled) return 0;
    if (this.inFlight) return 0;
    this.inFlight = true;

    try {
      const execution = await withSessionAdvisoryLock(
        MAIL_HISTORY_CLEANUP_LOCK_KEY_1,
        MAIL_HISTORY_CLEANUP_LOCK_KEY_2,
        async (client) => {
          let totalDeleted = 0;
          for (let batchNo = 0; batchNo < this.config.maxDeleteBatchesPerRun; batchNo += 1) {
            const deletedSoftDeletedCount = await this.deleteStaleMailOnce(client, MAIL_SOFT_DELETED_CLEANUP_SQL);
            totalDeleted += deletedSoftDeletedCount;
            if (deletedSoftDeletedCount >= this.config.deleteBatchSize) {
              continue;
            }

            const deletedExpiredCount = await this.deleteStaleMailOnce(client, MAIL_EXPIRED_HISTORY_CLEANUP_SQL);
            totalDeleted += deletedExpiredCount;
            if (deletedExpiredCount < this.config.deleteBatchSize) {
              break;
            }
          }

          if (totalDeleted > 0) {
            console.log(
              `[${MAIL_HISTORY_CLEANUP_LOG_SCOPE}] 本轮清理完成：删除 ${totalDeleted} 条历史邮件（保留 ${this.config.retentionDays} 天内数据）`,
            );
          }

          return totalDeleted;
        },
      );

      if (!execution.acquired) {
        return 0;
      }

      return execution.result ?? 0;
    } catch (error) {
      console.error(`[${MAIL_HISTORY_CLEANUP_LOG_SCOPE}] 清理失败:`, error);
      return 0;
    } finally {
      this.inFlight = false;
    }
  }
}

export const mailHistoryCleanupService = new MailHistoryCleanupService();
