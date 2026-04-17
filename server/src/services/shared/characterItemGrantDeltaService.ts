import { afterTransactionCommit, query, withTransaction } from '../../config/database.js';
import { redis } from '../../config/redis.js';
import { itemService } from '../itemService.js';
import { sendSystemMail, type MailAttachItem } from '../mailService.js';
import type { GenerateOptions, GeneratedEquipment } from '../equipmentService.js';
import { createScopedLogger } from '../../utils/logger.js';
import { createSlowOperationLogger } from '../../utils/slowOperationLogger.js';
import { lockCharacterInventoryMutex } from '../inventoryMutex.js';
import { createCharacterBagSlotAllocatorFromSession } from './characterBagSlotAllocator.js';
import { createCharacterInventoryMutationContextFromSession } from './characterInventoryMutationContext.js';
import { createInventorySlotSession } from './inventorySlotSession.js';
import {
  buildCharacterItemGrantOverflowMailSourceRefId,
  claimCharacterItemGrantOverflowMailBatch,
  countPendingCharacterItemGrantOverflowMail,
  enqueueCharacterItemGrantOverflowMail,
  finalizeCharacterItemGrantOverflowMail,
  loadCharacterItemGrantOverflowMailForUpdate,
  restoreCharacterItemGrantOverflowMailAttempt,
  type CharacterItemGrantOverflowMailAttachment,
  type CharacterItemGrantOverflowMailOutboxEntry,
} from './characterItemGrantMailOutbox.js';

/**
 * 角色物品授予 Delta 聚合服务
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：把高频奖励链路里的普通物品 / 装备实例创建先聚合到 Redis，后台按角色批量 flush 到真实库存。
 * 2. 做什么：把“背包已满 -> 转系统邮件”从战斗结算热路径移到异步 flush 线程，避免结算线程为 `item_instance` 和邮件表持锁。
 * 3. 不做什么：不负责角色资源增量，也不负责任务/主线/成就推进；这些由独立 Delta 服务处理。
 *
 * 输入 / 输出：
 * - 输入：角色 ID、用户 ID、物品定义、数量、绑定态、获取来源与可序列化装备参数。
 * - 输出：无直接业务返回；副作用是写入 Redis Hash，并在 flush 时落到 `item_instance` / `mail`。
 *
 * 数据流 / 状态流：
 * 业务事务提交 -> `bufferCharacterItemGrantDeltas`
 * -> Redis `hash + dirty set` 合并
 * -> flush worker `main -> inflight`
 * -> 单角色事务内批量 `createItem`
 * -> 背包已满的部分统一转系统邮件
 * -> 成功 finalize / 失败 restore。
 *
 * 复用设计说明：
 * 1. 战斗掉落、秘境结算、后续任务奖励都可以复用同一套“资产先缓存、后台异步入库”的协议，避免每条奖励链路各写一套 Redis 结构。
 * 2. 高频变化点是“哪些场景产出什么物品”，不是 flush 细节，因此把编码、claim、邮件兜底、落库集中在这里最能减少重复维护。
 *
 * 关键边界条件与坑点：
 * 1. 必须按角色 claim，保证同一角色的装备随机生成、背包格子竞争、邮件补发都在单事务里串行完成。
 * 2. `equipOptions.preGeneratedEquipment` 必须一并序列化，否则自动分解判定后保留下来的装备会在 flush 时重新随机，导致前后语义不一致。
 */

type BufferedCharacterItemGrantEquipOptions = GenerateOptions & {
  preGeneratedEquipment?: GeneratedEquipment;
};

type BufferedCharacterItemGrantMetadata = Record<string, string | number | boolean | null | undefined>;

export type BufferedCharacterItemGrant = {
  characterId: number;
  userId: number;
  itemDefId: string;
  qty: number;
  bindType?: string;
  obtainedFrom: string;
  idleSessionId?: string;
  metadata?: BufferedCharacterItemGrantMetadata | null;
  quality?: string | null;
  qualityRank?: number | null;
  equipOptions?: BufferedCharacterItemGrantEquipOptions;
};

export type SimpleBufferedCharacterItemGrant = Omit<
  BufferedCharacterItemGrant,
  'characterId' | 'userId'
>;

type EncodedCharacterItemGrantPayload = {
  userId: number;
  itemDefId: string;
  bindType: string;
  obtainedFrom: string;
  idleSessionId: string | null;
  metadata: BufferedCharacterItemGrantMetadata | null;
  quality: string | null;
  qualityRank: number | null;
  equipOptions: BufferedCharacterItemGrantEquipOptions | null;
};

type NormalizedCharacterItemGrant = {
  characterId: number;
  payload: EncodedCharacterItemGrantPayload;
  qty: number;
};

export type PendingCharacterItemGrant = {
  itemDefId: string;
  qty: number;
  bindType: string;
  obtainedFrom: string;
  idleSessionId: string | null;
  metadata: BufferedCharacterItemGrantMetadata | null;
  quality: string | null;
  qualityRank: number | null;
};

