/**
 * 千层塔冻结池回归测试。
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：锁定冻结前沿行的规范化结果，避免读取入口后续在字段名与数值口径上漂移。
 * 2. 做什么：锁定冻结怪物快照的分组行为，确保同一冻结前沿下的怪物池按 `kind + realm` 集中组装。
 * 3. 不做什么：不连数据库，不触碰 tower 算法切换逻辑，只测 `frozenPool.ts` 的入口与纯组装函数。
 *
 * 输入/输出：
 * - 输入：冻结前沿行、冻结怪物快照行。
 * - 输出：规范化后的前沿记录与分组后的冻结怪物池。
 *
 * 数据流/状态流：
 * - 测试 -> `tower/frozenPool` 纯函数 -> 冻结前沿记录 / 冻结怪物池。
 *
 * 关键边界条件与坑点：
 * 1. 冻结池必须按 `kind + realm` 聚合，否则后续塔战组装会回到散落的怪物行。
 * 2. 冻结前沿的值必须是单一入口读出的主数据，不能在不同函数里各自解读出不同含义。
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import * as database from '../../config/database.js';
import {
  buildFrozenTowerMonsterPools,
  loadFrozenTowerPool,
  normalizeFrozenTowerFrontierRow,
} from '../tower/frozenPool.js';
import type { MonsterDefConfig } from '../staticConfigLoader.js';
import { resolveTowerMonsterCandidatesForFloor } from '../tower/algorithm.js';

test('normalizeFrozenTowerFrontierRow: 应规范化单一冻结前沿行', () => {
  const normalized = normalizeFrozenTowerFrontierRow({
    scope: 'tower',
    frozen_floor_max: 0,
    updated_at: '2026-03-22T00:00:00.000Z',
  });

  assert.deepEqual(normalized, {
    frozenFloorMax: 0,
    updatedAt: '2026-03-22T00:00:00.000Z',
  });
});

test('buildFrozenTowerMonsterPools: 空快照应返回空池', () => {
  const pools = buildFrozenTowerMonsterPools([]);

  assert.equal(pools.normal.size, 0);
  assert.equal(pools.elite.size, 0);
  assert.equal(pools.boss.size, 0);
});

test('buildFrozenTowerMonsterPools: 应按 kind 和 realm 组装冻结怪物池', () => {
  const monsterDefinitions: MonsterDefConfig[] = [
    {
      id: 'tower-frozen-monster-a',
      name: '最新怪甲',
      realm: '炼神返虚·还虚期',
      kind: 'boss',
      element: 'water',
      base_attrs: { qixue: 100, max_qixue: 100 },
      ai_profile: { skills: ['skill-a'] },
    },
    {
      id: 'tower-frozen-monster-b',
      name: '最新怪乙',
      realm: '炼神返虚·还虚期',
      kind: 'boss',
      element: 'fire',
      base_attrs: { qixue: 120, max_qixue: 120 },
      ai_profile: { skills: ['skill-b'] },
    },
    {
      id: 'tower-frozen-monster-c',
      name: '最新首领怪',
      realm: '凡人',
      kind: 'normal',
      element: 'fire',
      base_attrs: { qixue: 800, max_qixue: 800 },
      ai_profile: { skills: ['skill-c'] },
    },
    {
      id: 'tower-frozen-monster-d',
      name: '最新精英怪',
      realm: '凡人',
      kind: 'normal',
      element: 'wood',
      base_attrs: { qixue: 300, max_qixue: 300 },
      ai_profile: { skills: ['skill-d'] },
    },
  ];
  const pools = buildFrozenTowerMonsterPools([
    {
      frozen_floor_max: 80,
      kind: 'normal',
      realm: '凡人',
      monster_def_id: 'tower-frozen-monster-a',
      updated_at: '2026-03-22T00:00:00.000Z',
    },
    {
      frozen_floor_max: 80,
      kind: 'normal',
      realm: '凡人',
      monster_def_id: 'tower-frozen-monster-b',
      updated_at: '2026-03-22T00:00:00.000Z',
    },
    {
      frozen_floor_max: 80,
      kind: 'boss',
      realm: '炼精化炁·养气期',
      monster_def_id: 'tower-frozen-monster-c',
      updated_at: '2026-03-22T00:00:00.000Z',
    },
    {
      frozen_floor_max: 80,
      kind: 'elite',
      realm: '炼精化炁·养气期',
      monster_def_id: 'tower-frozen-monster-d',
      updated_at: '2026-03-22T00:00:00.000Z',
    },
  ], monsterDefinitions);

  const normalPool = pools.normal.get('凡人');
  const bossPool = pools.boss.get('炼精化炁·养气期');
  const elitePool = pools.elite.get('炼精化炁·养气期');

  assert.equal(normalPool?.length, 2);
  assert.equal(normalPool?.[0]?.id, 'tower-frozen-monster-a');
  assert.equal(normalPool?.[0]?.realm, '凡人');
  assert.equal(normalPool?.[0]?.kind, 'normal');
  assert.equal(normalPool?.[0]?.name, '最新怪甲');
  assert.equal(normalPool?.[1]?.id, 'tower-frozen-monster-b');
  assert.equal(bossPool?.length, 1);
  assert.equal(bossPool?.[0]?.id, 'tower-frozen-monster-c');
  assert.equal(bossPool?.[0]?.realm, '炼精化炁·养气期');
  assert.equal(bossPool?.[0]?.kind, 'boss');
  assert.equal(elitePool?.[0]?.id, 'tower-frozen-monster-d');
});

test('buildFrozenTowerMonsterPools: 组装后的冻结池应支持封顶后同类混池', () => {
  const pools = buildFrozenTowerMonsterPools([
    {
      frozen_floor_max: 80,
      kind: 'boss',
      realm: '凡人',
      monster_def_id: 'tower-frozen-monster-a',
      updated_at: '2026-03-22T00:00:00.000Z',
    },
    {
      frozen_floor_max: 80,
      kind: 'boss',
      realm: '炼精化炁·养气期',
      monster_def_id: 'tower-frozen-monster-b',
      updated_at: '2026-03-22T00:00:00.000Z',
    },
  ], [
    {
      id: 'tower-frozen-monster-a',
      name: '冻结首领甲',
      realm: '凡人',
      kind: 'boss',
    },
    {
      id: 'tower-frozen-monster-b',
      name: '冻结首领乙',
      realm: '炼精化炁·养气期',
      kind: 'boss',
    },
  ]);

  const resolved = resolveTowerMonsterCandidatesForFloor({
    floor: 30,
    kind: 'boss',
    pools,
  });

  assert.equal(resolved.poolMode, 'mixed');
  assert.deepEqual(resolved.candidates.map((monster) => monster.id), [
    'tower-frozen-monster-a',
    'tower-frozen-monster-b',
  ]);
});

test('buildFrozenTowerMonsterPools: 缺少当前怪物定义应报错', () => {
  assert.throws(
    () =>
      buildFrozenTowerMonsterPools([
        {
          frozen_floor_max: 80,
          kind: 'normal',
          realm: '凡人',
          monster_def_id: 'tower-frozen-monster-a',
          updated_at: '2026-03-22T00:00:00.000Z',
        },
      ], []),
    /千层塔冻结怪物定义不存在: tower-frozen-monster-a/,
  );
});

test('buildFrozenTowerMonsterPools: 混入不同 frozen_floor_max 应报错', () => {
  assert.throws(
    () =>
      buildFrozenTowerMonsterPools([
        {
          frozen_floor_max: 80,
          kind: 'normal',
          realm: '凡人',
          monster_def_id: 'tower-frozen-monster-a',
          updated_at: '2026-03-22T00:00:00.000Z',
        },
        {
          frozen_floor_max: 81,
          kind: 'elite',
          realm: '炼精化炁·养气期',
          monster_def_id: 'tower-frozen-monster-b',
          updated_at: '2026-03-22T00:00:00.000Z',
        },
        {
          frozen_floor_max: 80,
          kind: 'boss',
          realm: '炼精化炁·养气期',
          monster_def_id: 'tower-frozen-monster-c',
          updated_at: '2026-03-22T00:00:00.000Z',
        },
      ], [
        {
          id: 'tower-frozen-monster-a',
          name: '最新怪甲',
        },
        {
          id: 'tower-frozen-monster-b',
          name: '最新怪乙',
        },
        {
          id: 'tower-frozen-monster-c',
          name: '最新首领怪',
        },
      ]),
    /前沿值不一致/,
  );
});

test('loadFrozenTowerPool: frontier=0 允许空池且 frontier>0 缺快照报错', async (t) => {
  let frontierFloorMax = 0;

  t.mock.method(database.pool, 'query', async (sql: string) => {
    if (sql.includes('FROM tower_frozen_frontier')) {
      return {
        rows: [
          {
            scope: 'tower',
            frozen_floor_max: frontierFloorMax,
            updated_at: '2026-03-22T00:00:00.000Z',
          },
        ],
      };
    }
    if (sql.includes('FROM tower_frozen_monster_snapshot')) {
      return { rows: [] };
    }
    assert.fail(`未预期的 SQL: ${sql}`);
  });

  const emptyResult = await loadFrozenTowerPool();
  assert.equal(emptyResult.frontier.frozenFloorMax, 0);
  assert.equal(emptyResult.pools.normal.size, 0);
  assert.equal(emptyResult.pools.elite.size, 0);
  assert.equal(emptyResult.pools.boss.size, 0);

  frontierFloorMax = 80;
  await assert.rejects(
    () => loadFrozenTowerPool(),
    /千层塔冻结怪物池缺失: frozen_floor_max=80/,
  );
});

test('loadFrozenTowerPool: 冻结前沿缺行时应视为 frontier=0', async (t) => {
  t.mock.method(database.pool, 'query', async (sql: string) => {
    if (sql.includes('FROM tower_frozen_frontier')) {
      return { rows: [] };
    }
    if (sql.includes('FROM tower_frozen_monster_snapshot')) {
      return { rows: [] };
    }
    assert.fail(`未预期的 SQL: ${sql}`);
  });

  const result = await loadFrozenTowerPool();

  assert.equal(result.frontier.frozenFloorMax, 0);
  assert.equal(result.pools.normal.size, 0);
  assert.equal(result.pools.elite.size, 0);
  assert.equal(result.pools.boss.size, 0);
});
