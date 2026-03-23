/**
 * 伙伴招募前端共享状态
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：集中定义伙伴招募红点、主视图、冷却文案与按钮可用态，避免弹窗组件里散落同类判断。
 * 2. 做什么：把服务端 `currentJob`、`hasUnreadResult`、`resultStatus`、`cooldown*`、`qualityRates` 收敛成稳定的前端展示语义。
 * 3. 不做什么：不发请求、不持有 React 状态，也不直接渲染 DOM。
 *
 * 输入/输出：
 * - 输入：伙伴招募状态接口返回的 `PartnerRecruitStatusData`。
 * - 输出：红点指示器、招募面板主视图、操作按钮状态与倒计时文案。
 *
 * 数据流/状态流：
 * API / WebSocket -> partnerRecruitShared -> PartnerModal 左侧面板提示 + 招募面板内容。
 *
 * 关键边界条件与坑点：
 * 1. `pending` 只表示生成中，不能亮红点；否则玩家会把“处理中”误以为“有结果待看”。
 * 2. 生成按钮禁用、冷却提示与品质概率文案必须共用同一组纯函数，避免展示和点击拦截不一致。
 */
import type {
  PartnerRecruitJobDto,
  PartnerRecruitQualityRateDto,
  PartnerRecruitResultStatusDto,
  PartnerRecruitStatusResponse,
} from '../../../../services/api';
import { formatGameCooldownRemaining } from '../../shared/cooldownText';

export type PartnerRecruitStatusData = NonNullable<PartnerRecruitStatusResponse['data']>;
export const PARTNER_RECRUIT_STATUS_POLL_INTERVAL_MS = 15_000;

export type PartnerRecruitIndicatorView = {
  badgeDot: boolean;
  tooltip?: string;
};

export type PartnerRecruitPanelView =
  | { kind: 'empty' }
  | { kind: 'locked'; unlockRealm: string }
  | { kind: 'pending'; job: PartnerRecruitJobDto }
  | { kind: 'draft'; job: PartnerRecruitJobDto; preview: NonNullable<PartnerRecruitJobDto['preview']> }
  | { kind: 'failed'; job: PartnerRecruitJobDto; errorMessage: string };

export type PartnerRecruitActionState = {
  canGenerate: boolean;
  showGenerateButton: boolean;
  pendingGenerationId: string | null;
};

export type PartnerRecruitSubmitState = {
  canSubmit: boolean;
  disabledReason: string | null;
  hasCustomBaseModelToken: boolean;
  customBaseModelTokenEnough: boolean;
};

export type PartnerRecruitCooldownDisplay = {
  statusText: string;
  ruleText: string;
  bypassedByCustomBaseModel: boolean;
};

export type PartnerRecruitQualityRateItem = {
  quality: PartnerRecruitQualityRateDto['quality'];
  rateText: string;
};

export const resolvePartnerRecruitGuaranteeText = (
  status: PartnerRecruitStatusData | null,
): string => {
  const remainingUntilGuaranteedHeaven = status?.remainingUntilGuaranteedHeaven;
  if (typeof remainingUntilGuaranteedHeaven !== 'number' || !Number.isFinite(remainingUntilGuaranteedHeaven)) {
    return '--';
  }
  return `${Math.max(1, Math.floor(remainingUntilGuaranteedHeaven))} 次成功招募后必得天品伙伴`;
};

export type PartnerRecruitLayoutState = {
  showMetaCards: boolean;
  flattenPreviewCard: boolean;
};

export const buildPartnerRecruitIndicator = (
  status: PartnerRecruitStatusData | null,
): PartnerRecruitIndicatorView => {
  if (!status?.hasUnreadResult) return { badgeDot: false };
  return {
    badgeDot: true,
    tooltip: getPartnerRecruitIndicatorTooltip(status.resultStatus),
  };
};

export const resolvePartnerRecruitIndicatorStatus = (
  status: PartnerRecruitStatusData | null,
): PartnerRecruitResultStatusDto | null => {
  return status?.hasUnreadResult ? status.resultStatus : null;
};

export const shouldPollPartnerRecruitStatus = (
  status: PartnerRecruitStatusData | null,
): boolean => {
  return status?.currentJob?.status === 'pending';
};

export const getPartnerRecruitIndicatorTooltip = (
  resultStatus: PartnerRecruitResultStatusDto | null | undefined,
): string | undefined => {
  if (resultStatus === 'generated_draft') return '有新的伙伴预览待查看';
  if (resultStatus === 'failed') return '本次伙伴招募已结束，请查看结果';
  return undefined;
};

export const resolvePartnerRecruitPanelView = (
  status: PartnerRecruitStatusData | null,
): PartnerRecruitPanelView => {
  if (status && !status.unlocked) {
    return {
      kind: 'locked',
      unlockRealm: status.unlockRealm,
    };
  }
  const job = status?.currentJob ?? null;
  if (!job) return { kind: 'empty' };
  if (job.status === 'pending') return { kind: 'pending', job };
  if (job.status === 'generated_draft' && job.preview) {
    return {
      kind: 'draft',
      job,
      preview: job.preview,
    };
  }
  if (job.status === 'failed' || job.status === 'refunded') {
    return {
      kind: 'failed',
      job,
      errorMessage: job.errorMessage || '本次伙伴招募未能成形，消耗的灵石已自动退回。',
    };
  }
  return { kind: 'empty' };
};