type CharacterItemGrantOverflowFlushSummary = {
  batchSize: number;
  overflowCount: number;
  inventoryMutexWaitMs: number;
  inventoryMutexHoldMs: number;
};

type CharacterItemGrantFlushPhaseOneResult = CharacterItemGrantOverflowFlushSummary & {
  outboxEntries: CharacterItemGrantOverflowMailOutboxEntry[];
};

const ITEM_GRANT_DIRTY_INDEX_KEY = 'character:item-grant-delta:index';
const ITEM_GRANT_KEY_PREFIX = 'character:item-grant-delta:';
const ITEM_GRANT_INFLIGHT_KEY_PREFIX = 'character:item-grant-delta:inflight:';
const ITEM_GRANT_INFLIGHT_META_KEY_PREFIX = 'character:item-grant-delta:inflight-meta:';
const ITEM_GRANT_FLUSH_INTERVAL_MS = 1_000;
const ITEM_GRANT_FLUSH_BATCH_LIMIT = 100;
const ITEM_GRANT_MAIL_CHUNK_SIZE = 10;
const ITEM_GRANT_INFLIGHT_STALE_AFTER_MS = 5 * 60 * 1000;
const ITEM_GRANT_OUTBOX_BATCH_LIMIT = 20;
const ITEM_GRANT_FLUSH_SLOW_THRESHOLD_MS = 80;
const itemGrantDeltaLogger = createScopedLogger('characterItemGrant.delta');

let itemGrantFlushTimer: ReturnType<typeof setInterval> | null = null;
let itemGrantFlushInFlight: Promise<void> | null = null;
let itemGrantOutboxInFlight: Promise<void> | null = null;
const syncFlushPromiseByCharacterId = new Map<number, Promise<void>>();

const claimItemGrantDeltaLua = `
local dirtyIndexKey = KEYS[1]
local mainKey = KEYS[2]
local inflightKey = KEYS[3]
local inflightMetaKey = KEYS[4]
local characterId = ARGV[1]
local nowMs = tonumber(ARGV[2])
local staleAfterMs = tonumber(ARGV[3])
local reclaimedStaleInflight = 0

if redis.call('EXISTS', inflightKey) == 1 then
  local inflightClaimedAtRaw = redis.call('GET', inflightMetaKey)
  local inflightClaimedAt = tonumber(inflightClaimedAtRaw)
  local isInflightStale = (
    inflightClaimedAt == nil
    or nowMs == nil
    or staleAfterMs == nil
    or (nowMs - inflightClaimedAt) >= staleAfterMs
  )
  if not isInflightStale then
    return 0
  end

  local inflightValues = redis.call('HGETALL', inflightKey)
  if next(inflightValues) ~= nil then
    for i = 1, #inflightValues, 2 do
      redis.call('HINCRBY', mainKey, inflightValues[i], tonumber(inflightValues[i + 1]))
    end
  end
  redis.call('DEL', inflightKey)
  redis.call('DEL', inflightMetaKey)
  redis.call('SADD', dirtyIndexKey, characterId)
  reclaimedStaleInflight = 1
end

if redis.call('EXISTS', mainKey) == 0 then
  redis.call('SREM', dirtyIndexKey, characterId)
  return 0
end

redis.call('RENAME', mainKey, inflightKey)
redis.call('SET', inflightMetaKey, tostring(nowMs))
return reclaimedStaleInflight + 1
`;

const finalizeItemGrantDeltaLua = `
local dirtyIndexKey = KEYS[1]
local mainKey = KEYS[2]
local inflightKey = KEYS[3]
local inflightMetaKey = KEYS[4]
local characterId = ARGV[1]

redis.call('DEL', inflightKey)
redis.call('DEL', inflightMetaKey)
if redis.call('EXISTS', mainKey) == 1 then
  redis.call('SADD', dirtyIndexKey, characterId)
else
  redis.call('SREM', dirtyIndexKey, characterId)
end
return 1
`;

const restoreItemGrantDeltaLua = `
local dirtyIndexKey = KEYS[1]
local mainKey = KEYS[2]
local inflightKey = KEYS[3]
local inflightMetaKey = KEYS[4]
local characterId = ARGV[1]

local inflightValues = redis.call('HGETALL', inflightKey)
if next(inflightValues) == nil then
  redis.call('DEL', inflightMetaKey)
  if redis.call('EXISTS', mainKey) == 1 then
    redis.call('SADD', dirtyIndexKey, characterId)
  else
    redis.call('SREM', dirtyIndexKey, characterId)
  end
  return 0
end

for i = 1, #inflightValues, 2 do
  redis.call('HINCRBY', mainKey, inflightValues[i], tonumber(inflightValues[i + 1]))
end
redis.call('DEL', inflightKey)
redis.call('DEL', inflightMetaKey)
redis.call('SADD', dirtyIndexKey, characterId)
return 1
`;

