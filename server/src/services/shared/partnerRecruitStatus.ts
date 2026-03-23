/**
 * 伙伴招募状态 DTO 构建器
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：集中构建伙伴招募状态接口的响应 DTO，把“未开放 / 已开放”的前端展示口径收敛到单一入口。
 * 2. 做什么：在未开放时统一清空动态任务、红点与冷却剩余，避免页面初始化把锁定态误当异常或展示出矛盾状态。
 * 3. 不做什么：不查询数据库、不判断伙伴系统功能是否已解锁，也不计算任务状态或冷却规则。
 *
 * 输入/输出：
 * - 输入：招募开放态、基础静态配置，以及当前任务/冷却/红点等动态状态。
 * - 输出：前端可直接消费的伙伴招募状态 DTO。
 *
 * 数据流/状态流：
 * partnerRecruitService.getRecruitStatus -> 本模块构建 DTO -> route 响应 -> PartnerModal / partnerRecruitShared。
 *
 * 关键边界条件与坑点：
 * 1. 未开放时必须清空动态状态；否则即使不再弹错误 toast，前端仍可能展示 pending、红点或冷却中的脏数据。
 * 2. 已开放时必须透传真实动态状态；否则会把招募中的任务、待确认预览或失败结果错误抹平。
 */
import type { PartnerRecruitPreviewDto } from './partnerRecruitJobShared.js';
import type { PartnerRecruitUnlockState } from './partnerRecruitUnlock.js';
import { PARTNER_RECRUIT_CUSTOM_BASE_MODEL_MAX_LENGTH } from './partnerRecruitBaseModel.js';
import type { PartnerRecruitQualityRateEntry } from './partnerRecruitRules.js';

export type PartnerRecruitResultStatus = 'generated_draft' | 'failed' | null;

export interface PartnerRecruitJobDto {
  generationId: string;
  status: 'pending' | 'generated_draft' | 'accepted' | 'failed' | 'refunded' | 'discarded';
  startedAt: string;
  finishedAt: string | null;
  previewExpireAt: string | null;
  requestedBaseModel: string | null;
  preview: PartnerRecruitPreviewDto | null;
  errorMessage: string | null;
}

export interface PartnerRecruitStatusDto {
  featureCode: string;
  unlockRealm: string;
  unlocked: boolean;
  spiritStoneCost: number;
  cooldownHours: number;
  cooldownUntil: string | null;
  cooldownRemainingSeconds: number;
  customBaseModelBypassesCooldown: boolean;
  customBaseModelMaxLength: typeof PARTNER_RECRUIT_CUSTOM_BASE_MODEL_MAX_LENGTH;
  customBaseModelTokenCost: number;
  customBaseModelTokenItemName: string;
  customBaseModelTokenAvailableQty: number;
  currentJob: PartnerRecruitJobDto | null;
  hasUnreadResult: boolean;
  resultStatus: PartnerRecruitResultStatus;
  remainingUntilGuaranteedHeaven: number;
  qualityRates: PartnerRecruitQualityRateEntry[];
}

type BuildPartnerRecruitStatusDtoParams = {
  featureCode: string;
  unlockState: PartnerRecruitUnlockState;
  spiritStoneCost: number;
  cooldownHours: number;
  cooldownUntil: string | null;
  cooldownRemainingSeconds: number;
  customBaseModelBypassesCooldown: boolean;
  customBaseModelMaxLength: typeof PARTNER_RECRUIT_CUSTOM_BASE_MODEL_MAX_LENGTH;
  customBaseModelTokenCost: number;
  customBaseModelTokenItemName: string;
  customBaseModelTokenAvailableQty: number;
  currentJob: PartnerRecruitJobDto | null;
  hasUnreadResult: boolean;
  resultStatus: PartnerRecruitResultStatus;
  remainingUntilGuaranteedHeaven: number;
  qualityRates: PartnerRecruitQualityRateEntry[];
};

export const buildPartnerRecruitStatusDto = (
  params: BuildPartnerRecruitStatusDtoParams,
): PartnerRecruitStatusDto => {
  const {
    featureCode,
    unlockState,
    spiritStoneCost,
    cooldownHours,
    cooldownUntil,
    cooldownRemainingSeconds,
    customBaseModelBypassesCooldown,
    customBaseModelMaxLength,
    customBaseModelTokenCost,
    customBaseModelTokenItemName,
    customBaseModelTokenAvailableQty,
    currentJob,
    hasUnreadResult,
    resultStatus,
    remainingUntilGuaranteedHeaven,
    qualityRates,
  } = params;

  if (!unlockState.unlocked) {
    return {
      featureCode,
      unlockRealm: unlockState.unlockRealm,
      unlocked: false,
      spiritStoneCost,
      cooldownHours,
      cooldownUntil: null,
      cooldownRemainingSeconds: 0,
      customBaseModelBypassesCooldown,
      customBaseModelMaxLength,
      customBaseModelTokenCost,
      customBaseModelTokenItemName,
      customBaseModelTokenAvailableQty,
      currentJob: null,
      hasUnreadResult: false,
      resultStatus: null,
      remainingUntilGuaranteedHeaven,
      qualityRates,
    };
  }

  return {
    featureCode,
    unlockRealm: unlockState.unlockRealm,
    unlocked: true,
    spiritStoneCost,
    cooldownHours,
    cooldownUntil,
    cooldownRemainingSeconds,
    customBaseModelBypassesCooldown,
    customBaseModelMaxLength,
    customBaseModelTokenCost,
    customBaseModelTokenItemName,
    customBaseModelTokenAvailableQty,
    currentJob,
    hasUnreadResult,
    resultStatus,
    remainingUntilGuaranteedHeaven,
    qualityRates,
  };
};
