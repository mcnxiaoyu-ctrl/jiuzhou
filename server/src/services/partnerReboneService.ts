/**
 * 动态伙伴归元洗髓任务服务
 *
 * 作用（做什么 / 不做什么）：
 * 1) 做什么：提供归元洗髓任务的创建、状态查询、异步执行、失败退款与已读标记。
 * 2) 做什么：把“先扣道具后异步执行、失败自动退回”的状态机收口到单一服务，避免 inventory 路由、worker 和伙伴页各写一套任务规则。
 * 3) 不做什么：不解析 HTTP 参数，也不管理 worker 生命周期；线程调度交给独立 runner。
 *
 * 输入/输出：
 * - 输入：`characterId`、`partnerId`、`itemDefId`、`qty`、`reboneId`。
 * - 输出：统一 `{ success, message, data }` 结果，以及归元洗髓状态 DTO。
 *
 * 数据流/状态流：
 * inventory/use -> createPendingJob -> runner.enqueue -> worker -> processPendingJob -> succeeded / failed -> Socket 推送状态。
 *
 * 复用设计说明：
 * - 动态伙伴可洗髓校验和真正执行逻辑复用 `shared/partnerReboneExecution`，任务服务只管状态机与退款。
 * - Socket 状态 DTO 复用 `shared/partnerReboneJobShared` / `shared/partnerReboneStatus`，避免路由和推送各自拼字段。
 *
 * 关键边界条件与坑点：
 * 1) 创建任务和扣道具在同一事务里，但 worker 投递在事务外；投递失败时必须通过 `forceFailPendingReboneJob` 退款并终结任务。
 * 2) 失败退款直接回背包，不走邮件兜底；因此退款与任务终结必须在同一事务里完成，不能先写失败后再补发道具。
 */
import { randomUUID } from 'crypto';
import { query } from '../config/database.js';
import { Transactional } from '../decorators/transactional.js';
import { PARTNER_SYSTEM_FEATURE_CODE } from './featureUnlockService.js';
import { addItemToInventory } from './inventory/index.js';
import { getCharacterUserId } from './sect/db.js';
import {
  buildPartnerReboneJobState,
  type PartnerReboneJobStateInput,
  type PartnerReboneJobStatus,
} from './shared/partnerReboneJobShared.js';
import {
  buildPartnerReboneStatusDto,
  type PartnerReboneStatusDto,
} from './shared/partnerReboneStatus.js';
import {
  executeGeneratedPartnerRebone,
  validateGeneratedPartnerReboneTarget,
  type GeneratedPartnerReboneExecutionResult,
} from './shared/partnerReboneExecution.js';

export type PartnerReboneResult<T = undefined> = {
  success: boolean;
  message: string;
  data?: T;
  code?: string;
};

export interface PartnerReboneCreateResultDto {
  reboneId: string;
  partnerId: number;
}

type PartnerReboneJobRow = {
  reboneId: string;
  status: PartnerReboneJobStatus;
  partnerId: number;
  itemDefId: string;
  itemQty: number;
  errorMessage: string | null;
  viewedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
};

