/**
 * 归元洗髓 worker 通讯协议
 *
 * 作用（做什么 / 不做什么）：
 * 1) 做什么：集中定义主线程与归元洗髓 worker 之间的消息结构，避免 runner 和 worker 各自维护字符串协议。
 * 2) 不做什么：不执行业务、不读写数据库，也不直接推送前端。
 *
 * 输入/输出：
 * - 输入：主线程投递的执行消息。
 * - 输出：worker 返回的 ready / result / error 消息。
 *
 * 数据流/状态流：
 * runner -> partnerReboneWorkerMessage -> worker
 * worker -> partnerReboneWorkerResponse -> runner
 *
 * 关键边界条件与坑点：
 * 1) 返回载荷必须复用业务侧状态类型，避免 worker 和 service 的状态字符串漂移。
 * 2) 该协议只服务于单次归元洗髓任务，不混入其他 worker 任务。
 */
import type { PartnerReboneJobStatus } from '../services/shared/partnerReboneJobShared.js';

export type PartnerReboneWorkerPayload = {
  characterId: number;
  reboneId: string;
};

export type PartnerReboneWorkerMessage =
  | { type: 'executePartnerRebone'; payload: PartnerReboneWorkerPayload }
  | { type: 'shutdown' };

export type PartnerReboneWorkerResult = {
  reboneId: string;
  characterId: number;
  partnerId: number;
  status: Extract<PartnerReboneJobStatus, 'succeeded' | 'failed'>;
  errorMessage: string | null;
};

export type PartnerReboneWorkerResponse =
  | { type: 'ready' }
  | { type: 'result'; payload: PartnerReboneWorkerResult }
  | { type: 'error'; payload: { reboneId: string; characterId: number; error: string; stack?: string } };