const buildItemGrantDeltaKey = (characterId: number): string =>
  `${ITEM_GRANT_KEY_PREFIX}${characterId}`;

const buildInflightItemGrantDeltaKey = (characterId: number): string =>
  `${ITEM_GRANT_INFLIGHT_KEY_PREFIX}${characterId}`;

const buildInflightItemGrantDeltaMetaKey = (characterId: number): string =>
  `${ITEM_GRANT_INFLIGHT_META_KEY_PREFIX}${characterId}`;

const normalizePositiveInt = (value: number): number => {
  const normalized = Math.floor(Number(value));
  if (!Number.isFinite(normalized) || normalized <= 0) return 0;
  return normalized;
};

const normalizeBindType = (bindType: string | undefined): string => {
  const normalized = String(bindType ?? '').trim();
  return normalized || 'none';
};

const normalizeObtainedFrom = (obtainedFrom: string): string => {
  return String(obtainedFrom || '').trim();
};

const normalizeIdleSessionId = (idleSessionId: string | null | undefined): string | null => {
  const normalized = String(idleSessionId ?? '').trim();
  return normalized || null;
};

const normalizeGrantMetadata = (
  metadata: BufferedCharacterItemGrantMetadata | null | undefined,
): BufferedCharacterItemGrantMetadata | null => {
  if (!metadata || typeof metadata !== 'object') return null;
  const normalizedEntries = Object.entries(metadata)
    .filter(([, value]) => value !== undefined)
    .sort(([left], [right]) => left.localeCompare(right));
  if (normalizedEntries.length <= 0) return null;
  return Object.fromEntries(normalizedEntries);
};

const normalizeGrantQuality = (quality: string | null | undefined): string | null => {
  const normalized = String(quality ?? '').trim();
  return normalized || null;
};

const normalizeGrantQualityRank = (qualityRank: number | null | undefined): number | null => {
  if (qualityRank === null || qualityRank === undefined) return null;
  const normalized = Math.max(1, Math.floor(Number(qualityRank) || 1));
  return Number.isFinite(normalized) ? normalized : null;
};

const encodeItemGrantPayload = (payload: EncodedCharacterItemGrantPayload): string => {
  return JSON.stringify({
    userId: payload.userId,
    itemDefId: payload.itemDefId,
    bindType: payload.bindType,
    obtainedFrom: payload.obtainedFrom,
    idleSessionId: payload.idleSessionId,
    metadata: payload.metadata,
    quality: payload.quality,
    qualityRank: payload.qualityRank,
    equipOptions: payload.equipOptions,
  });
};

const decodeItemGrantPayload = (raw: string): EncodedCharacterItemGrantPayload | null => {
  try {
    const parsed = JSON.parse(raw) as EncodedCharacterItemGrantPayload;
    const userId = Math.floor(Number(parsed.userId));
    const itemDefId = String(parsed.itemDefId || '').trim();
    const bindType = normalizeBindType(parsed.bindType);
    const obtainedFrom = normalizeObtainedFrom(parsed.obtainedFrom);
    if (!Number.isFinite(userId) || userId <= 0 || !itemDefId || !obtainedFrom) {
      return null;
    }
    return {
      userId,
      itemDefId,
      bindType,
      obtainedFrom,
      idleSessionId: normalizeIdleSessionId(parsed.idleSessionId),
      metadata: normalizeGrantMetadata(parsed.metadata),
      quality: normalizeGrantQuality(parsed.quality),
      qualityRank: normalizeGrantQualityRank(parsed.qualityRank),
      equipOptions: parsed.equipOptions ?? null,
    };
  } catch {
    return null;
  }
};

const normalizeBufferedCharacterItemGrants = (
  grants: BufferedCharacterItemGrant[],
): NormalizedCharacterItemGrant[] => {
  const grantByCompositeKey = new Map<string, NormalizedCharacterItemGrant>();

  for (const grant of grants) {
    const characterId = Math.floor(Number(grant.characterId));
    const userId = Math.floor(Number(grant.userId));
    const itemDefId = String(grant.itemDefId || '').trim();
    const qty = normalizePositiveInt(grant.qty);
    const obtainedFrom = normalizeObtainedFrom(grant.obtainedFrom);
    if (!Number.isFinite(characterId) || characterId <= 0) continue;
    if (!Number.isFinite(userId) || userId <= 0) continue;
    if (!itemDefId || !obtainedFrom || qty <= 0) continue;

    const payload: EncodedCharacterItemGrantPayload = {
      userId,
      itemDefId,
      bindType: normalizeBindType(grant.bindType),
      obtainedFrom,
      idleSessionId: normalizeIdleSessionId(grant.idleSessionId),
      metadata: normalizeGrantMetadata(grant.metadata),
      quality: normalizeGrantQuality(grant.quality),
      qualityRank: normalizeGrantQualityRank(grant.qualityRank),
      equipOptions: grant.equipOptions ?? null,
    };
    const encodedPayload = encodeItemGrantPayload(payload);
    const compositeKey = `${characterId}:${encodedPayload}`;
    const existing = grantByCompositeKey.get(compositeKey);
    if (existing) {
      existing.qty += qty;
      continue;
    }
    grantByCompositeKey.set(compositeKey, {
      characterId,
      payload,
      qty,
    });
  }

  return [...grantByCompositeKey.values()];
};

