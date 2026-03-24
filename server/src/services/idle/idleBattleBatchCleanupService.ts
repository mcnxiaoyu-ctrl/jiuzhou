import type { PoolClient } from 'pg';
import {
  parseScheduledCleanupBooleanEnv,
  parseScheduledCleanupIntegerEnv,
} from '../shared/scheduledCleanupConfig.js';
import { withSessionAdvisoryLock } from '../shared/sessionAdvisoryLock.js';

/**
 * idle_battle_batches 清理服务（仅负责清理逻辑，不负责定时调度）
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：按保留天数清理 idle_battle_batches 的过期战斗批次，控制表体积增长。
 * 2. 做什么：仅清理已结束会话（completed/interrupted）关联的批次，避免影响活跃挂机会话。
 * 3. 不做什么：不创建 setInterval，不管理线程生命周期；调度统一交给 cleanupWorker。
 *
 * 输入/输出：
 * - 输入：环境变量（是否启用、保留天数、调度间隔、单批删除量、单轮最大批次数）。
 * - 输出：runCleanupOnce 返回本轮删除条数；getScheduleConfig 返回调度配置。
 *
 * 数据流/状态流：
 * cleanupWorker -> getScheduleConfig -> runCleanupOnce
 * -> advisory lock -> 分批 DELETE idle_battle_batches -> 返回删除统计
 *
 * 关键边界条件与坑点：
 * 1. 多实例部署使用 pg_try_advisory_lock，避免多个实例并发清理同一批数据。
 * 2. 单轮清理采用“单批上限 + 最大批次数”限制，避免单次事务过大导致锁等待/WAL 激增。
 */

type IdleCleanupConfig = {
  enabled: boolean;
  retentionDays: number;
  intervalMs: number;
  deleteBatchSize: number;
  maxDeleteBatchesPerRun: number;
};

export type IdleBattleBatchCleanupScheduleConfig = {
  enabled: boolean;
  intervalMs: number;
};

const IDLE_FINISHED_SESSION_STATUSES = ['completed', 'interrupted'] as const;
const IDLE_CLEANUP_LOCK_KEY_1 = 2026;
const IDLE_CLEANUP_LOCK_KEY_2 = 311;
const DEFAULT_RETENTION_DAYS = 7;
const DEFAULT_INTERVAL_SECONDS = 600;
const DEFAULT_DELETE_BATCH_SIZE = 5_000;
const DEFAULT_MAX_DELETE_BATCHES_PER_RUN = 20;

function loadIdleCleanupConfig(): IdleCleanupConfig {
  const enabled = parseScheduledCleanupBooleanEnv('IDLE_BATCH_CLEANUP_ENABLED', true, 'IdleBatchCleanup');
  const retentionDays = parseScheduledCleanupIntegerEnv(
    'IDLE_BATCH_RETENTION_DAYS',
    DEFAULT_RETENTION_DAYS,
    1,
    365,
    'IdleBatchCleanup',
  );
  const intervalSeconds = parseScheduledCleanupIntegerEnv(
    'IDLE_BATCH_CLEANUP_INTERVAL_SECONDS',
    DEFAULT_INTERVAL_SECONDS,
    60,
    86_400,
    'IdleBatchCleanup',
  );
  const deleteBatchSize = parseScheduledCleanupIntegerEnv(
    'IDLE_BATCH_CLEANUP_DELETE_BATCH_SIZE',
    DEFAULT_DELETE_BATCH_SIZE,
    100,
    50_000,
    'IdleBatchCleanup',
  );
  const maxDeleteBatchesPerRun = parseScheduledCleanupIntegerEnv(
    'IDLE_BATCH_CLEANUP_MAX_BATCHES_PER_RUN',
    DEFAULT_MAX_DELETE_BATCHES_PER_RUN,
    1,
    200,
    'IdleBatchCleanup',
  );

  return {
    enabled,
    retentionDays,
    intervalMs: intervalSeconds * 1000,
    deleteBatchSize,
    maxDeleteBatchesPerRun,
  };
}

class IdleBattleBatchCleanupService {
  private readonly config: IdleCleanupConfig = loadIdleCleanupConfig();
  private inFlight = false;

  getScheduleConfig(): IdleBattleBatchCleanupScheduleConfig {
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

  private async deleteExpiredBatchesOnce(client: PoolClient): Promise<number> {
    const res = await client.query(
      `
      WITH stale_batch AS (
        SELECT b.id
        FROM idle_battle_batches b
        JOIN idle_sessions s ON s.id = b.session_id
        WHERE b.executed_at < NOW() - ($1::int * INTERVAL '1 day')
          AND s.status = ANY($2::varchar[])
        ORDER BY b.executed_at ASC
        LIMIT $3
      )
      DELETE FROM idle_battle_batches b
      USING stale_batch
      WHERE b.id = stale_batch.id
    `,
      [this.config.retentionDays, IDLE_FINISHED_SESSION_STATUSES, this.config.deleteBatchSize],
    );

    return res.rowCount ?? 0;
  }

  async runCleanupOnce(): Promise<number> {
    if (!this.config.enabled) return 0;
    if (this.inFlight) return 0;
    this.inFlight = true;

    try {
      const execution = await withSessionAdvisoryLock(IDLE_CLEANUP_LOCK_KEY_1, IDLE_CLEANUP_LOCK_KEY_2, async (client) => {
        let totalDeleted = 0;
        for (let batchNo = 0; batchNo < this.config.maxDeleteBatchesPerRun; batchNo += 1) {
          const deletedCount = await this.deleteExpiredBatchesOnce(client);
          totalDeleted += deletedCount;

          if (deletedCount < this.config.deleteBatchSize) {
            break;
          }
        }

        if (totalDeleted > 0) {
          console.log(
            `[IdleBatchCleanup] 本轮清理完成：删除 ${totalDeleted} 条（保留 ${this.config.retentionDays} 天内数据）`,
          );
        }

        return totalDeleted;
      });

      if (!execution.acquired) {
        return 0;
      }

      return execution.result ?? 0;
    } catch (error) {
      console.error('[IdleBatchCleanup] 清理失败:', error);
      return 0;
    } finally {
      this.inFlight = false;
    }
  }
}

export const idleBattleBatchCleanupService = new IdleBattleBatchCleanupService();
