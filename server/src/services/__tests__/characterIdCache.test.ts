/**
 * 角色 ID 映射缓存回归测试
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：验证 `getCharacterIdByUserId` 命中后会复用内存缓存，避免重复查询数据库。
 * 2. 做什么：验证 `primeCharacterIdByUserIdCache` 可直接预热结果，`getCharacterIdByUserIdForUpdate` 仍保持直查。
 * 3. 不做什么：不连接真实数据库，不验证 Redis 网络连通性，只锁定服务层缓存读写协议。
 *
 * 输入/输出：
 * - 输入：模拟的数据库 `query` 响应，以及 Redis `get/set/del` 的假实现。
 * - 输出：各入口返回的角色 ID，以及底层 `query` 的调用次数和 SQL 形态。
 *
 * 数据流/状态流：
 * - 测试先清空指定 userId 的缓存；
 * - 首次读走 loader，第二次读命中内存缓存；
 * - 预热缓存后直接读返回预设角色 ID；
 * - `FOR UPDATE` 入口仍单独访问数据库。
 *
 * 关键边界条件与坑点：
 * 1. 这里显式验证 `FOR UPDATE` 不复用缓存，避免把锁语义错误地绕过。
 * 2. 测试结束后要清理同一批 userId 的缓存，避免模块级内存缓存污染其他测试。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import * as database from '../../config/database.js';
import { redis } from '../../config/redis.js';
import {
  getCharacterIdByUserId,
  getCharacterIdByUserIdForUpdate,
  invalidateCharacterIdByUserIdCache,
  primeCharacterIdByUserIdCache,
} from '../shared/characterId.js';

test('角色 ID 映射应复用缓存且 FOR UPDATE 保持直查', async (t) => {
  const userId = 101;
  const primedUserId = 202;

  t.mock.method(redis, 'get', async () => null);
  t.mock.method(redis, 'set', async () => 'OK');
  t.mock.method(redis, 'del', async () => 1);

  const queryMock = t.mock.method(
    database,
    'query',
    async (sql: string, params?: readonly unknown[]) => {
      const currentUserId = Number(params?.[0]);
      if (sql.includes('FOR UPDATE')) {
        return { rows: currentUserId === userId ? [{ id: 1002 }] : [] };
      }
      if (currentUserId === userId) {
        return { rows: [{ id: 1001 }] };
      }
      if (currentUserId === primedUserId) {
        return { rows: [{ id: 2001 }] };
      }
      return { rows: [] };
    },
  );

  await invalidateCharacterIdByUserIdCache(userId);
  await invalidateCharacterIdByUserIdCache(primedUserId);

  const first = await getCharacterIdByUserId(userId);
  const second = await getCharacterIdByUserId(userId);
  assert.equal(first, 1001);
  assert.equal(second, 1001);
  assert.equal(queryMock.mock.callCount(), 1);

  await primeCharacterIdByUserIdCache(primedUserId, 2002);
  const primed = await getCharacterIdByUserId(primedUserId);
  assert.equal(primed, 2002);
  assert.equal(queryMock.mock.callCount(), 1);

  const locked = await getCharacterIdByUserIdForUpdate(userId);
  assert.equal(locked, 1002);
  assert.equal(queryMock.mock.callCount(), 2);
  assert.match(String(queryMock.mock.calls[1]?.arguments[0] ?? ''), /FOR UPDATE/);

  await invalidateCharacterIdByUserIdCache(userId);
  await invalidateCharacterIdByUserIdCache(primedUserId);
});