const buildMailMergeKey = (mailItem: MailAttachItem): string => {
  return JSON.stringify({
    itemDefId: String(mailItem.item_def_id || '').trim(),
    bindType: String(mailItem.options?.bindType || '').trim(),
    metadata: mailItem.options?.metadata ?? null,
    quality: mailItem.options?.quality ?? null,
    qualityRank: mailItem.options?.qualityRank ?? null,
    equipOptions: mailItem.options?.equipOptions ?? null,
  });
};

const pushPendingMailItem = (
  bucket: MailAttachItem[],
  mailItem: MailAttachItem,
): void => {
  const mergeKey = buildMailMergeKey(mailItem);
  const found = bucket.find((entry) => buildMailMergeKey(entry) === mergeKey);
  if (found) {
    found.qty += mailItem.qty;
    return;
  }
  bucket.push({
    item_def_id: mailItem.item_def_id,
    qty: mailItem.qty,
    ...(mailItem.options ? { options: { ...mailItem.options } } : {}),
  });
};

const toOverflowMailAttachment = (
  mailItem: MailAttachItem,
): CharacterItemGrantOverflowMailAttachment => {
  return {
    item_def_id: mailItem.item_def_id,
    qty: mailItem.qty,
    ...(mailItem.options
      ? {
          options: {
            ...(mailItem.options.bindType ? { bindType: mailItem.options.bindType } : {}),
            ...(mailItem.options.equipOptions
              ? {
                  equipOptions: mailItem.options.equipOptions as NonNullable<
                    CharacterItemGrantOverflowMailAttachment['options']
                  >['equipOptions'],
                }
              : {}),
            ...(mailItem.options.metadata ? { metadata: mailItem.options.metadata } : {}),
            ...(mailItem.options.quality ? { quality: mailItem.options.quality } : {}),
            ...(mailItem.options.qualityRank !== undefined
              ? { qualityRank: mailItem.options.qualityRank }
              : {}),
          },
        }
      : {}),
  };
};

const toMailAttachItem = (
  attachment: CharacterItemGrantOverflowMailAttachment,
): MailAttachItem => {
  return {
    item_def_id: attachment.item_def_id,
    qty: attachment.qty,
    ...(attachment.options
      ? {
          options: {
            ...(attachment.options.bindType ? { bindType: attachment.options.bindType } : {}),
            ...(attachment.options.equipOptions ? { equipOptions: attachment.options.equipOptions as GenerateOptions } : {}),
            ...(attachment.options.metadata ? { metadata: attachment.options.metadata } : {}),
            ...(attachment.options.quality ? { quality: attachment.options.quality } : {}),
            ...(attachment.options.qualityRank !== undefined
              ? { qualityRank: attachment.options.qualityRank }
              : {}),
          },
        }
      : {}),
  };
};

export const bufferCharacterItemGrantDeltas = async (
  grants: BufferedCharacterItemGrant[],
): Promise<void> => {
  const normalizedGrants = normalizeBufferedCharacterItemGrants(grants);
  if (normalizedGrants.length <= 0) return;

  await afterTransactionCommit(async () => {
    const multi = redis.multi();
    for (const grant of normalizedGrants) {
      multi.hincrby(
        buildItemGrantDeltaKey(grant.characterId),
        encodeItemGrantPayload(grant.payload),
        grant.qty,
      );
      multi.sadd(ITEM_GRANT_DIRTY_INDEX_KEY, String(grant.characterId));
    }
    await multi.exec();
  });
};

export const enqueueCharacterItemGrant = async (
  grant: BufferedCharacterItemGrant,
): Promise<{ success: boolean; message: string; itemIds: number[] }> => {
  await bufferCharacterItemGrantDeltas([grant]);
  return {
    success: true,
    message: '物品奖励已写入异步资产 Delta',
    itemIds: [],
  };
};

export const bufferSimpleCharacterItemGrants = async (
  characterId: number,
  userId: number,
  grants: readonly SimpleBufferedCharacterItemGrant[],
): Promise<void> => {
  if (grants.length <= 0) return;
  await bufferCharacterItemGrantDeltas(
    grants.map((grant) => ({
      characterId,
      userId,
      itemDefId: grant.itemDefId,
      qty: grant.qty,
      bindType: grant.bindType,
      obtainedFrom: grant.obtainedFrom,
      metadata: grant.metadata,
      quality: grant.quality,
      qualityRank: grant.qualityRank,
      equipOptions: grant.equipOptions,
    })),
  );
};

