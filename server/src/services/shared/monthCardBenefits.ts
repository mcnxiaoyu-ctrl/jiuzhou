/**
 * 月卡权益共享模块
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：集中维护月卡静态定义读取、激活态查询与数值权益提取，避免各业务服务分别手写月卡规则。
 * 2. 做什么：为冷却缩减、体力恢复、角色属性加成、挂机时长上限等入口提供统一权益配置，减少同一数值散落在服务层与前端。
 * 3. 不做什么：不处理月卡购买、续期、领取奖励，也不负责前端展示文案拼装。
 *
 * 输入/输出：
 * - 输入：月卡 ID、角色 ID、基础冷却秒数、基础福源、当前时间。
 * - 输出：月卡定义、共享权益快照、当前有效权益窗口，以及折算后的实际冷却秒数/福源值/挂机时长上限小时数。
 *
 * 数据流/状态流：
 * month_card.json -> getMonthCardDefinitionById / getMonthCardBenefitValues；
 * character_id + month_card_ownership -> getActiveMonthCardCooldownReductionRate / getMonthCardActiveMapByCharacterIds；
 * 基础冷却秒数 + 缩减比例 -> applyCooldownReductionSeconds / convertCooldownSecondsToHours；
 * 基础福源 + 月卡加成 -> applyMonthCardFuyuanBonus。
 *
 * 关键边界条件与坑点：
 * 1. 冷却缩减比例来自静态配置，必须先做 0 到 1 的裁剪，避免脏数据把冷却算成负数或放大。
 * 2. 业务层展示与拦截要共享同一折算结果，因此统一以“秒”为最小单位计算，再衍生小时展示值。
 * 3. 查询激活态时只认 `expire_at > now` 的有效月卡，不能把已过期但未清理的记录继续当成权益来源。
 */
import { query } from '../../config/database.js';
import {
  getMonthCardDefinitions,
  type MonthCardDef,
} from '../staticConfigLoader.js';

const HOUR_SECONDS = 3_600;

export const DEFAULT_MONTH_CARD_ID = 'monthcard-001';
export const DEFAULT_MONTH_CARD_ITEM_DEF_ID = 'cons-monthcard-001';

export type MonthCardBenefitValues = {
  cooldownReductionRate: number;
  staminaRecoveryRate: number;
  fuyuanBonus: number;
  idleMaxDurationHours: number;
};

export type MonthCardBenefitWindow = {
  startAtMs: number | null;
  expireAtMs: number | null;
};

type MonthCardActiveCharacterRow = {
  character_id: number | string;
};

const EMPTY_MONTH_CARD_BENEFITS: MonthCardBenefitValues = Object.freeze({
  cooldownReductionRate: 0,
  staminaRecoveryRate: 0,
  fuyuanBonus: 0,
  idleMaxDurationHours: 0,
});

const normalizeCharacterIds = (characterIds: number[]): number[] => {
  return [...new Set(characterIds.map((id) => Math.floor(Number(id))).filter((id) => Number.isFinite(id) && id > 0))];
};

const normalizeNumber = (value: number | string | undefined): number => {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  if (typeof value === 'string') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
};

const clampReductionRate = (reductionRate: number): number => {
  if (!Number.isFinite(reductionRate)) return 0;
  if (reductionRate <= 0) return 0;
  if (reductionRate >= 1) return 1;
  return reductionRate;
};

const clampNonNegativeInteger = (value: number): number => {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.floor(value);
};

const parseDateMs = (value: Date | string | number | null | undefined): number | null => {
  if (value instanceof Date) {
    const timestamp = value.getTime();
    return Number.isFinite(timestamp) ? timestamp : null;
  }
  if (typeof value === 'string' || typeof value === 'number') {
    const timestamp = new Date(value).getTime();
    return Number.isFinite(timestamp) ? timestamp : null;
  }
  return null;
};

export const getMonthCardDefinitionById = (monthCardId: string): MonthCardDef | null => {
  const defs = getMonthCardDefinitions();
  return defs.find((item) => item.id === monthCardId && item.enabled !== false) ?? null;
};

export const getMonthCardBenefitValues = (
  monthCardId: string = DEFAULT_MONTH_CARD_ID,
): MonthCardBenefitValues => {
  const definition = getMonthCardDefinitionById(monthCardId);
  if (!definition) return EMPTY_MONTH_CARD_BENEFITS;

  return {
    cooldownReductionRate: clampReductionRate(normalizeNumber(definition.cooldown_reduction_rate)),
    staminaRecoveryRate: clampReductionRate(normalizeNumber(definition.stamina_recovery_rate)),
    fuyuanBonus: clampNonNegativeInteger(normalizeNumber(definition.fuyuan_bonus)),
    idleMaxDurationHours: clampNonNegativeInteger(normalizeNumber(definition.idle_max_duration_hours)),
  };
};

