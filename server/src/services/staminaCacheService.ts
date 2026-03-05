/**
 * 体力 Redis 缓存服务
 *
 * 作用：
 *   在 Redis 中维护角色体力的实时状态，供挂机系统每场战斗实时扣减，
 *   以及其他系统（PVP、副本、前端）读取准确体力值。
 *
 * 不做的事：
 *   不替代 staminaService 的 DB 写入逻辑，DB 写入仍由各调用方负责。
 *
 * 数据流：
 *   读取：内存 → Redis → DB（applyStaminaRecoveryByCharacterId）→ 回填 Redis
 *   扣减：Lua 原子脚本直接操作 Redis JSON，同时更新内存
 *   校准：flushBuffer 写 DB 后调用 setCachedStamina 用 DB 实际值刷新缓存
 *
 * 关键边界条件：
 *   1. Redis 不可用时所有函数降级返回 null，调用方需 fallback 到 DB
 *   2. 进程重启时应调用 clearAllStaminaCache 清除可能过期的缓存
 *   3. Lua 脚本中的恢复计算与 staminaService 保持一致（tick 间隔、每 tick 恢复量、上限）
 */

import { redis } from '../config/redis.js';
import {
  STAMINA_MAX,
  STAMINA_RECOVER_PER_TICK,
  STAMINA_RECOVER_INTERVAL_SEC,
  type StaminaRecoveryState,
} from './staminaService.js';

// ============================================
// 常量
// ============================================

const KEY_PREFIX = 'stamina:';
const CACHE_TTL_SEC = 600; // 10 分钟兜底过期

/** 内存缓存层（减少 Redis 往返） */
const memoryCache = new Map<number, { stamina: number; recoverAtMs: number; maxStamina: number; expiresAt: number }>();
const MEMORY_TTL_MS = 5_000; // 5 秒，挂机场景下体力变化频繁，内存 TTL 不宜过长

// ============================================
// 内部工具
// ============================================

function cacheKey(characterId: number): string {
  return `${KEY_PREFIX}${characterId}`;
}

/**
 * 根据 recoverAt 时间戳计算当前实际体力（含恢复量）
 *
 * 复用 staminaService 的 tick 逻辑，保持一致：
 *   elapsed = now - recoverAt
 *   ticks = floor(elapsed / interval)
 *   recovered = ticks * perTick
 *   stamina = min(max, stamina + recovered)
 */
function applyRecovery(
  stamina: number,
  recoverAtMs: number,
  nowMs: number,
  maxStamina: number,
): { stamina: number; recoverAtMs: number; maxStamina: number } {
  const resolvedMaxStamina = Math.max(1, Math.floor(Number(maxStamina) || STAMINA_MAX));
  if (stamina >= resolvedMaxStamina) return { stamina: resolvedMaxStamina, recoverAtMs, maxStamina: resolvedMaxStamina };
  const intervalMs = STAMINA_RECOVER_INTERVAL_SEC * 1000;
  if (intervalMs <= 0 || STAMINA_RECOVER_PER_TICK <= 0) return { stamina, recoverAtMs, maxStamina: resolvedMaxStamina };

  const elapsedMs = Math.max(0, nowMs - recoverAtMs);
  const ticks = Math.floor(elapsedMs / intervalMs);
  if (ticks <= 0) return { stamina, recoverAtMs, maxStamina: resolvedMaxStamina };

  const recovered = ticks * STAMINA_RECOVER_PER_TICK;
  const nextStamina = Math.min(resolvedMaxStamina, stamina + recovered);
  const nextRecoverAtMs = nextStamina >= resolvedMaxStamina ? nowMs : recoverAtMs + ticks * intervalMs;
  return { stamina: nextStamina, recoverAtMs: nextRecoverAtMs, maxStamina: resolvedMaxStamina };
}

// ============================================
// Lua 脚本：原子扣减体力
// ============================================

/**
 * Lua 脚本：原子读取 → 恢复计算 → 扣减 → 写回
 *
 * KEYS[1] = stamina:{characterId}
 * ARGV[1] = delta（扣减量）
 * ARGV[2] = nowMs（当前时间戳 ms）
 * ARGV[3] = STAMINA_MAX
 * ARGV[4] = STAMINA_RECOVER_PER_TICK
 * ARGV[5] = STAMINA_RECOVER_INTERVAL_MS
 * ARGV[6] = CACHE_TTL_SEC
 *
 * 返回：扣减后的体力值（已含恢复），-1 表示 key 不存在
 */
const DECR_STAMINA_LUA = `
local raw = redis.call('GET', KEYS[1])
if not raw then return -1 end

local data = cjson.decode(raw)
local stamina = tonumber(data.stamina) or 0
local recoverAtMs = tonumber(data.recoverAtMs) or 0
local nowMs = tonumber(ARGV[2])
local maxStamina = tonumber(data.maxStamina) or tonumber(ARGV[3])
local perTick = tonumber(ARGV[4])
local intervalMs = tonumber(ARGV[5])
local ttl = tonumber(ARGV[6])
local delta = tonumber(ARGV[1])

-- 恢复计算
if stamina < maxStamina and intervalMs > 0 and perTick > 0 then
  local elapsed = nowMs - recoverAtMs
  if elapsed < 0 then elapsed = 0 end
  local ticks = math.floor(elapsed / intervalMs)
  if ticks > 0 then
    local recovered = ticks * perTick
    stamina = math.min(maxStamina, stamina + recovered)
    if stamina >= maxStamina then
      recoverAtMs = nowMs
    else
      recoverAtMs = recoverAtMs + ticks * intervalMs
    end
  end
end

-- 扣减
stamina = math.max(0, stamina - delta)

-- 扣减后体力不满，更新 recoverAt 为当前时间（开始新的恢复计时）
if stamina < maxStamina then
  recoverAtMs = nowMs
end

data.stamina = stamina
data.recoverAtMs = recoverAtMs
data.maxStamina = maxStamina
redis.call('SET', KEYS[1], cjson.encode(data), 'EX', ttl)
return stamina
`;