const listDirtyCharacterIdsForItemGrantDelta = async (
  limit: number,
): Promise<number[]> => {
  const normalizedLimit = Math.max(1, Math.floor(limit));
  return (await redis.srandmember(ITEM_GRANT_DIRTY_INDEX_KEY, normalizedLimit))
    .map((characterId) => Math.floor(Number(characterId)))
    .filter((characterId) => Number.isFinite(characterId) && characterId > 0)
    .sort((left, right) => left - right);
};

const claimCharacterItemGrantDelta = async (
  characterId: number,
): Promise<boolean> => {
  const nowMs = Date.now();
  const result = await redis.eval(
    claimItemGrantDeltaLua,
    4,
    ITEM_GRANT_DIRTY_INDEX_KEY,
    buildItemGrantDeltaKey(characterId),
    buildInflightItemGrantDeltaKey(characterId),
    buildInflightItemGrantDeltaMetaKey(characterId),
    String(characterId),
    String(nowMs),
    String(ITEM_GRANT_INFLIGHT_STALE_AFTER_MS),
  );
  const normalizedResult = Number(result);
  if (normalizedResult === 2) {
    itemGrantDeltaLogger.warn({
      characterId,
      staleAfterMs: ITEM_GRANT_INFLIGHT_STALE_AFTER_MS,
    }, '角色物品授予 Delta 检测到陈旧 inflight，已自动回收并重新 claim');
  }
  return normalizedResult >= 1;
};

const finalizeCharacterItemGrantDelta = async (
  characterId: number,
): Promise<void> => {
  await redis.eval(
    finalizeItemGrantDeltaLua,
    4,
    ITEM_GRANT_DIRTY_INDEX_KEY,
    buildItemGrantDeltaKey(characterId),
    buildInflightItemGrantDeltaKey(characterId),
    buildInflightItemGrantDeltaMetaKey(characterId),
    String(characterId),
  );
};

const restoreCharacterItemGrantDelta = async (
  characterId: number,
): Promise<void> => {
  await redis.eval(
    restoreItemGrantDeltaLua,
    4,
    ITEM_GRANT_DIRTY_INDEX_KEY,
    buildItemGrantDeltaKey(characterId),
    buildInflightItemGrantDeltaKey(characterId),
    buildInflightItemGrantDeltaMetaKey(characterId),
    String(characterId),
  );
};

const loadClaimedCharacterItemGrantHash = async (
  characterId: number,
): Promise<Record<string, string>> => {
  return await redis.hgetall(buildInflightItemGrantDeltaKey(characterId));
};

const parseClaimedCharacterItemGrantHash = (
  characterId: number,
  hash: Record<string, string>,
): NormalizedCharacterItemGrant[] => {
  const parsedGrants: NormalizedCharacterItemGrant[] = [];

  for (const [field, rawQty] of Object.entries(hash)) {
    const payload = decodeItemGrantPayload(field);
    const qty = normalizePositiveInt(Number(rawQty));
    if (!payload || qty <= 0) continue;
    parsedGrants.push({
      characterId,
      payload,
      qty,
    });
  }

  return parsedGrants;
};

export const loadCharacterPendingItemGrants = async (
  characterId: number,
): Promise<PendingCharacterItemGrant[]> => {
  const normalizedCharacterId = Math.floor(Number(characterId));
  if (!Number.isFinite(normalizedCharacterId) || normalizedCharacterId <= 0) {
    return [];
  }

  const [mainHash, inflightHash] = await Promise.all([
    redis.hgetall(buildItemGrantDeltaKey(normalizedCharacterId)),
    redis.hgetall(buildInflightItemGrantDeltaKey(normalizedCharacterId)),
  ]);
  const mergedHash = new Map<string, number>();
  for (const hash of [mainHash, inflightHash]) {
    for (const [field, rawQty] of Object.entries(hash)) {
      const qty = normalizePositiveInt(Number(rawQty));
      if (qty <= 0) continue;
      mergedHash.set(field, (mergedHash.get(field) ?? 0) + qty);
    }
  }

  const pendingGrants: PendingCharacterItemGrant[] = [];
  for (const [field, qty] of mergedHash.entries()) {
    const payload = decodeItemGrantPayload(field);
    if (!payload || qty <= 0) continue;
      pendingGrants.push({
        itemDefId: payload.itemDefId,
        qty,
        bindType: payload.bindType,
        obtainedFrom: payload.obtainedFrom,
        idleSessionId: payload.idleSessionId,
        metadata: payload.metadata,
        quality: payload.quality,
        qualityRank: payload.qualityRank,
    });
  }
  return pendingGrants;
};

