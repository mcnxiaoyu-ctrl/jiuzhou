/**
 * 伙伴招募异步任务协调器
 *
 * 作用（做什么 / 不做什么）：
 * 1) 做什么：负责把伙伴招募任务投递到独立 worker，并在任务完成后统一推送 WebSocket 结果事件。
 * 2) 做什么：在服务启动时恢复数据库中遗留的 pending 任务，避免重启后任务永久卡死。
 * 3) 不做什么：不做 HTTP 参数校验，不直接生成草稿，也不在此处实现 UI 状态判断。
 *
 * 输入/输出：
 * - 输入：generationId / characterId / quality / userId。
 * - 输出：无同步业务结果；任务完成后通过 WebSocket 推送结果事件。
 *
 * 数据流/状态流：
 * route/service -> PartnerRecruitJobRunner.enqueue -> worker 执行 -> runner 接收结果 -> emitToUser 推送。
 *
 * 关键边界条件与坑点：
 * 1) 若 worker 启动失败，必须主动把任务退款并终结，不能让任务停留在 pending。
 * 2) 恢复 pending 任务时用户可能离线，此时允许只落状态不推送，前端刷新后再通过状态接口恢复结果。
 */
import { query } from '../config/database.js';
import { getGameServer } from '../game/gameServer.js';
import {
  refreshGeneratedPartnerSnapshots,
  refreshGeneratedTechniqueSnapshots,
} from './staticConfigLoader.js';
import { getCharacterUserId } from './sect/db.js';
import { notifyPartnerRecruitStatus } from './partnerRecruitPush.js';
import { appendPartnerRecruitRefundHint, partnerRecruitService } from './partnerRecruitService.js';
import { PARTNER_RECRUIT_GENERATION_TIMEOUT_MS } from './shared/partnerRecruitGenerationTimeout.js';
import type { PartnerRecruitQuality } from './shared/partnerRecruitRules.js';
import type {
  PartnerRecruitWorkerMessage,
  PartnerRecruitWorkerPayload,
  PartnerRecruitWorkerResult,
  PartnerRecruitWorkerResponse,
} from '../workers/partnerRecruitWorkerShared.js';
import {
  PooledJobWorkerRunner,
  resolveWorkerScriptPath,
} from './shared/pooledJobWorkerRunner.js';
import { resolveAiJobWorkerCount } from './shared/aiJobWorkerCount.js';

type EnqueueParams = PartnerRecruitWorkerPayload & {
  userId?: number;
};

const resolvePartnerRecruitWorkerCount = (): number => {
  return resolveAiJobWorkerCount(process.env.PARTNER_RECRUIT_WORKER_COUNT);
};

class PartnerRecruitJobRunner {
  private readonly abortedGenerationIds = new Set<string>();
  private readonly workerPool = new PooledJobWorkerRunner<
    PartnerRecruitWorkerPayload,
    PartnerRecruitWorkerMessage,
    PartnerRecruitWorkerResponse,
    PartnerRecruitWorkerResult
  >({
    label: 'partner-recruit',
    workerScript: resolveWorkerScriptPath(import.meta.url, 'partnerRecruitWorker'),
    taskTimeoutMs: PARTNER_RECRUIT_GENERATION_TIMEOUT_MS,
    workerCount: resolvePartnerRecruitWorkerCount(),
    buildExecuteMessage: (payload) => ({
      type: 'executePartnerRecruit',
      payload,
    }),
    parseWorkerResponse: (message) => {
      if (message.type === 'ready') {
        return { kind: 'ready' };
      }
      if (message.type === 'result') {
        return { kind: 'result', payload: message.payload };
      }
      return {
        kind: 'error',
        message: message.payload.error,
        ...(message.payload.stack ? { stack: message.payload.stack } : {}),
      };
    },
  });
  private initialized = false;

  /**
   * 作用（做什么 / 不做什么）：
   * 1) 做什么：在主线程同步 worker 刚写入数据库的动态伙伴/功法快照，确保后续状态接口和确认收下读取的是最新定义。
   * 2) 不做什么：不改任务状态、不吞掉业务失败；刷新失败应让本次结果直接走失败链路，避免生成成功却无法展示预览。
   *
   * 输入/输出：
   * - 输入：无。
   * - 输出：主线程内存中的最新生成配置快照。
   *
   * 数据流/状态流：
   * worker 落库 -> syncGeneratedRecruitSnapshots -> 状态接口 / confirm 收下 / 前端预览。
   *
   * 关键边界条件与坑点：
   * 1) worker 线程刷新的是自己的模块缓存，主线程不会自动同步，因此必须在 runner 统一补刷。
   * 2) 预览依赖伙伴定义和天生功法/技能定义两套缓存，只刷新一边仍会导致预览不完整或直接缺失。
   */
  private async syncGeneratedRecruitSnapshots(): Promise<void> {
    await refreshGeneratedTechniqueSnapshots();
    await refreshGeneratedPartnerSnapshots();
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;
    await this.workerPool.initialize();
    await this.recoverPendingJobs();
  }

