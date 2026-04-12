import { partnerReboneService } from '../services/partnerReboneService.js';
import {
  refreshGeneratedPartnerSnapshots,
  refreshGeneratedTechniqueSnapshots,
} from '../services/staticConfigLoader.js';
import type {
  PartnerReboneWorkerPayload,
  PartnerReboneWorkerResponse,
} from './partnerReboneWorkerShared.js';

type PartnerReboneWorkerExecutionDeps = {
  refreshGeneratedTechniqueSnapshots: () => Promise<void>;
  refreshGeneratedPartnerSnapshots: () => Promise<void>;
  processPendingReboneJob: (
    payload: PartnerReboneWorkerPayload,
  ) => ReturnType<typeof partnerReboneService.processPendingReboneJob>;
};

/**
 * 归元洗髓 worker 单次执行入口
 *
 * 作用（做什么 / 不做什么）：
 * 1) 做什么：统一封装 worker 真正执行洗髓任务前的动态功法/伙伴快照同步与结果映射。
 * 2) 做什么：让消息监听层只负责收发协议，避免“先生成功法快照、再刷伙伴快照、再执行业务”的关键顺序散落在事件回调里。
 * 3) 不做什么：不管理线程生命周期，不处理主线程推送，也不改数据库事务边界。
 *
 * 输入/输出：
 * - 输入：`reboneId`、`characterId`，以及可注入的功法快照刷新、伙伴快照刷新、业务处理依赖。
 * - 输出：标准化 `PartnerReboneWorkerResponse`。
 *
 * 数据流/状态流：
 * worker payload -> 刷新 generated technique 快照 -> 刷新 generated_partner_def 快照 -> processPendingReboneJob -> worker result response。
 *
 * 关键边界条件与坑点：
 * 1) worker 是独立线程，不能假设主线程已经刷新的动态功法/伙伴缓存会自动共享到这里；执行前必须主动同步。
 * 2) 伙伴战斗展示依赖功法定义与伙伴定义两套快照，只刷新一边会导致 `tech-partner-*` 可见性不一致。
 * 3) 这里只做快照同步，不做兜底重试；若刷新或业务执行失败，应让异常继续抛给外层统一转成 worker error。
 */
export const executePartnerReboneWorkerTask = async (
  payload: PartnerReboneWorkerPayload,
  deps: PartnerReboneWorkerExecutionDeps = {
    refreshGeneratedTechniqueSnapshots,
    refreshGeneratedPartnerSnapshots,
    processPendingReboneJob: (taskPayload) => partnerReboneService.processPendingReboneJob(taskPayload),
  },
): Promise<Extract<PartnerReboneWorkerResponse, { type: 'result' }>> => {
  await deps.refreshGeneratedTechniqueSnapshots();
  await deps.refreshGeneratedPartnerSnapshots();

  const result = await deps.processPendingReboneJob(payload);

  return {
    type: 'result',
    payload: {
      reboneId: payload.reboneId,
      characterId: payload.characterId,
      partnerId: result.data?.partnerId ?? 0,
      status: result.data?.status ?? 'failed',
      errorMessage: result.data?.errorMessage ?? result.message,
    },
  };
};