/**
 * 同步 flush 指定角色的待发放物品奖励。
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：把当前角色 Redis 中待 flush 的物品奖励立即落成真实 `item_instance`，供背包/仓库/使用道具等库存交互复用。
 * 2. 做什么：复用现有 claim -> flush -> finalize / restore 流程，保证与后台定时 flush 的入包规则、堆叠规则、邮件补发规则完全一致。
 * 3. 不做什么：不改奖励生产侧写入协议，不直接返回奖励列表，也不负责前端展示。
 *
 * 输入 / 输出：
 * - 输入：角色 ID。
 * - 输出：`Promise<void>`；成功表示当前角色可见的 pending grants 已被尽力结算为真实库存，失败时抛出异常。
 *
 * 数据流 / 状态流：
 * characterId -> 等待同进程中的 flush 任务完成 -> 读取 pending grants -> claim Redis hash -> 事务内真实入包 -> finalize / restore。
 *
 * 复用设计说明：
 * - 同步入口只做“时机前移”，不新增第二套落库逻辑，避免异步 worker 和库存前置 flush 出现规则漂移。
 * - 以角色 ID 为粒度做同进程串行，避免同一角色并发打开背包/仓库时重复 claim 或重复 flush。
 *
 * 关键边界条件与坑点：
 * 1. 如果后台定时 flush 正在执行，必须先等待其完成，再决定是否还需要本次同步 flush，否则可能读到短暂 inflight 状态。
 * 2. 一旦 claim 成功但后续 flush 失败，必须走 restore，把 inflight 奖励回滚回主哈希，不能把奖励吞掉。
 */
export const flushCharacterPendingItemGrantsNow = async (
  characterId: number,
): Promise<void> => {
  const normalizedCharacterId = Math.floor(Number(characterId));
  if (!Number.isFinite(normalizedCharacterId) || normalizedCharacterId <= 0) {
    return;
  }

  const existingPromise = syncFlushPromiseByCharacterId.get(normalizedCharacterId);
  if (existingPromise) {
    await existingPromise;
    return;
  }

  const flushPromise = (async () => {
    if (itemGrantFlushInFlight) {
      await itemGrantFlushInFlight;
    }

    const pendingGrants = await loadCharacterPendingItemGrants(normalizedCharacterId);
    if (pendingGrants.length <= 0) {
      return;
    }

    const claimed = await claimCharacterItemGrantDelta(normalizedCharacterId);
    if (!claimed) {
      if (itemGrantFlushInFlight) {
        await itemGrantFlushInFlight;
      }
      return;
    }

    try {
      const hash = await loadClaimedCharacterItemGrantHash(normalizedCharacterId);
      const grants = parseClaimedCharacterItemGrantHash(normalizedCharacterId, hash);
      try {
        if (grants.length > 0) {
          await flushSingleCharacterItemGrants(normalizedCharacterId, grants);
        }
      } catch (error) {
        await restoreCharacterItemGrantDelta(normalizedCharacterId);
        throw error;
      }

      await finalizeCharacterItemGrantDelta(normalizedCharacterId);
    } catch (error) {
      throw error;
    }

    await processCharacterItemGrantOverflowMailBatch({
      drainAll: true,
      limit: ITEM_GRANT_OUTBOX_BATCH_LIMIT,
      characterId: normalizedCharacterId,
    });
  })();

  syncFlushPromiseByCharacterId.set(normalizedCharacterId, flushPromise);
  try {
    await flushPromise;
  } finally {
    if (syncFlushPromiseByCharacterId.get(normalizedCharacterId) === flushPromise) {
      syncFlushPromiseByCharacterId.delete(normalizedCharacterId);
    }
  }
};