const normalizeGeneratedId = (prefix: string): string => {
  return `${prefix}-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
};

const buildPartnerReboneJobId = (): string => normalizeGeneratedId('partner-rebone');

const asString = (raw: unknown): string => (typeof raw === 'string' ? raw.trim() : '');

const toIsoString = (raw: unknown): string | null => {
  if (!raw) return null;
  const date = new Date(String(raw));
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
};

const mapPartnerReboneJobRow = (
  row: Record<string, unknown> | null,
): PartnerReboneJobRow | null => {
  if (!row) return null;
  return {
    reboneId: asString(row.id),
    status: (asString(row.status) as PartnerReboneJobStatus) || 'pending',
    partnerId: Number(row.partner_id) || 0,
    itemDefId: asString(row.item_def_id),
    itemQty: Math.max(1, Number(row.item_qty) || 1),
    errorMessage: asString(row.error_message) || null,
    viewedAt: toIsoString(row.viewed_at),
    finishedAt: toIsoString(row.finished_at),
    createdAt: toIsoString(row.created_at) || new Date().toISOString(),
  };
};

const buildPartnerReboneJobStateInput = (
  row: PartnerReboneJobRow | null,
): PartnerReboneJobStateInput | null => {
  if (!row) return null;
  return {
    reboneId: row.reboneId,
    status: row.status,
    partnerId: row.partnerId,
    itemDefId: row.itemDefId,
    itemQty: row.itemQty,
    startedAt: row.createdAt,
    finishedAt: row.finishedAt,
    viewedAt: row.viewedAt,
    errorMessage: row.errorMessage,
  };
};

class PartnerReboneService {
  private async loadLatestRelevantJobRow(characterId: number): Promise<PartnerReboneJobRow | null> {
    const result = await query(
      `
        SELECT id, status, partner_id, item_def_id, item_qty, error_message, viewed_at, finished_at, created_at
        FROM partner_rebone_job
        WHERE character_id = $1
          AND (status = 'pending' OR viewed_at IS NULL)
        ORDER BY CASE WHEN status = 'pending' THEN 0 ELSE 1 END, created_at DESC
        LIMIT 1
      `,
      [characterId],
    );
    return mapPartnerReboneJobRow((result.rows[0] as Record<string, unknown> | undefined) ?? null);
  }

  private async refundConsumedItemByJobRow(row: PartnerReboneJobRow, characterId: number): Promise<void> {
    const userId = await getCharacterUserId(characterId);
    if (!userId) {
      throw new Error('角色归属用户不存在，无法退回归元洗髓露');
    }
    const addResult = await addItemToInventory(characterId, userId, row.itemDefId, row.itemQty, {
      location: 'bag',
      obtainedFrom: `partner_rebone_refund:${row.reboneId}`,
    });
    if (!addResult.success) {
      throw new Error(addResult.message || '退回归元洗髓露失败');
    }
  }

  async getStatus(characterId: number): Promise<PartnerReboneResult<PartnerReboneStatusDto>> {
    try {
      const row = await this.loadLatestRelevantJobRow(characterId);
      const state = buildPartnerReboneJobState(buildPartnerReboneJobStateInput(row));
      return {
        success: true,
        message: '获取归元洗髓状态成功',
        data: buildPartnerReboneStatusDto({
          featureCode: PARTNER_SYSTEM_FEATURE_CODE,
          state,
        }),
      };
    } catch (error) {
      const reason = error instanceof Error ? error.message : '未知错误';
      return { success: false, message: `获取归元洗髓状态失败：${reason}` };
    }
  }

  @Transactional
  async createPendingReboneJob(params: {
    characterId: number;
    partnerId: number;
    itemDefId: string;
    itemQty: number;
  }): Promise<PartnerReboneResult<PartnerReboneCreateResultDto>> {
    try {
      const pendingJobResult = await query(
        `
          SELECT id
          FROM partner_rebone_job
          WHERE character_id = $1
            AND status = 'pending'
          LIMIT 1
          FOR UPDATE
        `,
        [params.characterId],
      );
      if (pendingJobResult.rows.length > 0) {
        return { success: false, message: '当前已有归元洗髓进行中' };
      }

      const targetResult = await validateGeneratedPartnerReboneTarget({
        characterId: params.characterId,
        partnerId: params.partnerId,
        forUpdate: true,
      });
      if (!targetResult.success) {
        return { success: false, message: targetResult.message };
      }

      const reboneId = buildPartnerReboneJobId();
      await query(
        `
          INSERT INTO partner_rebone_job (
            id, character_id, partner_id, status, item_def_id, item_qty
          ) VALUES ($1, $2, $3, 'pending', $4, $5)
        `,
        [reboneId, params.characterId, params.partnerId, params.itemDefId, Math.max(1, params.itemQty)],
      );

      return {
        success: true,
        message: '归元洗髓已开始',
        data: {
          reboneId,
          partnerId: params.partnerId,
        },
      };
    } catch (error) {
      const reason = error instanceof Error ? error.message : '未知错误';
      return { success: false, message: `创建归元洗髓任务失败：${reason}` };
    }
  }

  @Transactional
  async processPendingReboneJob(params: {
    characterId: number;
    reboneId: string;
  }): Promise<GeneratedPartnerReboneExecutionResult<{
    status: Extract<PartnerReboneJobStatus, 'succeeded' | 'failed'>;
    partnerId: number;
    errorMessage: string | null;
  }>> {
    try {
      const jobResult = await query(
        `
          SELECT id, status, partner_id, item_def_id, item_qty, error_message, viewed_at, finished_at, created_at
          FROM partner_rebone_job
          WHERE id = $1
            AND character_id = $2
          LIMIT 1
          FOR UPDATE
        `,
        [params.reboneId, params.characterId],
      );
      const jobRow = mapPartnerReboneJobRow((jobResult.rows[0] as Record<string, unknown> | undefined) ?? null);
      if (!jobRow) {
        return { success: false, message: '归元洗髓任务不存在' };
      }
      if (jobRow.status !== 'pending') {
        return {
          success: true,
          message: '归元洗髓任务已结束',
          data: {
            status: jobRow.status === 'failed' ? 'failed' : 'succeeded',
            partnerId: jobRow.partnerId,
            errorMessage: jobRow.errorMessage,
          },
        };
      }

      const executionResult = await executeGeneratedPartnerRebone({
        characterId: params.characterId,
        partnerId: jobRow.partnerId,
        refreshGeneratedSnapshots: false,
        includePartnerDetail: false,
      });
      if (!executionResult.success) {
        await this.refundConsumedItemByJobRow(jobRow, params.characterId);
        await query(
          `
            UPDATE partner_rebone_job
            SET status = 'failed',
                error_message = $3,
                finished_at = NOW(),
                viewed_at = NULL,
                updated_at = NOW()
            WHERE id = $1
              AND character_id = $2
          `,
          [params.reboneId, params.characterId, executionResult.message],
        );
        return {
          success: true,
          message: executionResult.message,
          data: {
            status: 'failed',
            partnerId: jobRow.partnerId,
            errorMessage: executionResult.message,
          },
        };
      }

      await query(
        `
          UPDATE partner_rebone_job
          SET status = 'succeeded',
              error_message = NULL,
              finished_at = NOW(),
              viewed_at = NULL,
              updated_at = NOW()
          WHERE id = $1
            AND character_id = $2
        `,
        [params.reboneId, params.characterId],
      );

      return {
        success: true,
        message: '归元洗髓成功',
        data: {
          status: 'succeeded',
          partnerId: jobRow.partnerId,
          errorMessage: null,
        },
      };
    } catch (error) {
      const reason = error instanceof Error ? error.message : '未知错误';
      return { success: false, message: `归元洗髓失败：${reason}` };
    }
  }

  @Transactional
  async forceFailPendingReboneJob(
    characterId: number,
    reboneId: string,
    reason: string,
  ): Promise<void> {
    const jobResult = await query(
      `
        SELECT id, status, partner_id, item_def_id, item_qty, error_message, viewed_at, finished_at, created_at
        FROM partner_rebone_job
        WHERE id = $1
          AND character_id = $2
        LIMIT 1
        FOR UPDATE
      `,
      [reboneId, characterId],
    );
    const jobRow = mapPartnerReboneJobRow((jobResult.rows[0] as Record<string, unknown> | undefined) ?? null);
    if (!jobRow || jobRow.status !== 'pending') {
      return;
    }

    await this.refundConsumedItemByJobRow(jobRow, characterId);
    await query(
      `
        UPDATE partner_rebone_job
        SET status = 'failed',
            error_message = $3,
            finished_at = NOW(),
            viewed_at = NULL,
            updated_at = NOW()
        WHERE id = $1
          AND character_id = $2
      `,
      [reboneId, characterId, reason],
    );
  }

  @Transactional
  async markResultViewed(characterId: number): Promise<PartnerReboneResult<{ reboneId: string | null }>> {
    try {
      const result = await query(
        `
          WITH latest_unviewed_job AS (
            SELECT id
            FROM partner_rebone_job
            WHERE character_id = $1
              AND status IN ('succeeded', 'failed')
              AND viewed_at IS NULL
            ORDER BY created_at DESC
            LIMIT 1
            FOR UPDATE
          )
          UPDATE partner_rebone_job job
          SET viewed_at = NOW(),
              updated_at = NOW()
          FROM latest_unviewed_job
          WHERE job.id = latest_unviewed_job.id
          RETURNING job.id
        `,
        [characterId],
      );

      return {
        success: true,
        message: '归元洗髓结果已读成功',
        data: {
          reboneId: asString((result.rows[0] as { id?: string } | undefined)?.id) || null,
        },
      };
    } catch (error) {
      const reason = error instanceof Error ? error.message : '未知错误';
      return { success: false, message: `标记归元洗髓结果已读失败：${reason}` };
    }
  }
}

export const partnerReboneService = new PartnerReboneService();
export default partnerReboneService;
