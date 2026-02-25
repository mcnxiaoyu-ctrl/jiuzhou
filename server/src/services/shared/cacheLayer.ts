/**
 * 通用双层缓存工具（内存 + Redis）
 *
 * 作用：
 *   提供统一的缓存抽象，减少各服务手写缓存的重复代码。
 *   支持内存 → Redis → loader 三级读取，写入时同时更新两层。
 *
 * 不做的事：
 *   不处理业务逻辑（恢复计算、签名校验等），这些由各服务自行实现。
 *
 * 数据流：
 *   get: 内存（TTL 内）→ Redis（TTL 内）→ loader（DB 查询）→ 回填两层
 *   set: 同时写内存 + Redis
 *   invalidate: 同时删内存 + Redis
 *
 * 关键边界条件：
 *   1. Redis 不可用时降级到仅内存缓存 + loader，不抛异常
 *   2. loader 返回 null 时不缓存（避免缓存穿透需调用方自行处理）
 *   3. 内存缓存无大小限制，长期运行需关注内存占用（可通过 invalidateAll 手动清理）
 */

import { redis } from '../../config/redis.js';

// ============================================
// 类型定义
// ============================================

export interface CacheLayerOptions<T> {
  /** Redis 键前缀（如 'equip:snapshot:'） */
  keyPrefix: string;
  /** Redis TTL（秒） */
  redisTtlSec: number;
  /** 内存 TTL（毫秒） */
  memoryTtlMs: number;
  /** 缓存未命中时的数据加载函数，返回 null 表示数据不存在 */
  loader: (id: number) => Promise<T | null>;
  /** 自定义序列化（默认 JSON.stringify） */
  serialize?: (value: T) => string;
  /** 自定义反序列化（默认 JSON.parse） */
  deserialize?: (raw: string) => T;
}

export interface CacheLayer<T> {
  /** 读取缓存，未命中则调用 loader 加载并回填 */
  get: (id: number) => Promise<T | null>;
  /** 直接设置缓存值（跳过 loader） */
  set: (id: number, value: T) => Promise<void>;
  /** 删除指定 id 的缓存 */
  invalidate: (id: number) => Promise<void>;
  /** 清除所有内存缓存（Redis 缓存依赖 TTL 自然过期） */
  invalidateAll: () => void;
}

// ============================================
// 工厂函数
// ============================================

/**
 * 创建一个双层缓存实例
 *
 * 复用点：所有需要 内存+Redis 双层缓存的场景均可使用，
 *   包括角色属性、装备快照、功法配置等。
 *
 * 使用示例：
 *   const equipCache = createCacheLayer({
 *     keyPrefix: 'equip:snapshot:',
 *     redisTtlSec: 120,
 *     memoryTtlMs: 30_000,
 *     loader: (characterId) => loadEquipmentFromDB(characterId),
 *   });
 *   const data = await equipCache.get(characterId);
 */
export function createCacheLayer<T>(options: CacheLayerOptions<T>): CacheLayer<T> {
  const {
    keyPrefix,
    redisTtlSec,
    memoryTtlMs,
    loader,
    serialize = JSON.stringify,
    deserialize = JSON.parse as (raw: string) => T,
  } = options;

  const memoryCache = new Map<number, { payload: T; expiresAt: number }>();

  function redisKey(id: number): string {
    return `${keyPrefix}${id}`;
  }

  async function get(id: number): Promise<T | null> {
    // 1. 内存层
    const mem = memoryCache.get(id);
    if (mem && mem.expiresAt > Date.now()) {
      return mem.payload;
    }
    // 内存过期则删除
    if (mem) memoryCache.delete(id);

    // 2. Redis 层
    try {
      const raw = await redis.get(redisKey(id));
      if (raw !== null) {
        const value = deserialize(raw);
        memoryCache.set(id, { payload: value, expiresAt: Date.now() + memoryTtlMs });
        return value;
      }
    } catch {
      // Redis 不可用，继续走 loader
    }

    // 3. Loader（DB 查询）
    const loaded = await loader(id);
    if (loaded === null) return null;

    // 回填两层
    memoryCache.set(id, { payload: loaded, expiresAt: Date.now() + memoryTtlMs });
    try {
      await redis.set(redisKey(id), serialize(loaded), 'EX', redisTtlSec);
    } catch {
      // Redis 不可用时仅保留内存缓存
    }

    return loaded;
  }

  async function set(id: number, value: T): Promise<void> {
    memoryCache.set(id, { payload: value, expiresAt: Date.now() + memoryTtlMs });
    try {
      await redis.set(redisKey(id), serialize(value), 'EX', redisTtlSec);
    } catch {
      // Redis 不可用时仅保留内存缓存
    }
  }

  async function invalidate(id: number): Promise<void> {
    memoryCache.delete(id);
    try {
      await redis.del(redisKey(id));
    } catch {
      // 忽略
    }
  }

  function invalidateAll(): void {
    memoryCache.clear();
  }

  return { get, set, invalidate, invalidateAll };
}