const flushSingleCharacterItemGrants = async (
  characterId: number,
  grants: NormalizedCharacterItemGrant[],
) : Promise<CharacterItemGrantFlushPhaseOneResult> => {
  if (grants.length <= 0) {
    return {
      batchSize: 0,
      overflowCount: 0,
      inventoryMutexWaitMs: 0,
      inventoryMutexHoldMs: 0,
      outboxEntries: [],
    };
  }

  const slowLogger = createSlowOperationLogger({
    label: 'characterItemGrant.flush.phase1',
    thresholdMs: ITEM_GRANT_FLUSH_SLOW_THRESHOLD_MS,
    fields: {
      characterId,
      item_grant_flush_batch_size: grants.length,
    },
  });

  const phaseOneResult = await withTransaction(async () => {
    const inventoryMutexWaitMs = await lockCharacterInventoryMutex(characterId);
    const inventoryMutexHoldStartedAt = Date.now();
    slowLogger.mark('acquireInventoryMutex', {
      inventory_mutex_wait_ms: inventoryMutexWaitMs,
    });
    const slotSession = await createInventorySlotSession([characterId]);
    const bagSlotAllocator = createCharacterBagSlotAllocatorFromSession(slotSession, [characterId]);
    const inventoryMutationContext = createCharacterInventoryMutationContextFromSession(slotSession);
    const pendingMailItems: MailAttachItem[] = [];
    const idleBagFullSessionIds = new Set<string>();
    let receiverUserId = 0;

    slowLogger.mark('prepareInventoryContext');

    for (const grant of grants) {
      receiverUserId = grant.payload.userId;
      const createResult = await itemService.createItem(
        grant.payload.userId,
        characterId,
        grant.payload.itemDefId,
        grant.qty,
        {
          location: 'bag',
          obtainedFrom: grant.payload.obtainedFrom,
          bindType: grant.payload.bindType,
          bagSlotAllocator,
          inventoryMutationContext,
          slotSession,
          inventoryMutexAlreadyLocked: true,
          ...(grant.payload.metadata ? { metadata: grant.payload.metadata } : {}),
          ...(grant.payload.quality ? { quality: grant.payload.quality } : {}),
          ...(grant.payload.qualityRank !== null ? { qualityRank: grant.payload.qualityRank } : {}),
          ...(grant.payload.equipOptions ? { equipOptions: grant.payload.equipOptions } : {}),
        },
      );

      if (createResult.success) {
        continue;
      }

      if (createResult.message === '背包已满') {
        if (grant.payload.idleSessionId) {
          idleBagFullSessionIds.add(grant.payload.idleSessionId);
        }
        pushPendingMailItem(pendingMailItems, {
          item_def_id: grant.payload.itemDefId,
          qty: grant.qty,
          options: {
            bindType: grant.payload.bindType,
            ...(grant.payload.metadata ? { metadata: grant.payload.metadata } : {}),
            ...(grant.payload.quality ? { quality: grant.payload.quality } : {}),
            ...(grant.payload.qualityRank !== null ? { qualityRank: grant.payload.qualityRank } : {}),
            ...(grant.payload.equipOptions ? { equipOptions: grant.payload.equipOptions } : {}),
          },
        });
        continue;
      }

      throw new Error(`角色资产 Delta flush 失败: characterId=${characterId}, itemDefId=${grant.payload.itemDefId}, message=${createResult.message}`);
    }

    slowLogger.mark('createItems', {
      item_grant_overflow_count: pendingMailItems.length,
    });

    const outboxEntries: CharacterItemGrantOverflowMailOutboxEntry[] = [];
    if (pendingMailItems.length > 0) {
      for (let index = 0; index < pendingMailItems.length; index += ITEM_GRANT_MAIL_CHUNK_SIZE) {
        const chunk = pendingMailItems.slice(index, index + ITEM_GRANT_MAIL_CHUNK_SIZE);
        outboxEntries.push({
          characterId,
          recipientUserId: receiverUserId,
          recipientCharacterId: characterId,
          title: '奖励补发',
          content: '由于背包空间不足，部分奖励已通过邮件补发，请前往邮箱领取。',
          attachItems: chunk.map((mailItem) => toOverflowMailAttachment(mailItem)),
          idleSessionIds: [...idleBagFullSessionIds],
          expireDays: 30,
        });
      }
      await enqueueCharacterItemGrantOverflowMail(outboxEntries);
      slowLogger.mark('enqueueOverflowMailOutbox', {
        item_grant_overflow_count: pendingMailItems.length,
      });
    }

    return {
      batchSize: grants.length,
      overflowCount: pendingMailItems.length,
      inventoryMutexWaitMs,
      inventoryMutexHoldMs: Math.max(0, Date.now() - inventoryMutexHoldStartedAt),
      outboxEntries,
    };
  });

  slowLogger.flush({
    inventory_mutex_wait_ms: phaseOneResult.inventoryMutexWaitMs,
    inventory_mutex_hold_ms: phaseOneResult.inventoryMutexHoldMs,
    item_grant_flush_batch_size: phaseOneResult.batchSize,
    item_grant_overflow_count: phaseOneResult.overflowCount,
  });

  return phaseOneResult;
};

