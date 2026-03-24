/**
 * 秘境掉落境界压制豁免测试
 *
 * 作用（做什么 / 不做什么）：
 * - 做什么：锁定 `battleDropService.rollDrops` 在秘境场景下不再吃境界压制掉落衰减。
 * - 做什么：同时覆盖概率池与权重池两条分支，确保规则通过统一入口复用，而不是只修一条链路。
 * - 不做什么：不验证经验、银两结算，也不触发真实数据库与背包分发流程。
 *
 * 输入/输出：
 * - 输入：最小化的内联掉落池、固定的境界压制倍率、秘境/非秘境场景参数。
 * - 输出：普通战斗会被衰减拦住，秘境战斗在同样倍率下仍可掉落。
 *
 * 数据流/状态流：
 * - 测试直接调用 `rollDrops`；
 * - `rollDrops` 内部统一读取“掉落境界压制倍率”；
 * - 因而该测试能同时约束单人奖励计划与组队结算共用的掉落判定入口。
 *
 * 关键边界条件与坑点：
 * 1. 概率池与权重池的压制生效位置不同，必须分别断言，避免只覆盖一条分支。
 * 2. 这里传入的是显式 `realmSuppressionMultiplier`，用于锁定“秘境会忽略该掉落衰减输入”这一规则，而不是依赖具体境界文案解析。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { battleDropService } from '../battleDropService.js';

test('秘境概率池掉落不应受境界压制倍率衰减影响', (t) => {
  const dropPool = {
    id: 'test-prob-pool',
    name: '测试概率池',
    mode: 'prob' as const,
    entries: [
      {
        id: 1,
        item_def_id: 'cons-rename-001',
        chance: 1,
        weight: 0,
        chance_add_by_monster_realm: 0,
        qty_min: 1,
        qty_max: 1,
        qty_min_add_by_monster_realm: 0,
        qty_max_add_by_monster_realm: 0,
        qty_multiply_by_monster_realm: 1,
        quality_weights: null,
        bind_type: 'none',
        sourceType: 'exclusive' as const,
        sourcePoolId: 'test-prob-pool',
      },
    ],
  };

  t.mock.method(Math, 'random', () => 0.5);

  assert.deepEqual(
    battleDropService.rollDrops(dropPool, 0, {
      isDungeonBattle: false,
      realmSuppressionMultiplier: 0.25,
    }),
    [],
  );

  assert.deepEqual(
    battleDropService.rollDrops(dropPool, 0, {
      isDungeonBattle: true,
      realmSuppressionMultiplier: 0.25,
    }),
    [
      {
        itemDefId: 'cons-rename-001',
        quantity: 1,
        bindType: 'none',
      },
    ],
  );
});

test('秘境权重池掉落不应受境界压制倍率衰减影响', (t) => {
  const dropPool = {
    id: 'test-weight-pool',
    name: '测试权重池',
    mode: 'weight' as const,
    entries: [
      {
        id: 1,
        item_def_id: 'cons-rename-001',
        chance: 0,
        weight: 1,
        chance_add_by_monster_realm: 0,
        qty_min: 1,
        qty_max: 1,
        qty_min_add_by_monster_realm: 0,
        qty_max_add_by_monster_realm: 0,
        qty_multiply_by_monster_realm: 1,
        quality_weights: null,
        bind_type: 'none',
        sourceType: 'exclusive' as const,
        sourcePoolId: 'test-weight-pool',
      },
    ],
  };

  const randomValues = [0.5, 0];
  t.mock.method(Math, 'random', () => {
    const nextValue = randomValues.shift();
    return typeof nextValue === 'number' ? nextValue : 0;
  });

  assert.deepEqual(
    battleDropService.rollDrops(dropPool, 0, {
      isDungeonBattle: false,
      realmSuppressionMultiplier: 0.25,
    }),
    [],
  );

  randomValues.push(0.5, 0);

  assert.deepEqual(
    battleDropService.rollDrops(dropPool, 0, {
      isDungeonBattle: true,
      realmSuppressionMultiplier: 0.25,
    }),
    [
      {
        itemDefId: 'cons-rename-001',
        quantity: 1,
        bindType: 'none',
      },
    ],
  );
});