export const getMonthCardCooldownReductionRate = (
  monthCardId: string = DEFAULT_MONTH_CARD_ID,
): number => {
  return getMonthCardBenefitValues(monthCardId).cooldownReductionRate;
};

export const getMonthCardStaminaRecoveryRate = (
  monthCardId: string = DEFAULT_MONTH_CARD_ID,
): number => {
  return getMonthCardBenefitValues(monthCardId).staminaRecoveryRate;
};

export const getMonthCardFuyuanBonus = (
  monthCardId: string = DEFAULT_MONTH_CARD_ID,
): number => {
  return getMonthCardBenefitValues(monthCardId).fuyuanBonus;
};

export const getMonthCardIdleMaxDurationHours = (
  monthCardId: string = DEFAULT_MONTH_CARD_ID,
): number => {
  return getMonthCardBenefitValues(monthCardId).idleMaxDurationHours;
};

export const applyCooldownReductionSeconds = (
  baseCooldownSeconds: number,
  cooldownReductionRate: number,
): number => {
  const safeBaseCooldownSeconds = Math.max(0, Math.ceil(baseCooldownSeconds));
  const normalizedRate = clampReductionRate(cooldownReductionRate);
  if (safeBaseCooldownSeconds <= 0 || normalizedRate <= 0) {
    return safeBaseCooldownSeconds;
  }
  return Math.max(0, Math.ceil(safeBaseCooldownSeconds * (1 - normalizedRate)));
};

export const convertCooldownSecondsToHours = (cooldownSeconds: number): number => {
  const safeCooldownSeconds = Math.max(0, cooldownSeconds);
  return Math.round((safeCooldownSeconds / HOUR_SECONDS) * 10) / 10;
};

export const applyMonthCardFuyuanBonus = (
  baseFuyuan: number,
  fuyuanBonus: number,
): number => {
  const safeBaseFuyuan = Math.max(0, Math.floor(baseFuyuan));
  const safeFuyuanBonus = clampNonNegativeInteger(fuyuanBonus);
  return safeBaseFuyuan + safeFuyuanBonus;
};

export const normalizeMonthCardBenefitWindow = (
  startAtRaw: Date | string | number | null | undefined,
  expireAtRaw: Date | string | number | null | undefined,
): MonthCardBenefitWindow => {
  const expireAtMs = parseDateMs(expireAtRaw);
  if (expireAtMs === null) {
    return {
      startAtMs: null,
      expireAtMs: null,
    };
  }

  return {
    startAtMs: parseDateMs(startAtRaw),
    expireAtMs,
  };
};

export const isMonthCardBenefitWindowActiveAt = (
  window: MonthCardBenefitWindow,
  nowMs: number,
): boolean => {
  if (!Number.isFinite(nowMs) || window.expireAtMs === null) return false;
  if (nowMs >= window.expireAtMs) return false;
  if (window.startAtMs !== null && nowMs < window.startAtMs) return false;
  return true;
};

export const getActiveMonthCardCooldownReductionRate = async (
  characterId: number,
  monthCardId: string = DEFAULT_MONTH_CARD_ID,
  now: Date = new Date(),
): Promise<number> => {
  const reductionRate = getMonthCardCooldownReductionRate(monthCardId);
  if (reductionRate <= 0) return 0;

  const result = await query(
    `
      SELECT 1
      FROM month_card_ownership
      WHERE character_id = $1
        AND month_card_id = $2
        AND expire_at > $3::timestamptz
      LIMIT 1
    `,
    [characterId, monthCardId, now.toISOString()],
  );

  return result.rows.length > 0 ? reductionRate : 0;
};

export const getMonthCardActiveMapByCharacterIds = async (
  characterIds: number[],
  monthCardId: string = DEFAULT_MONTH_CARD_ID,
  now: Date = new Date(),
): Promise<Map<number, boolean>> => {
  const ids = normalizeCharacterIds(characterIds);
  const result = new Map<number, boolean>();

  for (const id of ids) {
    result.set(id, false);
  }
  if (ids.length === 0) return result;

  const rows = await query(
    `
      SELECT character_id
      FROM month_card_ownership
      WHERE character_id = ANY($1::int[])
        AND month_card_id = $2
        AND expire_at > $3::timestamptz
    `,
    [ids, monthCardId, now.toISOString()],
  );

  for (const row of rows.rows as MonthCardActiveCharacterRow[]) {
    const characterId = Math.floor(Number(row.character_id));
    if (!Number.isFinite(characterId) || characterId <= 0) continue;
    result.set(characterId, true);
  }

  return result;
};
