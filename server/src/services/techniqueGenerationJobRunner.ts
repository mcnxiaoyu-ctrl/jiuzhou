/**
 * 洞府研修异步任务协调器
 *
 * 作用（做什么 / 不做什么）：
 * 1) 做什么：负责投递研修生成任务到独立 worker，并在任务完成后统一推送 WebSocket 结果事件。
 * 2) 做什么：在服务启动时恢复数据库中遗留的 pending 任务，避免进程重启后任务永久卡住。
 * 3) 不做什么：不做 HTTP 参数校验，不直接生成草稿，也不在此处实现 UI 状态判断。
 *
 * 输入/输出：
 * - 输入：generationId / characterId / techniqueType / quality / userId。
 * - 输出：无同步业务结果；任务完成后通过 WebSocket 推送结果事件。
 *
 * 数据流/状态流：
 * route/service -> TechniqueGenerationJobRunner.enqueue -> worker 执行 -> runner 接收结果 -> emitToUser 推送。
 *
 * 关键边界条件与坑点：
 * 1) 若 worker 启动失败，必须主动把任务标记失败并退款，不能让任务停留在 pending。
 * 2) 恢复 pending 任务时用户可能离线，此时允许只落状态不推送，前端刷新后再从状态接口恢复红点。
 */
import { query } from '../config/database.js';
import { getGameServer } from '../game/gameServer.js';
import { getCharacterUserId } from './sect/db.js';
import { isGeneratedTechniqueType } from './shared/techniqueGenerationConstraints.js';
import { notifyTechniqueResearchStatus } from './techniqueResearchPush.js';
import {
  appendTechniqueResearchRefundHint,
  techniqueGenerationService,
  type TechniqueQuality,
} from './techniqueGenerationService.js';
import type {
  TechniqueGenerationWorkerMessage,
  TechniqueGenerationWorkerPayload,
  TechniqueGenerationWorkerResult,
  TechniqueGenerationWorkerResponse,
} from '../workers/techniqueGenerationWorkerShared.js';
import {
  PooledJobWorkerRunner,
  resolveWorkerScriptPath,
} from './shared/pooledJobWorkerRunner.js';

type EnqueueParams = TechniqueGenerationWorkerPayload & {
  userId?: number;
};

class TechniqueGenerationJobRunner {
  private readonly abortedGenerationIds = new Set<string>();
  private readonly workerPool = new PooledJobWorkerRunner<
    TechniqueGenerationWorkerPayload,
    TechniqueGenerationWorkerMessage,
    TechniqueGenerationWorkerResponse,
    TechniqueGenerationWorkerResult
  >({
    label: 'technique-generation',
    workerScript: resolveWorkerScriptPath(import.meta.url, 'techniqueGenerationWorker'),
    workerCount: (() => {
      const configured = Math.floor(Number(process.env.TECHNIQUE_GENERATION_WORKER_COUNT));
      if (!Number.isFinite(configured) || configured <= 0) {
        return 2;
      }
      return configured;
    })(),
    buildExecuteMessage: (payload) => ({
      type: 'executeTechniqueGeneration',
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
      await techniqueGenerationService.failPendingGenerationJob(params.characterId, params.generationId, reason);
      const userId = params.userId ?? await getCharacterUserId(params.characterId);
      if (!userId) return;
      const errorMessage = appendTechniqueResearchRefundHint(reason);
      getGameServer().emitToUser(userId, 'techniqueResearchResult', {
        characterId: params.characterId,
        generationId: params.generationId,
        status: 'failed',
        hasUnreadResult: true,
        message: '洞府推演失败，请前往功法查看',
        errorMessage,
      });
      await notifyTechniqueResearchStatus(params.characterId, userId);
    };

    void this.workerPool.execute(params.generationId, {
      characterId: params.characterId,
      generationId: params.generationId,
      techniqueType: params.techniqueType,
      quality: params.quality,
    }).then((result) => {
      void (async () => {
        if (this.abortedGenerationIds.delete(params.generationId)) {
          return;
        }
        const userId = params.userId ?? await getCharacterUserId(params.characterId);
        if (!userId) return;
        getGameServer().emitToUser(userId, 'techniqueResearchResult', {
          characterId: result.characterId,
          generationId: result.generationId,
          status: result.status,
          hasUnreadResult: true,
          message: result.status === 'generated_draft'
            ? '新的研修草稿已生成，请前往功法查看'
            : '洞府推演失败，请前往功法查看',
          preview: result.preview
            ? {
                aiSuggestedName: result.preview.aiSuggestedName,
                quality: result.preview.quality,
                type: result.preview.type,
                maxLayer: result.preview.maxLayer,
              }
            : undefined,
          errorMessage: result.errorMessage ?? undefined,
        });
        await notifyTechniqueResearchStatus(result.characterId, userId);
      })();
    }).catch((error: Error) => {
      void (async () => {
        if (this.abortedGenerationIds.delete(params.generationId)) {
          return;
        }
        const message = error instanceof Error ? error.message : String(error);
        await failJob(`研修 worker 执行失败：${message}`);
      })();
    });
  }

  async abort(generationId: string): Promise<void> {
    this.abortedGenerationIds.add(generationId);
  }

  private async recoverPendingJobs(): Promise<void> {
    const result = await query(
      `
        SELECT id, character_id, type_rolled, quality_rolled
        FROM technique_generation_job
        WHERE status = 'pending'
        ORDER BY created_at ASC
      `,
    );

    for (const row of result.rows as Array<Record<string, unknown>>) {
      const generationId = typeof row.id === 'string' ? row.id : '';
      const characterId = Number(row.character_id);
      const techniqueType = typeof row.type_rolled === 'string' ? row.type_rolled : '';
      const quality = (typeof row.quality_rolled === 'string' ? row.quality_rolled : '黄') as TechniqueQuality;
      if (!generationId || !Number.isFinite(characterId) || characterId <= 0) continue;
      if (!isGeneratedTechniqueType(techniqueType)) {
        await techniqueGenerationService.failPendingGenerationJob(characterId, generationId, '研修任务缺少有效功法类型，已终止');
        continue;
      }
      const userId = await getCharacterUserId(characterId);
      await this.enqueue({
        generationId,
        characterId,
        techniqueType,
        quality,
        userId: userId ?? undefined,
      });
    }
  }
}

const runner = new TechniqueGenerationJobRunner();

export const initializeTechniqueGenerationJobRunner = async (): Promise<void> => {
  await runner.initialize();
};

export const shutdownTechniqueGenerationJobRunner = async (): Promise<void> => {
  await runner.shutdown();
};

export const enqueueTechniqueGenerationJob = async (params: EnqueueParams): Promise<void> => {
  await runner.enqueue(params);
};

export const abortTechniqueGenerationJob = async (generationId: string): Promise<void> => {
  await runner.abort(generationId);
};
