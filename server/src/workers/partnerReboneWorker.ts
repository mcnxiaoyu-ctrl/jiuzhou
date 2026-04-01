/**
 * 归元洗髓 AI 生成 worker
 *
 * 作用（做什么 / 不做什么）：
 * 1) 做什么：在独立线程中执行单个动态伙伴的归元洗髓任务。
 * 2) 不做什么：不处理 HTTP、不直接推送 Socket，也不维护任务队列。
 *
 * 输入/输出：
 * - 输入：`executePartnerRebone`，包含 characterId 与 reboneId。
 * - 输出：`result`（成功或失败结果）或 `error`（worker 级异常）。
 *
 * 数据流/状态流：
 * 主线程 runner -> worker -> partnerReboneService.processPendingReboneJob -> runner。
 *
 * 关键边界条件与坑点：
 * 1) 业务失败必须转换成 `result` 返回主线程，不能让任务静默停在 pending。
 * 2) worker 只执行单任务，线程生命周期统一由 runner 管理。
 */
import '../bootstrap/installConsoleLogger.js';
import { parentPort } from 'worker_threads';
import type {
  PartnerReboneWorkerMessage,
  PartnerReboneWorkerResponse,
} from './partnerReboneWorkerShared.js';
import { executePartnerReboneWorkerTask } from './partnerReboneWorkerExecution.js';

if (!parentPort) {
  throw new Error('[PartnerReboneWorker] parentPort 未定义，无法启动 Worker');
}

parentPort.on('message', (message: PartnerReboneWorkerMessage) => {
  void (async () => {
    try {
      if (message.type === 'shutdown') {
        process.exit(0);
        return;
      }

      if (message.type !== 'executePartnerRebone') {
        return;
      }

      const response = await executePartnerReboneWorkerTask({
        characterId: message.payload.characterId,
        reboneId: message.payload.reboneId,
      });
      parentPort!.postMessage(response);
    } catch (error) {
      const response: PartnerReboneWorkerResponse = {
        type: 'error',
        payload: {
          reboneId: message.type === 'executePartnerRebone' ? message.payload.reboneId : '',
          characterId: message.type === 'executePartnerRebone' ? message.payload.characterId : 0,
          error: error instanceof Error ? error.message : '未知异常',
          stack: error instanceof Error ? error.stack : undefined,
        },
      };
      parentPort!.postMessage(response);
    }
  })();
});

parentPort.postMessage({ type: 'ready' } as PartnerReboneWorkerResponse);
