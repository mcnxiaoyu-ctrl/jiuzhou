/**
 * 货币消耗公共模块回归测试
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：验证角色货币扣减改为条件 UPDATE，不再先对 `characters` 执行 `FOR UPDATE`。
 * 2. 做什么：验证角色货币增加改为单条 UPDATE/RETURNING，不再为了存在性检查额外锁角色行。
 * 3. 不做什么：不连接真实数据库，不覆盖装备/镶嵌等上层业务流程。
 *
 * 输入/输出：
 * - 输入：模拟数据库 `query` 响应，以及扣除/增加货币的请求参数。
 * - 输出：服务返回值、执行过的 SQL 列表，以及关键 SQL 是否包含条件更新与无锁语义。
 *
 * 数据流/状态流：
 * 调用公共货币模块 -> 记录 SQL -> 断言先走 UPDATE/RETURNING
 * -> 扣减失败时才补查只读快照 -> 返回精确错误文案。
 *
 * 关键边界条件与坑点：
 * 1. 这里必须锁定“无 FOR UPDATE”的 SQL 形态，否则背包锁持有期间又会把 `characters` 行锁时间重新拉长。
 * 2. 扣减失败要区分余额不足和角色不存在，因此测试同时覆盖条件更新失败后的只读补查路径。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import * as database from '../../config/database.js';
import {
  addCharacterCurrencies,
  addCharacterCurrenciesExact,
  consumeCharacterCurrencies,
  consumeCharacterCurrenciesExact,
  consumeCharacterStoredResources,
} from '../inventory/shared/consume.js';

test('consumeCharacterCurrencies: 应使用条件更新而不是先锁 characters', async (t) => {
  const sqlCalls: string[] = [];

  t.mock.method(database, 'query', async (sql: string) => {
    sqlCalls.push(sql);

    if (sql.includes('UPDATE characters') && sql.includes('silver = silver - $2')) {
      return { rows: [] };
    }
    if (sql.includes('SELECT silver, spirit_stones, exp FROM characters WHERE id = $1 LIMIT 1')) {
      return { rows: [{ silver: 5, spirit_stones: 99, exp: 0 }] };
    }

    throw new Error(`未处理的 SQL: ${sql}`);
  });

  const result = await consumeCharacterCurrencies(101, {
    silver: 10,
    spiritStones: 3,
  });

  assert.deepEqual(result, {
    success: false,
    message: '银两不足，需要10',
  });
  assert.equal(sqlCalls.length, 2);
  assert.match(sqlCalls[0] ?? '', /UPDATE characters/u);
  assert.match(sqlCalls[0] ?? '', /AND silver >= \$2/u);
  assert.match(sqlCalls[0] ?? '', /AND spirit_stones >= \$3/u);
  assert.doesNotMatch(sqlCalls[0] ?? '', /FOR UPDATE/u);
  assert.doesNotMatch(sqlCalls[1] ?? '', /FOR UPDATE/u);
});

test('addCharacterCurrencies: 应直接更新并返回，不再先锁 characters', async (t) => {
  const sqlCalls: string[] = [];

  t.mock.method(database, 'query', async (sql: string) => {
    sqlCalls.push(sql);

    if (sql.includes('UPDATE characters') && sql.includes('silver = silver + $2')) {
      return { rows: [{ id: 202 }] };
    }

    throw new Error(`未处理的 SQL: ${sql}`);
  });

  const result = await addCharacterCurrencies(202, {
    silver: 18,
    spiritStones: 6,
  });

  assert.deepEqual(result, {
    success: true,
    message: '增加成功',
  });
  assert.equal(sqlCalls.length, 1);
  assert.match(sqlCalls[0] ?? '', /UPDATE characters/u);
  assert.match(sqlCalls[0] ?? '', /RETURNING id/u);
  assert.doesNotMatch(sqlCalls[0] ?? '', /FOR UPDATE/u);
});

test('consumeCharacterStoredResources: 应支持经验并使用条件更新而不是先锁 characters', async (t) => {
  const sqlCalls: string[] = [];

  t.mock.method(database, 'query', async (sql: string) => {
    sqlCalls.push(sql);

    if (sql.includes('UPDATE characters') && sql.includes('exp = exp - $4')) {
      return { rows: [] };
    }
    if (sql.includes('SELECT silver, spirit_stones, exp FROM characters WHERE id = $1 LIMIT 1')) {
      return { rows: [{ silver: 30, spirit_stones: 20, exp: 5 }] };
    }

    throw new Error(`未处理的 SQL: ${sql}`);
  });

  const result = await consumeCharacterStoredResources(303, {
    silver: 10,
    spiritStones: 3,
    exp: 8,
  });

  assert.deepEqual(result, {
    success: false,
    message: '经验不足，需要8',
  });
  assert.equal(sqlCalls.length, 2);
  assert.match(sqlCalls[0] ?? '', /UPDATE characters/u);
  assert.match(sqlCalls[0] ?? '', /AND silver >= \$2/u);
  assert.match(sqlCalls[0] ?? '', /AND spirit_stones >= \$3/u);
  assert.match(sqlCalls[0] ?? '', /AND exp >= \$4/u);
  assert.doesNotMatch(sqlCalls[0] ?? '', /FOR UPDATE/u);
  assert.doesNotMatch(sqlCalls[1] ?? '', /FOR UPDATE/u);
});

test('consumeCharacterCurrenciesExact: 应以 bigint 条件更新扣费而不是先锁 characters', async (t) => {
  const sqlCalls: string[] = [];

  t.mock.method(database, 'query', async (sql: string) => {
    sqlCalls.push(sql);

    if (sql.includes('UPDATE characters') && sql.includes('silver = silver - $2')) {
      return { rows: [] };
    }
    if (sql.includes('SELECT silver, spirit_stones FROM characters WHERE id = $1 LIMIT 1')) {
      return { rows: [{ silver: '8', spirit_stones: '99' }] };
    }

    throw new Error(`未处理的 SQL: ${sql}`);
  });

  const result = await consumeCharacterCurrenciesExact(404, {
    silver: 10n,
    spiritStones: 3n,
  });

  assert.deepEqual(result, {
    success: false,
    message: '银两不足，需要10',
  });
  assert.equal(sqlCalls.length, 2);
  assert.match(sqlCalls[0] ?? '', /AND silver >= \$2/u);
  assert.match(sqlCalls[0] ?? '', /AND spirit_stones >= \$3/u);
  assert.doesNotMatch(sqlCalls[0] ?? '', /FOR UPDATE/u);
  assert.doesNotMatch(sqlCalls[1] ?? '', /FOR UPDATE/u);
});

test('addCharacterCurrenciesExact: 应直接更新 bigint 货币而不是先锁 characters', async (t) => {
  const sqlCalls: string[] = [];

  t.mock.method(database, 'query', async (sql: string) => {
    sqlCalls.push(sql);

    if (sql.includes('UPDATE characters') && sql.includes('silver = silver + $2')) {
      return { rows: [{ id: 505 }] };
    }

    throw new Error(`未处理的 SQL: ${sql}`);
  });

  const result = await addCharacterCurrenciesExact(505, {
    silver: 18n,
    spiritStones: 6n,
  });

  assert.deepEqual(result, {
    success: true,
    message: '增加成功',
  });
  assert.equal(sqlCalls.length, 1);
  assert.match(sqlCalls[0] ?? '', /UPDATE characters/u);
  assert.match(sqlCalls[0] ?? '', /RETURNING id/u);
  assert.doesNotMatch(sqlCalls[0] ?? '', /FOR UPDATE/u);
});
