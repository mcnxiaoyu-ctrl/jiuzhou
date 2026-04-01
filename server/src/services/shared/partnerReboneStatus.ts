/**
 * 归元洗髓状态 DTO 构建模块
 *
 * 作用（做什么 / 不做什么）：
 * 1) 做什么：把归元洗髓任务状态、红点与当前任务统一收敛为前端直接可消费的状态 DTO。
 * 2) 做什么：让 HTTP 状态接口与 Socket 推送复用同一份结构，避免字段口径漂移。
 * 3) 不做什么：不查询数据库、不决定任务是否合法，也不拼装伙伴总览。
 *
 * 输入/输出：
 * - 输入：功能码、任务状态输出。
 * - 输出：`PartnerReboneStatusDto`。
 *
 * 数据流/状态流：
 * partnerReboneService.getStatus -> 本模块构建 DTO -> route 响应 / Socket 推送 -> PartnerModal。
 *
 * 复用设计说明：
 * - 这里把“当前任务 + 红点 + 结果态”压成单一出口，Socket 与首屏查询都直接复用。
 * - 伙伴页只消费 DTO，不再自己拼 pending / failed / succeeded 的映射。
 *
 * 关键边界条件与坑点：
 * 1) `resultStatus` 与 `hasUnreadResult` 必须来自同一状态映射，不能在不同层各自猜。
 * 2) 当前任务必须透传 `partnerId`，否则前端无法只禁用目标伙伴的洗髓按钮。
 */
import type {
  PartnerReboneJobStateOutput,
  PartnerReboneJobView,
} from './partnerReboneJobShared.js';

export type PartnerReboneStatusDto = {
  featureCode: string;
  unlocked: true;
  currentJob: PartnerReboneJobView | null;
  hasUnreadResult: boolean;
  resultStatus: 'succeeded' | 'failed' | null;
};

export const buildPartnerReboneStatusDto = (params: {
  featureCode: string;
  state: PartnerReboneJobStateOutput;
}): PartnerReboneStatusDto => {
  return {
    featureCode: params.featureCode,
    unlocked: true,
    currentJob: params.state.currentJob,
    hasUnreadResult: params.state.hasUnreadResult,
    resultStatus: params.state.resultStatus,
  };
};
