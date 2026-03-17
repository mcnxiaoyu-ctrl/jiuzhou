/**
 * 挂机时长上限共享模块
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：集中维护离线挂机的基础时长上限、月卡加成上限与统一校验逻辑，避免路由、测试和配置读取各写一份范围判断。
 * 2. 做什么：提供“角色当前可挂机多久”的共享查询结果，供配置读取与启动/保存入口复用同一口径。
 * 3. 不做什么：不负责挂机配置持久化，不处理前端展示文案，也不启动/停止挂机会话。
 *
 * 输入/输出：
 * - 输入：角色 ID、待校验的挂机时长毫秒值、月卡 ID。
 * - 输出：当前时长上限快照 `{ monthCardActive, maxDurationMs }`，以及纯函数级别的合法性判断结果。
 *
 * 数据流/状态流：
 * month_card.json -> monthCardBenefits -> resolveIdleDurationLimitByCharacter；
 * 路由请求 maxDurationMs + 当前上限 -> isIdleDurationMsWithinLimit。
 *
 * 关键边界条件与坑点：
 * 1. 月卡挂机时长上限属于“权益生效中的动态限制”，不能只看静态配置，必须结合角色当前是否存在有效月卡。
 * 2. 月卡提供的上限只能放宽、不能压低基础 8 小时上限，因此最终结果要与基础上限取更大值。
 */
import {
  DEFAULT_MONTH_CARD_ID,
  getMonthCardActiveMapByCharacterIds,
  getMonthCardBenefitValues,
} from './monthCardBenefits.js';

const HOUR_MS = 3_600_000;

export const MIN_IDLE_DURATION_MS = 60_000;
export const BASE_IDLE_MAX_DURATION_MS = 28_800_000;

export type IdleDurationLimitSnapshot = {
  monthCardActive: boolean;
  maxDurationMs: number;
};

export const getMonthCardIdleMaxDurationMs = (
  monthCardId: string = DEFAULT_MONTH_CARD_ID,
): number => {
  const benefitHours = getMonthCardBenefitValues(monthCardId).idleMaxDurationHours;
  return Math.max(0, benefitHours) * HOUR_MS;
};

export const resolveIdleMaxDurationMs = (
  monthCardActive: boolean,
  monthCardId: string = DEFAULT_MONTH_CARD_ID,
): number => {
  if (!monthCardActive) {
    return BASE_IDLE_MAX_DURATION_MS;
  }
  return Math.max(BASE_IDLE_MAX_DURATION_MS, getMonthCardIdleMaxDurationMs(monthCardId));
};

export const isIdleDurationMsWithinLimit = (
  durationMs: number,
  maxDurationMs: number,
): boolean => {
  return (
    Number.isFinite(durationMs) &&
    Number.isInteger(durationMs) &&
    durationMs >= MIN_IDLE_DURATION_MS &&
    durationMs <= maxDurationMs
  );
};

export const resolveIdleDurationLimitByCharacter = async (
  characterId: number,
  monthCardId: string = DEFAULT_MONTH_CARD_ID,
): Promise<IdleDurationLimitSnapshot> => {
  const activeMap = await getMonthCardActiveMapByCharacterIds([characterId], monthCardId);
  const monthCardActive = activeMap.get(characterId) === true;

  return {
    monthCardActive,
    maxDurationMs: resolveIdleMaxDurationMs(monthCardActive, monthCardId),
  };
};