const processCharacterItemGrantOverflowMailOutboxById = async (
  outboxId: number,
): Promise<boolean> => {
  let processed = false;
  let retryCount = 0;

  try {
    await withTransaction(async () => {
      const row = await loadCharacterItemGrantOverflowMailForUpdate(outboxId);
      if (!row) {
        return;
      }

      retryCount = row.attemptCount + 1;
      const mailResult = await sendSystemMail(
        row.recipientUserId,
        row.recipientCharacterId,
        row.title,
        row.content,
        {
          items: row.attachItems.map((attachment) => toMailAttachItem(attachment)),
        },
        row.expireDays,
      );
      if (!mailResult.success || !mailResult.mailId) {
        throw new Error(`奖励补发邮件发送失败: outboxId=${outboxId}, message=${mailResult.message}`);
      }

      if (row.idleSessionIds.length > 0) {
        await query(
          `UPDATE idle_sessions
           SET bag_full_flag = true,
               updated_at = NOW()
           WHERE id = ANY($1::uuid[])`,
          [row.idleSessionIds],
        );
      }

      await finalizeCharacterItemGrantOverflowMail(outboxId, mailResult.mailId);
      processed = true;
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : `奖励补发邮件处理失败: outboxId=${outboxId}`;
    await restoreCharacterItemGrantOverflowMailAttempt(outboxId, message);
    itemGrantDeltaLogger.warn(
      {
        outboxId,
        item_grant_outbox_retry_count: retryCount > 0 ? retryCount : 1,
      },
      message,
    );
  }

  return processed;
};

const processCharacterItemGrantOverflowMailBatch = async (
  options: { drainAll?: boolean; limit?: number; characterId?: number } = {},
): Promise<void> => {
  const drainAll = options.drainAll === true;
  const limit = Math.max(1, Math.floor(options.limit ?? ITEM_GRANT_OUTBOX_BATCH_LIMIT));

  do {
    const outboxIds = await claimCharacterItemGrantOverflowMailBatch(limit, options.characterId);
    if (outboxIds.length <= 0) {
      return;
    }

    for (const outboxId of outboxIds) {
      await processCharacterItemGrantOverflowMailOutboxById(outboxId);
    }

    const pendingCount = await countPendingCharacterItemGrantOverflowMail();
    itemGrantDeltaLogger.info(
      {
        item_grant_outbox_pending_count: pendingCount,
        processedCount: outboxIds.length,
        ...(options.characterId ? { characterId: options.characterId } : {}),
      },
      '角色物品奖励补发 outbox 批次处理完成',
    );
  } while (drainAll);
};

const flushCharacterItemGrantDeltas = async (
  options: { drainAll?: boolean; limit?: number } = {},
): Promise<void> => {
  const drainAll = options.drainAll === true;
  const limit = Math.max(1, Math.floor(options.limit ?? ITEM_GRANT_FLUSH_BATCH_LIMIT));

  do {
    const dirtyCharacterIds = await listDirtyCharacterIdsForItemGrantDelta(limit);
    if (dirtyCharacterIds.length <= 0) {
      return;
    }

    for (const characterId of dirtyCharacterIds) {
      const claimed = await claimCharacterItemGrantDelta(characterId);
      if (!claimed) continue;

      try {
        const hash = await loadClaimedCharacterItemGrantHash(characterId);
        const grants = parseClaimedCharacterItemGrantHash(characterId, hash);
        try {
          if (grants.length > 0) {
            await flushSingleCharacterItemGrants(characterId, grants);
          }
        } catch (error) {
          await restoreCharacterItemGrantDelta(characterId);
          throw error;
        }

        await finalizeCharacterItemGrantDelta(characterId);
      } catch (error) {
        throw error;
      }

      await processCharacterItemGrantOverflowMailBatch({
        drainAll: true,
        limit: ITEM_GRANT_OUTBOX_BATCH_LIMIT,
        characterId,
      });
    }
  } while (drainAll);
};

const runItemGrantFlushLoopOnce = async (): Promise<void> => {
  if (itemGrantFlushInFlight) {
    await itemGrantFlushInFlight;
    return;
  }

  const currentFlush = flushCharacterItemGrantDeltas().catch((error: Error) => {
    itemGrantDeltaLogger.error(error, '角色物品授予 Delta flush 失败');
  });
  itemGrantFlushInFlight = currentFlush;
  try {
    await currentFlush;
  } finally {
    if (itemGrantFlushInFlight === currentFlush) {
      itemGrantFlushInFlight = null;
    }
  }
};

const runItemGrantOverflowMailLoopOnce = async (): Promise<void> => {
  if (itemGrantOutboxInFlight) {
    await itemGrantOutboxInFlight;
    return;
  }

  const currentOutboxRun = processCharacterItemGrantOverflowMailBatch().catch((error: Error) => {
    itemGrantDeltaLogger.error(error, '角色物品奖励补发 outbox 处理失败');
  });
  itemGrantOutboxInFlight = currentOutboxRun;
  try {
    await currentOutboxRun;
  } finally {
    if (itemGrantOutboxInFlight === currentOutboxRun) {
      itemGrantOutboxInFlight = null;
    }
  }
};

export const initializeCharacterItemGrantDeltaService = async (): Promise<void> => {
  if (itemGrantFlushTimer) return;

  await runItemGrantFlushLoopOnce();
  await runItemGrantOverflowMailLoopOnce();

  itemGrantFlushTimer = setInterval(() => {
    void runItemGrantFlushLoopOnce();
    void runItemGrantOverflowMailLoopOnce();
  }, ITEM_GRANT_FLUSH_INTERVAL_MS);
};

export const shutdownCharacterItemGrantDeltaService = async (): Promise<void> => {
  if (itemGrantFlushTimer) {
    clearInterval(itemGrantFlushTimer);
    itemGrantFlushTimer = null;
  }

  if (itemGrantFlushInFlight) {
    await itemGrantFlushInFlight;
  }
  if (itemGrantOutboxInFlight) {
    await itemGrantOutboxInFlight;
  }

  await flushCharacterItemGrantDeltas({ drainAll: true });
  await processCharacterItemGrantOverflowMailBatch({ drainAll: true, limit: ITEM_GRANT_OUTBOX_BATCH_LIMIT });
};