export const resolvePartnerRecruitLayoutState = (
  panelView: PartnerRecruitPanelView,
): PartnerRecruitLayoutState => ({
  showMetaCards: panelView.kind !== 'draft',
  flattenPreviewCard: panelView.kind === 'draft',
});

export const isPartnerRecruitCoolingDown = (
  status: PartnerRecruitStatusData | null,
): boolean => {
  return (status?.cooldownRemainingSeconds ?? 0) > 0;
};

export const formatPartnerRecruitCooldownRemaining = (
  cooldownRemainingSeconds: number,
): string => formatGameCooldownRemaining(cooldownRemainingSeconds);

export const resolvePartnerRecruitQualityRateItems = (
  status: PartnerRecruitStatusData | null,
): PartnerRecruitQualityRateItem[] => {
  if (!status) return [];
  return status.qualityRates.map((entry) => ({
    quality: entry.quality,
    rateText: `${entry.rate}%`,
  }));
};

export const shouldPartnerRecruitBypassCooldown = (
  status: PartnerRecruitStatusData | null,
  customBaseModelEnabled: boolean,
): boolean => {
  return Boolean(status?.customBaseModelBypassesCooldown)
    && customBaseModelEnabled
    && (status?.cooldownHours ?? 0) > 0;
};

export const isPartnerRecruitCooldownBlocked = (
  status: PartnerRecruitStatusData | null,
  customBaseModelEnabled: boolean,
): boolean => {
  return isPartnerRecruitCoolingDown(status)
    && !shouldPartnerRecruitBypassCooldown(status, customBaseModelEnabled);
};

export const resolvePartnerRecruitCooldownDisplay = (
  status: PartnerRecruitStatusData | null,
  customBaseModelEnabled: boolean,
): PartnerRecruitCooldownDisplay => {
  if (!status) {
    return {
      statusText: '--',
      ruleText: '--',
      bypassedByCustomBaseModel: false,
    };
  }
  if (!status.unlocked) {
    return {
      statusText: '未开放',
      ruleText: `需达到境界：${status.unlockRealm}`,
      bypassedByCustomBaseModel: false,
    };
  }

  const coolingDown = isPartnerRecruitCoolingDown(status);
  const bypassedByCustomBaseModel = shouldPartnerRecruitBypassCooldown(status, customBaseModelEnabled);
  const cooldownText = formatPartnerRecruitCooldownRemaining(status.cooldownRemainingSeconds);
  const statusText = !coolingDown
    ? (bypassedByCustomBaseModel ? '可招募（本次不触发冷却）' : '可招募')
    : (bypassedByCustomBaseModel ? `本次招募无冷却` : `剩余${cooldownText}`);
  const ruleText = status.cooldownHours === 0
    ? '当前环境已关闭伙伴招募冷却，可连续招募。'
    : bypassedByCustomBaseModel
      ? '已启用高级招募令，本次招募会无视当前冷却，且不会重置或新增招募冷却。'
      : `每次开始招募后会进入冷却，当前冷却时长为 ${status.cooldownHours} 小时。`;

  return {
    statusText,
    ruleText,
    bypassedByCustomBaseModel,
  };
};

export const resolvePartnerRecruitActionState = (
  status: PartnerRecruitStatusData | null,
  customBaseModelEnabled: boolean,
): PartnerRecruitActionState => {
  const panelView = resolvePartnerRecruitPanelView(status);
  const canGenerate =
    status !== null &&
    status.unlocked &&
    panelView.kind !== 'pending' &&
    panelView.kind !== 'draft' &&
    !isPartnerRecruitCooldownBlocked(status, customBaseModelEnabled);

  return {
    canGenerate,
    showGenerateButton:
      panelView.kind !== 'locked'
      && panelView.kind !== 'pending'
      && panelView.kind !== 'draft',
    pendingGenerationId: panelView.kind === 'pending' ? panelView.job.generationId : null,
  };
};

export const hasPartnerRecruitCustomBaseModelToken = (
  status: PartnerRecruitStatusData | null,
): boolean => {
  return status !== null
    && status.customBaseModelTokenAvailableQty >= status.customBaseModelTokenCost;
};

export const resolvePartnerRecruitSubmitState = (
  status: PartnerRecruitStatusData | null,
  customBaseModelEnabled: boolean,
): PartnerRecruitSubmitState => {
  const actionState = resolvePartnerRecruitActionState(status, customBaseModelEnabled);
  const hasCustomBaseModelToken = hasPartnerRecruitCustomBaseModelToken(status);
  const customBaseModelTokenEnough = !customBaseModelEnabled || hasCustomBaseModelToken;
  const canSubmit = actionState.canGenerate && customBaseModelTokenEnough;

  if (!customBaseModelEnabled || canSubmit) {
    return {
      canSubmit,
      disabledReason: null,
      hasCustomBaseModelToken,
      customBaseModelTokenEnough,
    };
  }

  if (!customBaseModelTokenEnough) {
    return {
      canSubmit,
      disabledReason: `${status?.customBaseModelTokenItemName ?? '高级招募令'}不足，当前无法开始招募。`,
      hasCustomBaseModelToken,
      customBaseModelTokenEnough,
    };
  }

  return {
    canSubmit,
    disabledReason: null,
    hasCustomBaseModelToken,
    customBaseModelTokenEnough,
  };
};