  async shutdown(): Promise<void> {
    await this.workerPool.shutdown();
  }

  async enqueue(params: EnqueueParams): Promise<void> {
    if (this.workerPool.hasActiveJob(params.generationId)) return;

    const failJob = async (reason: string): Promise<void> => {
      await partnerRecruitService.forceRefundPendingRecruitJob(params.characterId, params.generationId, reason);
      const userId = params.userId ?? await getCharacterUserId(params.characterId);
      if (!userId) return;
      const errorMessage = appendPartnerRecruitRefundHint(reason);
      getGameServer().emitToUser(userId, 'partnerRecruitResult', {
        characterId: params.characterId,
        generationId: params.generationId,
        status: 'failed',
        hasUnreadResult: true,
        message: '伙伴招募失败，请前往伙伴界面查看',
        errorMessage,
      });
      await notifyPartnerRecruitStatus(params.characterId, userId);
    };

    void this.workerPool.execute(params.generationId, {
      generationId: params.generationId,
      characterId: params.characterId,
      quality: params.quality,
    }).then((result) => {
      void (async () => {
        if (this.abortedGenerationIds.delete(params.generationId)) {
          return;
        }
        const userId = params.userId ?? await getCharacterUserId(params.characterId);
        if (result.status === 'generated_draft') {
          await this.syncGeneratedRecruitSnapshots();
        }

        if (!userId) return;
        getGameServer().emitToUser(userId, 'partnerRecruitResult', {
          characterId: result.characterId,
          generationId: result.generationId,
          status: result.status === 'generated_draft' ? 'generated_draft' : 'failed',
          hasUnreadResult: true,
          message: result.status === 'generated_draft'
            ? '新的伙伴预览已生成，请前往伙伴界面查看'
            : '伙伴招募失败，请前往伙伴界面查看',
          preview: result.preview
            ? {
                name: result.preview.name,
                quality: result.preview.quality,
                role: result.preview.role,
                element: result.preview.element,
              }
            : undefined,
          errorMessage: result.errorMessage ?? undefined,
        });
        await notifyPartnerRecruitStatus(result.characterId, userId);
      })();
    }).catch((error: Error) => {
      void (async () => {
        if (this.abortedGenerationIds.delete(params.generationId)) {
          return;
        }
        const message = error instanceof Error ? error.message : String(error);
        await failJob(`伙伴招募 worker 执行失败：${message}`);
      })();
    });
  }

  async abort(generationId: string): Promise<void> {
    this.abortedGenerationIds.add(generationId);
  }

  private async recoverPendingJobs(): Promise<void> {
    const result = await query(
      `
        SELECT id, character_id, quality_rolled
        FROM partner_recruit_job
        WHERE status = 'pending'
        ORDER BY created_at ASC
      `,
    );

    for (const row of result.rows as Array<Record<string, unknown>>) {
      const generationId = typeof row.id === 'string' ? row.id : '';
      const characterId = Number(row.character_id);
      const quality = (typeof row.quality_rolled === 'string' ? row.quality_rolled : '黄') as PartnerRecruitQuality;
      if (!generationId || !Number.isFinite(characterId) || characterId <= 0) continue;
      const userId = await getCharacterUserId(characterId);
      await this.enqueue({
        generationId,
        characterId,
        quality,
        userId: userId ?? undefined,
      });
    }
  }
}

const runner = new PartnerRecruitJobRunner();

export const initializePartnerRecruitJobRunner = async (): Promise<void> => {
  await runner.initialize();
};

export const shutdownPartnerRecruitJobRunner = async (): Promise<void> => {
  await runner.shutdown();
};

export const enqueuePartnerRecruitJob = async (params: EnqueueParams): Promise<void> => {
  await runner.enqueue(params);
};

export const abortPartnerRecruitJob = async (generationId: string): Promise<void> => {
  await runner.abort(generationId);
};
