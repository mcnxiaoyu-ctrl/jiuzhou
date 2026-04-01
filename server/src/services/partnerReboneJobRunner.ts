/**
 * 归元洗髓异步任务协调器
 *
 * 作用（做什么 / 不做什么）：
 * 1) 做什么：负责把归元洗髓任务投递到独立 worker，并在任务完成后统一推送 Socket 结果事件。
 * 2) 做什么：在服务启动时恢复数据库中的 pending 洗髓任务，避免重启后任务永久卡死。
 * 3) 不做什么：不做 HTTP 参数校验，不直接执行洗髓，也不负责前端状态判定。
 *
 * 输入/输出：
 * - 输入：`reboneId`、`characterId`、`userId`。
 * - 输出：无同步业务结果；任务完成后通过 Socket 推送结果事件。
 *
 * 数据流/状态流：
 * route/service -> PartnerReboneJobRunner.enqueue -> worker 执行 -> runner 接收结果 -> emitToUser 推送。
 *
 * 关键边界条件与坑点：
 * 1) 若 worker 启动失败，必须主动把任务写成 failed 并退款，不能让任务停留在 pending。
 * 2) 恢复 pending 任务时用户可能离线，此时允许只落状态不推送，前端刷新后通过状态接口恢复结果。
 */
import { Worker } from 'worker_threads';
import path from 'path';
import { fileURLToPath } from 'url';
import { query } from '../config/database.js';
import { getGameServer } from '../game/gameServer.js';
import { getCharacterUserId } from './sect/db.js';
import { notifyPartnerReboneStatus } from './partnerRebonePush.js';
import { partnerReboneService } from './partnerReboneService.js';
import { refreshGeneratedPartnerSnapshots } from './staticConfigLoader.js';
import type {
  PartnerReboneWorkerMessage,
  PartnerReboneWorkerPayload,
  PartnerReboneWorkerResponse,
} from '../workers/partnerReboneWorkerShared.js';

type EnqueueParams = PartnerReboneWorkerPayload & {
  userId?: number;
};

class PartnerReboneJobRunner {
  private activeWorkers = new Map<string, Worker>();
  private initialized = false;

  private resolveWorkerScript(): string {
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = path.dirname(__filename);
    if (process.env.NODE_ENV !== 'production') {
      return path.join(__dirname, '../../dist/workers/partnerReboneWorker.js');
    }
    return path.join(__dirname, '../workers/partnerReboneWorker.js');
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;
    await this.recoverPendingJobs();
  }

  async shutdown(): Promise<void> {
    const workers = [...this.activeWorkers.values()];
    this.activeWorkers.clear();
    await Promise.allSettled(workers.map((worker) => worker.terminate()));
  }

  async enqueue(params: EnqueueParams): Promise<void> {
    if (this.activeWorkers.has(params.reboneId)) return;

    const worker = new Worker(this.resolveWorkerScript());
    this.activeWorkers.set(params.reboneId, worker);

    const cleanup = async (): Promise<void> => {
      this.activeWorkers.delete(params.reboneId);
      await worker.terminate().catch(() => undefined);
    };

    const pushCharacterUpdate = async (userId: number | undefined): Promise<void> => {
      if (!userId) return;
      await getGameServer().pushCharacterUpdate(userId).catch(() => undefined);
    };

    const failJob = async (reason: string): Promise<void> => {
      await partnerReboneService.forceFailPendingReboneJob(params.characterId, params.reboneId, reason);
      const userId = params.userId ?? await getCharacterUserId(params.characterId);
      if (!userId) return;
      await pushCharacterUpdate(userId);
      getGameServer().emitToUser(userId, 'partnerReboneResult', {
        characterId: params.characterId,
        reboneId: params.reboneId,
        partnerId: 0,
        status: 'failed',
        hasUnreadResult: true,
        message: '归元洗髓失败，请前往伙伴界面查看',
        errorMessage: reason,
      });
      await notifyPartnerReboneStatus(params.characterId, userId);
    };

    worker.once('error', (error) => {
      void (async () => {
        await cleanup();
        const message = error instanceof Error ? error.message : String(error);
        await failJob(`归元洗髓 worker 启动失败：${message}`);
      })();
    });

    worker.once('exit', (code) => {
      if (code === 0) return;
      void (async () => {
        if (!this.activeWorkers.has(params.reboneId)) return;
        await cleanup();
        await failJob(`归元洗髓 worker 异常退出，退出码=${code}`);
      })();
    });

    worker.on('message', (message: PartnerReboneWorkerResponse) => {
      void (async () => {
        if (message.type === 'ready') {
          const request: PartnerReboneWorkerMessage = {
            type: 'executePartnerRebone',
            payload: {
              reboneId: params.reboneId,
              characterId: params.characterId,
            },
          };
          worker.postMessage(request);
          return;
        }

        await cleanup();
        const userId = params.userId ?? await getCharacterUserId(params.characterId);
        if (message.type === 'error') {
          await failJob(`归元洗髓 worker 执行失败：${message.payload.error}`);
          return;
        }

        if (message.payload.status === 'succeeded') {
          await refreshGeneratedPartnerSnapshots();
        }

        if (!userId) return;
        await pushCharacterUpdate(userId);
        getGameServer().emitToUser(userId, 'partnerReboneResult', {
          characterId: message.payload.characterId,
          reboneId: message.payload.reboneId,
          partnerId: message.payload.partnerId,
          status: message.payload.status,
          hasUnreadResult: true,
          message: message.payload.status === 'succeeded'
            ? '归元洗髓完成，请前往伙伴界面查看最新属性'
            : '归元洗髓失败，请前往伙伴界面查看',
          errorMessage: message.payload.errorMessage ?? undefined,
        });
        await notifyPartnerReboneStatus(message.payload.characterId, userId);
      })();
    });
  }

  async abort(reboneId: string): Promise<void> {
    const worker = this.activeWorkers.get(reboneId);
    if (!worker) return;
    this.activeWorkers.delete(reboneId);
    await worker.terminate().catch(() => undefined);
  }

  private async recoverPendingJobs(): Promise<void> {
    const result = await query(
      `
        SELECT id, character_id
        FROM partner_rebone_job
        WHERE status = 'pending'
        ORDER BY created_at ASC
      `,
    );

    for (const row of result.rows as Array<{ id: string; character_id: number }>) {
      const reboneId = String(row.id);
      const characterId = Number(row.character_id);
      if (!reboneId || !Number.isInteger(characterId) || characterId <= 0) continue;
      const userId = await getCharacterUserId(characterId);
      await this.enqueue({
        reboneId,
        characterId,
        userId: userId ?? undefined,
      });
    }
  }
}

const runner = new PartnerReboneJobRunner();

export const initializePartnerReboneJobRunner = async (): Promise<void> => {
  await runner.initialize();
};

export const shutdownPartnerReboneJobRunner = async (): Promise<void> => {
  await runner.shutdown();
};

export const enqueuePartnerReboneJob = async (params: EnqueueParams): Promise<void> => {
  await runner.enqueue(params);
};

export const abortPartnerReboneJob = async (reboneId: string): Promise<void> => {
  await runner.abort(reboneId);
};
