/**
 * 体力恢复服务
 *
 * 作用：
 *   管理角色体力的恢复计算与持久化。每次读取体力时根据 stamina_recover_at
 *   时间戳惰性计算已恢复量，并写回 DB。
 *
 * 输入：characterId / userId
 * 输出：StaminaRecoveryState（当前体力、恢复量、是否变更）
 *
 * 数据流：
 *   读取：Redis 缓存（staminaCacheService）→ 命中则直接返回
 *         → 未命中则查 DB → 计算恢复 → 写 DB → 回填缓存
 *   事务内（applyStaminaRecoveryTx）：始终走 DB（需行锁），提交后由调用方同步缓存
 *
 * 关键边界条件：
 *   1. Redis 不可用时自动降级到纯 DB 路径，不影响核心功能
 *   2. 事务内操作不走缓存（需要 FOR UPDATE 行锁保证一致性）
 */

import { query } from '../config/database.js';
import { getCachedStamina, setCachedStamina, toRecoveryState } from './staminaCacheService.js';
import { calcCharacterStaminaMaxByInsightLevel, STAMINA_BASE_MAX } from './shared/staminaRules.js';

const toPositiveInt = (value: string | undefined, fallback: number): number => {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  const v = Math.floor(n);
  return v > 0 ? v : fallback;
};

const toNonNegativeInt = (value: unknown, fallback: number): number => {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  const v = Math.floor(n);
  return v >= 0 ? v : fallback;
};

const parseTime = (value: unknown, fallbackMs: number): { ms: number; fallbackUsed: boolean } => {
  if (value instanceof Date) return { ms: value.getTime(), fallbackUsed: false };
  if (typeof value === 'string' || typeof value === 'number') {
    const parsed = new Date(value).getTime();
    if (Number.isFinite(parsed)) return { ms: parsed, fallbackUsed: false };
  }
  return { ms: fallbackMs, fallbackUsed: true };
};

export const STAMINA_MAX = STAMINA_BASE_MAX;
export const STAMINA_RECOVER_PER_TICK = toPositiveInt(process.env.STAMINA_RECOVER_PER_TICK, 1);
export const STAMINA_RECOVER_INTERVAL_SEC = toPositiveInt(process.env.STAMINA_RECOVER_INTERVAL_SEC, 300);
const STAMINA_RECOVER_INTERVAL_MS = STAMINA_RECOVER_INTERVAL_SEC * 1000;

export type StaminaRecoveryState = {
  characterId: number;
  stamina: number;
  maxStamina: number;
  recovered: number;
  changed: boolean;
  staminaRecoverAt: Date;
};

type QueryRunner = (text: string, params?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }>;

/**
 * 从 DB 行数据计算恢复并写回（内部核心逻辑，不走缓存）
 */
const applyRecoveryFromRow = async (
  runQuery: QueryRunner,
  row: Record<string, unknown>,
): Promise<StaminaRecoveryState | null> => {
  const characterId = toNonNegativeInt(row.id, 0);
  if (characterId <= 0) return null;

  const nowMs = Date.now();
  const rawStamina = toNonNegativeInt(row.stamina, 0);
  const insightLevel = toNonNegativeInt(row.insight_level, 0);
  const staminaMax = calcCharacterStaminaMaxByInsightLevel(insightLevel);
  const currentStamina = Math.min(staminaMax, rawStamina);
  const parsedRecoverAt = parseTime(row.stamina_recover_at, nowMs);

  let nextStamina = currentStamina;
  let nextRecoverAtMs = parsedRecoverAt.ms;
  let recovered = 0;

  if (currentStamina < staminaMax && STAMINA_RECOVER_INTERVAL_MS > 0 && STAMINA_RECOVER_PER_TICK > 0) {
    const elapsedMs = Math.max(0, nowMs - parsedRecoverAt.ms);
    const ticks = Math.floor(elapsedMs / STAMINA_RECOVER_INTERVAL_MS);
    if (ticks > 0) {
      const recoveredTotal = ticks * STAMINA_RECOVER_PER_TICK;
      nextStamina = Math.min(staminaMax, currentStamina + recoveredTotal);
      nextRecoverAtMs = nextStamina >= staminaMax ? nowMs : parsedRecoverAt.ms + ticks * STAMINA_RECOVER_INTERVAL_MS;
      recovered = Math.max(0, nextStamina - currentStamina);
    }
  }

  const staminaChanged = rawStamina !== nextStamina;
  const recoverAtChanged = parsedRecoverAt.fallbackUsed || nextRecoverAtMs !== parsedRecoverAt.ms;
  const changed = staminaChanged || recoverAtChanged;

  if (changed) {
    if (staminaChanged) {
      await runQuery(
        'UPDATE characters SET stamina = $2, stamina_recover_at = $3, updated_at = CURRENT_TIMESTAMP WHERE id = $1',
        [characterId, nextStamina, new Date(nextRecoverAtMs)],
      );
    } else {
      await runQuery('UPDATE characters SET stamina_recover_at = $2 WHERE id = $1', [characterId, new Date(nextRecoverAtMs)]);
    }
  }

  const state: StaminaRecoveryState = {
    characterId,
    stamina: nextStamina,
    maxStamina: staminaMax,
    recovered,
    changed,
    staminaRecoverAt: new Date(nextRecoverAtMs),
  };

  // 回填缓存（DB 写入后同步）
  await setCachedStamina(characterId, nextStamina, new Date(nextRecoverAtMs), staminaMax);

  return state;
};