// ============================================
// 公开 API
// ============================================

export interface StaminaCacheState {
  characterId: number;
  stamina: number;
  recoverAtMs: number;
  maxStamina: number;
}

/**
 * 从缓存读取体力状态（含恢复计算）
 *
 * 读取顺序：内存 → Redis → 返回 null（调用方需 fallback 到 DB 并调用 setCachedStamina 回填）
 *
 * 返回 null 表示缓存未命中，调用方应走 DB 路径
 */
export async function getCachedStamina(characterId: number): Promise<StaminaCacheState | null> {
  // 1. 内存层
  const mem = memoryCache.get(characterId);
  if (mem && mem.expiresAt > Date.now()) {
    const nowMs = Date.now();
    const { stamina, recoverAtMs, maxStamina } = applyRecovery(mem.stamina, mem.recoverAtMs, nowMs, mem.maxStamina);
    return { characterId, stamina, recoverAtMs, maxStamina };
  }

  // 2. Redis 层
  try {
    const raw = await redis.get(cacheKey(characterId));
    if (!raw) return null;

    const data = JSON.parse(raw) as { stamina: number; recoverAtMs: number; maxStamina?: number };
    const maxStamina = Math.max(1, Math.floor(Number(data.maxStamina) || STAMINA_MAX));
    const nowMs = Date.now();
    const { stamina, recoverAtMs } = applyRecovery(data.stamina, data.recoverAtMs, nowMs, maxStamina);

    // 回填内存
    memoryCache.set(characterId, { stamina, recoverAtMs, maxStamina, expiresAt: Date.now() + MEMORY_TTL_MS });

    return { characterId, stamina, recoverAtMs, maxStamina };
  } catch {
    return null;
  }
}

/**
 * 设置缓存中的体力值（用于 DB 写入后校准、启动挂机时初始化等）
 */
export async function setCachedStamina(
  characterId: number,
  stamina: number,
  recoverAt: Date,
  maxStamina: number,
): Promise<void> {
  const resolvedMaxStamina = Math.max(1, Math.floor(Number(maxStamina) || STAMINA_MAX));
  const recoverAtMs = recoverAt.getTime();
  const payload = JSON.stringify({ stamina, recoverAtMs, maxStamina: resolvedMaxStamina });

  // 同时写 Redis 和内存
  memoryCache.set(characterId, { stamina, recoverAtMs, maxStamina: resolvedMaxStamina, expiresAt: Date.now() + MEMORY_TTL_MS });

  try {
    await redis.set(cacheKey(characterId), payload, 'EX', CACHE_TTL_SEC);
  } catch {
    // Redis 不可用时仅保留内存缓存
  }
}

/**
 * 原子扣减缓存中的体力（用于挂机每场战斗后实时扣减）
 *
 * 返回扣减后的体力值，null 表示缓存不存在（需先 setCachedStamina 初始化）
 */
export async function decrCachedStamina(characterId: number, delta: number): Promise<number | null> {
  const intervalMs = STAMINA_RECOVER_INTERVAL_SEC * 1000;

  try {
    const result = await redis.eval(
      DECR_STAMINA_LUA,
      1,
      cacheKey(characterId),
      delta,
      Date.now(),
      STAMINA_MAX,
      STAMINA_RECOVER_PER_TICK,
      intervalMs,
      CACHE_TTL_SEC,
    ) as number;

    if (result === -1) return null;

    // 同步更新内存缓存
    const previousMaxStamina = memoryCache.get(characterId)?.maxStamina ?? STAMINA_MAX;
    memoryCache.set(characterId, {
      stamina: result,
      recoverAtMs: Date.now(),
      maxStamina: previousMaxStamina,
      expiresAt: Date.now() + MEMORY_TTL_MS,
    });

    return result;
  } catch {
    return null;
  }
}

/**
 * 删除指定角色的体力缓存
 */
export async function invalidateStaminaCache(characterId: number): Promise<void> {
  memoryCache.delete(characterId);
  try {
    await redis.del(cacheKey(characterId));
  } catch {
    // 忽略
  }
}

/**
 * 清除所有体力缓存（服务启动时调用，防止残留脏数据）
 *
 * 使用 SCAN 遍历 stamina:* 键，避免 KEYS 命令阻塞
 */
export async function clearAllStaminaCache(): Promise<void> {
  memoryCache.clear();
  try {
    let cursor = '0';
    do {
      const [nextCursor, keys] = await redis.scan(cursor, 'MATCH', `${KEY_PREFIX}*`, 'COUNT', 100);
      cursor = nextCursor;
      if (keys.length > 0) {
        await redis.del(...keys);
      }
    } while (cursor !== '0');
  } catch {
    // 忽略
  }
}

/**
 * 将 StaminaCacheState 转换为 StaminaRecoveryState 格式（兼容现有调用方）
 */
export function toRecoveryState(cache: StaminaCacheState): StaminaRecoveryState {
  return {
    characterId: cache.characterId,
    stamina: cache.stamina,
    maxStamina: cache.maxStamina,
    recovered: 0,
    changed: false,
    staminaRecoverAt: new Date(cache.recoverAtMs),
  };
}
