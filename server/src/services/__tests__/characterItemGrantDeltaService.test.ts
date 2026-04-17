/**
 * characterItemGrantDeltaService 奖励透传回归测试
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：验证异步奖励 Delta 在写入 Redis 后，仍能把 metadata、quality、qualityRank 原样还原给待入包视图。
 * 2. 做什么：锁住“生成功法书依赖 metadata 覆盖默认名称”的链路，避免再次退化成《无名功法秘卷》。
 * 3. 不做什么：不连接真实 Redis、不执行真实 flush 入库，也不覆盖邮件领取等其他奖励入口。
 *
 * 输入 / 输出：
 * - 输入：角色 ID、用户 ID，以及带 metadata/quality/qualityRank 的 buffered item grants。
 * - 输出：`loadCharacterPendingItemGrants` 返回的待入包奖励快照。
 *
 * 数据流 / 状态流：
 * grant -> bufferSimpleCharacterItemGrants -> Redis hash field(JSON payload) -> loadCharacterPendingItemGrants -> 断言字段是否完整。
 *
 * 复用设计说明：
 * 1. 用内存版 Redis mock 统一承接 `multi/hincrby/hgetall`，避免每个奖励回归测试各自拼一套散乱桩逻辑。
 * 2. 这里锁定的是高频变化点“奖励字段序列化协议”，后续所有依赖 pending grant overlay 的奖励展示都能复用这份保障。
 *
 * 关键边界条件与坑点：
 * 1. `afterTransactionCommit` 必须立即执行，否则测试会卡在“数据还没真正写入 Redis”这一层，无法稳定复现序列化问题。
 * 2. Redis hash field 本身就是 payload 序列化结果；只要 field 漏字段，读取阶段无法补救，因此断言必须直接覆盖 metadata 与品质字段。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import * as database from '../../config/database.js';
import { redis } from '../../config/redis.js';
import * as inventoryMutex from '../inventoryMutex.js';
import * as itemServiceModule from '../itemService.js';
import * as mailServiceModule from '../mailService.js';
import * as characterBagSlotAllocatorModule from '../shared/characterBagSlotAllocator.js';
import * as characterInventoryMutationContextModule from '../shared/characterInventoryMutationContext.js';
import * as characterItemGrantMailOutboxModule from '../shared/characterItemGrantMailOutbox.js';
import * as inventorySlotSessionModule from '../shared/inventorySlotSession.js';
import {
  bufferSimpleCharacterItemGrants,
  flushCharacterPendingItemGrantsNow,
  loadCharacterPendingItemGrants,
} from '../shared/characterItemGrantDeltaService.js';

test('bufferSimpleCharacterItemGrants 应保留 metadata 与品质字段到待入包奖励', async (t) => {
  const redisHashStore = new Map<string, Map<string, number>>();

  t.mock.method(redis, 'multi', () => {
    const operations: Array<() => void> = [];

    return {
      hincrby(key: string, field: string, qty: number) {
        operations.push(() => {
          const hash = redisHashStore.get(key) ?? new Map<string, number>();
          hash.set(field, (hash.get(field) ?? 0) + qty);
          redisHashStore.set(key, hash);
        });
        return this;
      },
      sadd() {
        return this;
      },
      async exec() {
        operations.forEach((operation) => operation());
        return [];
      },
    };
  });

  t.mock.method(redis, 'hgetall', async (key: string) => {
    const hash = redisHashStore.get(key);
    if (!hash) return {};
    return Object.fromEntries([...hash.entries()].map(([field, qty]) => [field, String(qty)]));
  });

  await bufferSimpleCharacterItemGrants(101, 202, [
    {
      itemDefId: 'book-generated-technique',
      qty: 1,
      obtainedFrom: 'technique_generate:gen-test-1',
      metadata: {
        generatedTechniqueId: 'tech-gen-test-1',
        generatedTechniqueName: '太虚归元诀',
      },
      quality: '天',
      qualityRank: 4,
    },
  ]);

  const pendingGrants = await loadCharacterPendingItemGrants(101);

  assert.deepEqual(pendingGrants, [
    {
      itemDefId: 'book-generated-technique',
      qty: 1,
      bindType: 'none',
      obtainedFrom: 'technique_generate:gen-test-1',
      idleSessionId: null,
      metadata: {
        generatedTechniqueId: 'tech-gen-test-1',
        generatedTechniqueName: '太虚归元诀',
      },
      quality: '天',
      qualityRank: 4,
    },
  ]);
});

test('flushCharacterPendingItemGrantsNow 在没有待发奖励时应直接返回且不触发落库', async (t) => {
  let evalCallCount = 0;
  let withTransactionCalled = false;

  t.mock.method(redis, 'hgetall', async () => ({}));
  t.mock.method(redis, 'eval', async () => {
    evalCallCount += 1;
    return 0;
  });
  t.mock.method(database, 'withTransaction', async () => {
    withTransactionCalled = true;
    throw new Error('不应进入事务落库');
  });

  await flushCharacterPendingItemGrantsNow(101);

  assert.equal(evalCallCount, 0);
  assert.equal(withTransactionCalled, false);
});

test('flushCharacterPendingItemGrantsNow 应把待发奖励同步落成真实库存并 finalize', async (t) => {
  const hashStore = new Map<string, Map<string, number>>();
  const dirtyCharacterIds = new Set<string>();
  const createItemCalls: Array<{ userId: number; characterId: number; itemDefId: string; qty: number }> = [];
  const mainKey = 'character:item-grant-delta:101';
  const inflightKey = 'character:item-grant-delta:inflight:101';
  const encodedPayload = JSON.stringify({
    userId: 202,
    itemDefId: 'stone-bag',
    bindType: 'none',
    obtainedFrom: 'battle_drop',
    idleSessionId: null,
    metadata: null,
    quality: null,
    qualityRank: null,
    equipOptions: null,
  });

  hashStore.set(mainKey, new Map([[encodedPayload, 3]]));
  dirtyCharacterIds.add('101');

  t.mock.method(redis, 'hgetall', async (key: string) => {
    const hash = hashStore.get(key);
    if (!hash) return {};
    return Object.fromEntries([...hash.entries()].map(([field, qty]) => [field, String(qty)]));
  });

  t.mock.method(redis, 'eval', async (script: string, _numKeys: number, dirtyKey: string, currentMainKey: string, currentInflightKey: string, characterId: string) => {
    assert.equal(dirtyKey, 'character:item-grant-delta:index');
    if (script.includes('RENAME')) {
      if (hashStore.has(currentInflightKey)) return 0;
      const currentMainHash = hashStore.get(currentMainKey);
      if (!currentMainHash || currentMainHash.size <= 0) {
        dirtyCharacterIds.delete(characterId);
        return 0;
      }
      hashStore.set(currentInflightKey, new Map(currentMainHash));
      hashStore.delete(currentMainKey);
      return 1;
    }

    if (script.includes('HGETALL')) {
      const inflightHash = hashStore.get(currentInflightKey);
      if (!inflightHash || inflightHash.size <= 0) {
        if (!hashStore.has(currentMainKey)) {
          dirtyCharacterIds.delete(characterId);
        }
        return 0;
      }
      const mainHash = hashStore.get(currentMainKey) ?? new Map<string, number>();
      for (const [field, qty] of inflightHash.entries()) {
        mainHash.set(field, (mainHash.get(field) ?? 0) + qty);
      }
      hashStore.set(currentMainKey, mainHash);
      hashStore.delete(currentInflightKey);
      dirtyCharacterIds.add(characterId);
      return 1;
    }

    hashStore.delete(currentInflightKey);
    if (hashStore.has(currentMainKey)) {
      dirtyCharacterIds.add(characterId);
    } else {
      dirtyCharacterIds.delete(characterId);
    }
    return 1;
  });

  t.mock.method(database, 'withTransaction', async <T>(executor: () => Promise<T>) => {
    return await executor();
  });
  t.mock.method(inventoryMutex, 'lockCharacterInventoryMutex', async () => 0);
  t.mock.method(inventorySlotSessionModule, 'createInventorySlotSession', async () => ({}) as never);
  t.mock.method(characterBagSlotAllocatorModule, 'createCharacterBagSlotAllocatorFromSession', () => ({}) as never);
  t.mock.method(characterInventoryMutationContextModule, 'createCharacterInventoryMutationContextFromSession', () => ({}) as never);
  t.mock.method(characterItemGrantMailOutboxModule, 'claimCharacterItemGrantOverflowMailBatch', async () => []);
  t.mock.method(characterItemGrantMailOutboxModule, 'countPendingCharacterItemGrantOverflowMail', async () => 0);
  t.mock.method(itemServiceModule.itemService, 'createItem', async (userId: number, characterId: number, itemDefId: string, qty: number) => {
    createItemCalls.push({ userId, characterId, itemDefId, qty });
    return { success: true, message: 'ok', itemIds: [9001] };
  });

  await flushCharacterPendingItemGrantsNow(101);

  assert.deepEqual(createItemCalls, [
    {
      userId: 202,
      characterId: 101,
      itemDefId: 'stone-bag',
      qty: 3,
    },
  ]);
  assert.deepEqual(await redis.hgetall(mainKey), {});
  assert.deepEqual(await redis.hgetall(inflightKey), {});
  assert.equal(dirtyCharacterIds.has('101'), false);
});

test('flushCharacterPendingItemGrantsNow 在背包已满时应写入补发 outbox 并在锁外发送邮件', async (t) => {
  const hashStore = new Map<string, Map<string, number>>();
  const mainKey = 'character:item-grant-delta:101';
  const inflightKey = 'character:item-grant-delta:inflight:101';
  const encodedPayload = JSON.stringify({
    userId: 202,
    itemDefId: 'stone-bag',
    bindType: 'none',
    obtainedFrom: 'battle_drop',
    idleSessionId: 'idle-session-1',
    metadata: null,
    quality: null,
    qualityRank: null,
    equipOptions: null,
  });
  const enqueuedOutboxEntries: Array<{
    characterId: number;
    recipientUserId: number;
    recipientCharacterId: number;
    title: string;
    content: string;
    attachItems: Array<{ item_def_id: string; qty: number }>;
    idleSessionIds: string[];
    expireDays: number;
  }> = [];
  let finalizedOutboxId = 0;
  let restoredOutboxId = 0;
  let idleSessionUpdateCount = 0;
  let sendMailCallCount = 0;

  hashStore.set(mainKey, new Map([[encodedPayload, 2]]));

  t.mock.method(redis, 'hgetall', async (key: string) => {
    const hash = hashStore.get(key);
    if (!hash) return {};
    return Object.fromEntries([...hash.entries()].map(([field, qty]) => [field, String(qty)]));
  });

  t.mock.method(redis, 'eval', async (script: string, _numKeys: number, _dirtyKey: string, currentMainKey: string, currentInflightKey: string) => {
    if (script.includes('RENAME')) {
      const currentMainHash = hashStore.get(currentMainKey);
      if (!currentMainHash || currentMainHash.size <= 0) {
        return 0;
      }
      hashStore.set(currentInflightKey, new Map(currentMainHash));
      hashStore.delete(currentMainKey);
      return 1;
    }

    if (script.includes('HGETALL')) {
      const inflightHash = hashStore.get(currentInflightKey);
      if (!inflightHash || inflightHash.size <= 0) {
        return 0;
      }
      const restoredMainHash = hashStore.get(currentMainKey) ?? new Map<string, number>();
      for (const [field, qty] of inflightHash.entries()) {
        restoredMainHash.set(field, (restoredMainHash.get(field) ?? 0) + qty);
      }
      hashStore.set(currentMainKey, restoredMainHash);
      hashStore.delete(currentInflightKey);
      return 1;
    }

    hashStore.delete(currentInflightKey);
    return 1;
  });

  t.mock.method(database, 'withTransaction', async <T>(executor: () => Promise<T>) => {
    return await executor();
  });
  t.mock.method(database, 'query', async (sql: string) => {
    if (sql.includes('UPDATE idle_sessions')) {
      idleSessionUpdateCount += 1;
    }
    return { rows: [] } as never;
  });
  t.mock.method(inventoryMutex, 'lockCharacterInventoryMutex', async () => 0);
  t.mock.method(inventorySlotSessionModule, 'createInventorySlotSession', async () => ({}) as never);
  t.mock.method(characterBagSlotAllocatorModule, 'createCharacterBagSlotAllocatorFromSession', () => ({}) as never);
  t.mock.method(characterInventoryMutationContextModule, 'createCharacterInventoryMutationContextFromSession', () => ({}) as never);
  t.mock.method(itemServiceModule.itemService, 'createItem', async () => ({
    success: false,
    message: '背包已满',
  }));
  t.mock.method(characterItemGrantMailOutboxModule, 'enqueueCharacterItemGrantOverflowMail', async (
    entries: Parameters<typeof characterItemGrantMailOutboxModule.enqueueCharacterItemGrantOverflowMail>[0],
  ) => {
    enqueuedOutboxEntries.push(...entries);
  });
  t.mock.method(characterItemGrantMailOutboxModule, 'claimCharacterItemGrantOverflowMailBatch', async () => [501]);
  t.mock.method(characterItemGrantMailOutboxModule, 'countPendingCharacterItemGrantOverflowMail', async () => 0);
  t.mock.method(characterItemGrantMailOutboxModule, 'loadCharacterItemGrantOverflowMailForUpdate', async (outboxId: number) => ({
    id: outboxId,
    characterId: 101,
    recipientUserId: 202,
    recipientCharacterId: 101,
    title: '奖励补发',
    content: '由于背包空间不足，部分奖励已通过邮件补发，请前往邮箱领取。',
    attachItems: [
      {
        item_def_id: 'stone-bag',
        qty: 2,
        options: {
          bindType: 'none',
        },
      },
    ],
    idleSessionIds: ['idle-session-1'],
    expireDays: 30,
    attemptCount: 0,
  }));
  t.mock.method(characterItemGrantMailOutboxModule, 'finalizeCharacterItemGrantOverflowMail', async (outboxId: number) => {
    finalizedOutboxId = outboxId;
  });
  t.mock.method(characterItemGrantMailOutboxModule, 'restoreCharacterItemGrantOverflowMailAttempt', async (outboxId: number) => {
    restoredOutboxId = outboxId;
  });
  t.mock.method(mailServiceModule, 'sendSystemMail', async () => {
    sendMailCallCount += 1;
    return {
      success: true,
      mailId: 88,
      message: 'ok',
    };
  });

  await flushCharacterPendingItemGrantsNow(101);

  assert.equal(enqueuedOutboxEntries.length, 1);
  assert.deepEqual(enqueuedOutboxEntries[0], {
    characterId: 101,
    recipientUserId: 202,
    recipientCharacterId: 101,
    title: '奖励补发',
    content: '由于背包空间不足，部分奖励已通过邮件补发，请前往邮箱领取。',
    attachItems: [
      {
        item_def_id: 'stone-bag',
        qty: 2,
        options: {
          bindType: 'none',
        },
      },
    ],
    idleSessionIds: ['idle-session-1'],
    expireDays: 30,
  });
  assert.equal(sendMailCallCount, 1);
  assert.equal(finalizedOutboxId, 501);
  assert.equal(restoredOutboxId, 0);
  assert.equal(idleSessionUpdateCount, 1);
  assert.deepEqual(await redis.hgetall(mainKey), {});
  assert.deepEqual(await redis.hgetall(inflightKey), {});
});