/**
 * 从 DB 查询并计算恢复（内部函数，不走缓存）
 */
const applyRecoveryByCharacterIdFromDB = async (
  runQuery: QueryRunner,
  characterId: number,
  lockRow: boolean,
): Promise<StaminaRecoveryState | null> => {
  if (!Number.isFinite(characterId) || characterId <= 0) return null;
  const selectSql = lockRow
    ? `
      SELECT c.id, c.stamina, c.stamina_recover_at, COALESCE(cip.level, 0) AS insight_level
      FROM characters c
      LEFT JOIN character_insight_progress cip ON cip.character_id = c.id
      WHERE c.id = $1
      LIMIT 1
      FOR UPDATE OF c
    `
    : `
      SELECT c.id, c.stamina, c.stamina_recover_at, COALESCE(cip.level, 0) AS insight_level
      FROM characters c
      LEFT JOIN character_insight_progress cip ON cip.character_id = c.id
      WHERE c.id = $1
      LIMIT 1
    `;
  const rowRes = await runQuery(selectSql, [characterId]);
  const row = rowRes.rows[0];
  if (!row) return null;
  return applyRecoveryFromRow(runQuery, row);
};

/**
 * 按角色 ID 获取体力状态（含恢复计算）
 *
 * 优先从 Redis 缓存读取，未命中则走 DB 并回填缓存
 */
export const applyStaminaRecoveryByCharacterId = async (characterId: number): Promise<StaminaRecoveryState | null> => {
  if (!Number.isFinite(characterId) || characterId <= 0) return null;

  // 优先走缓存
  const cached = await getCachedStamina(characterId);
  if (cached) return toRecoveryState(cached);

  // 缓存未命中，走 DB（applyRecoveryFromRow 内部会回填缓存）
  return applyRecoveryByCharacterIdFromDB((text, params) => query(text, params), characterId, false);
};

/**
 * 按用户 ID 获取体力状态（含恢复计算）
 *
 * 需先查 characterId，再走缓存路径
 */
export const applyStaminaRecoveryByUserId = async (userId: number): Promise<StaminaRecoveryState | null> => {
  if (!Number.isFinite(userId) || userId <= 0) return null;
  const rowRes = await query(
    `
      SELECT c.id, c.stamina, c.stamina_recover_at, COALESCE(cip.level, 0) AS insight_level
      FROM characters c
      LEFT JOIN character_insight_progress cip ON cip.character_id = c.id
      WHERE c.user_id = $1
      LIMIT 1
    `,
    [userId],
  );
  const row = rowRes.rows[0];
  if (!row) return null;

  const characterId = toNonNegativeInt(row.id, 0);
  if (characterId <= 0) return null;

  // 尝试缓存
  const cached = await getCachedStamina(characterId);
  if (cached) return toRecoveryState(cached);

  // 缓存未命中，用已查到的 row 直接计算（避免重复查库）
  return applyRecoveryFromRow((text, params) => query(text, params), row);
};

/**
 * 事务内获取体力状态（带行锁，不走缓存）
 *
 * 事务需要 FOR UPDATE 行锁保证一致性，不适合走缓存。
 * 调用方在事务提交后应自行调用 setCachedStamina 同步缓存。
 */
export const applyStaminaRecoveryTx = async (characterId: number): Promise<StaminaRecoveryState | null> => {
  return applyRecoveryByCharacterIdFromDB((text, params) => query(text, params), characterId, true);
};
