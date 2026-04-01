/**
 * 归元洗髓前端共享状态
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：集中定义归元洗髓按钮的任务态映射、禁用口径与结果展示语义。
 * 2. 做什么：把“无道具 / 伙伴锁定 / 当前有进行中的洗髓任务”这些高频判断从组件 JSX 中抽离，避免重复分支散落。
 * 3. 不做什么：不发请求、不持有 React 状态，也不直接渲染 DOM。
 *
 * 输入/输出：
 * - 输入：归元洗髓状态 DTO、当前伙伴 ID、是否有洗髓露、是否被业务锁定。
 * - 输出：按钮文案、禁用态与结果提示所需的稳定语义。
 *
 * 数据流/状态流：
 * API / WebSocket / 伙伴总览 -> 本模块纯函数 -> PartnerModal 概览区按钮与结果提示。
 *
 * 复用设计说明：
 * - 按钮禁用与结果态判断统一从这里出，避免桌面/移动端或后续二次入口再复制一套逻辑。
 * - `currentJob.partnerId` 的目标判断也收口在这里，后续如果支持多入口共用不需要再改组件层。
 *
 * 关键边界条件与坑点：
 * 1. `pending` 只应阻断新的洗髓提交，不能把已完成但未读的结果也当成“进行中”。
 * 2. 只有当前伙伴命中 `currentJob.partnerId` 时才显示“洗髓中”，否则会把其他伙伴的任务误投影到当前详情。
 */
import type { PartnerReboneJobDto, PartnerReboneStatusDto } from '../../../../services/api';

export type PartnerReboneActionState = {
  buttonText: string;
  disabled: boolean;
  disabledReason: string | null;
  pendingJob: PartnerReboneJobDto | null;
};

export const resolvePartnerReboneActionState = (params: {
  status: PartnerReboneStatusDto | null;
  partnerId: number | null;
  hasConsumable: boolean;
  partnerLocked: boolean;
}): PartnerReboneActionState => {
  const pendingJob = params.status?.currentJob?.status === 'pending'
    ? params.status.currentJob
    : null;
  const isCurrentPartnerPending = Boolean(
    pendingJob
    && params.partnerId
    && pendingJob.partnerId === params.partnerId,
  );

  if (pendingJob) {
    return {
      buttonText: isCurrentPartnerPending ? '洗髓中' : '归元洗髓',
      disabled: true,
      disabledReason: isCurrentPartnerPending ? '当前伙伴正在洗髓中' : '当前已有其他伙伴在洗髓中',
      pendingJob,
    };
  }

  if (!params.hasConsumable) {
    return {
      buttonText: '归元洗髓',
      disabled: true,
      disabledReason: '当前没有可用的归元洗髓露',
      pendingJob,
    };
  }

  if (params.partnerLocked) {
    return {
      buttonText: '归元洗髓',
      disabled: true,
      disabledReason: '当前伙伴不可洗髓',
      pendingJob,
    };
  }

  return {
    buttonText: '归元洗髓',
    disabled: false,
    disabledReason: null,
    pendingJob: null,
  };
};

export const resolvePartnerReboneUnreadResultJob = (
  status: PartnerReboneStatusDto | null,
): PartnerReboneJobDto | null => {
  if (!status?.hasUnreadResult) return null;
  const currentJob = status.currentJob;
  if (!currentJob || currentJob.status === 'pending') return null;
  return currentJob;
};
