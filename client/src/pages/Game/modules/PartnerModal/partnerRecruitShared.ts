/**
 * 伙伴招募前端共享状态
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：集中定义伙伴招募红点、主视图、冷却文案与按钮可用态，避免弹窗组件里散落同类判断。
 * 2. 做什么：把服务端 `currentJob/hasUnreadResult/resultStatus/cooldown*` 收敛成稳定的前端展示语义。
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
 * 2. 生成按钮禁用与冷却提示必须共用同一组纯函数，避免展示和点击拦截不一致。
 */
import type {
  PartnerRecruitJobDto,
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
  | { kind: 'pending'; job: PartnerRecruitJobDto }
  | { kind: 'draft'; job: PartnerRecruitJobDto; preview: NonNullable<PartnerRecruitJobDto['preview']> }
  | { kind: 'failed'; job: PartnerRecruitJobDto; errorMessage: string };

export type PartnerRecruitActionState = {
  canGenerate: boolean;
  showGenerateButton: boolean;
  pendingGenerationId: string | null;
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

export const isPartnerRecruitCoolingDown = (
  status: PartnerRecruitStatusData | null,
): boolean => {
  return (status?.cooldownRemainingSeconds ?? 0) > 0;
};

export const formatPartnerRecruitCooldownRemaining = (
  cooldownRemainingSeconds: number,
): string => formatGameCooldownRemaining(cooldownRemainingSeconds);

export const resolvePartnerRecruitActionState = (
  status: PartnerRecruitStatusData | null,
): PartnerRecruitActionState => {
  const panelView = resolvePartnerRecruitPanelView(status);
  const canGenerate =
    status !== null &&
    panelView.kind !== 'pending' &&
    panelView.kind !== 'draft' &&
    !isPartnerRecruitCoolingDown(status);

  return {
    canGenerate,
    showGenerateButton: panelView.kind !== 'pending' && panelView.kind !== 'draft',
    pendingGenerationId: panelView.kind === 'pending' ? panelView.job.generationId : null,
  };
};
