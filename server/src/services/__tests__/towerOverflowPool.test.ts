/**
 * 千层塔封顶后混池与数量增长测试。
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：锁定封顶前后候选池的切换规则，避免后续重构把“境界池”和“全量混池”边界写乱。
 * 2. 做什么：锁定普通/精英/Boss 的数量增长阈值与上限，避免层数增长后战斗规模悄悄漂移。
 * 3. 不做什么：不依赖数据库，不触发真实战斗，只测 tower algorithm 的纯规则入口。
 *
 * 输入/输出：
 * - 输入：自定义怪物池、楼层、层型与稳定 seed。
 * - 输出：候选怪物列表、池模式以及最终怪物数量。
 *
 * 数据流/状态流：
 * - 测试 -> tower algorithm 纯函数 -> 候选池选择 / 数量计算。
 *
 * 关键边界条件与坑点：
 * 1. 封顶前必须仍按当前境界池出怪，不能提前混池。
 * 2. 封顶后混池只按 `kind` 混用，且数量增长必须受上限约束。
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import type { MonsterDefConfig } from '../staticConfigLoader.js';
import {
  resolveTowerMonsterCandidatesForFloor,
  resolveTowerMonsterCountForFloor,
} from '../tower/algorithm.js';
import type { TowerMonsterPoolState } from '../tower/types.js';

const createMonster = (params: {
  id: string;
  name: string;
  realm: string;
  kind: 'normal' | 'elite' | 'boss';
}): MonsterDefConfig => {
  return {
    id: params.id,
    name: params.name,
    realm: params.realm,
    kind: params.kind,
    element: 'none',
    base_attrs: { qixue: 100, max_qixue: 100 },
    ai_profile: { skills: [] },
  };
};

const createTowerPools = (): TowerMonsterPoolState => {
  return {
    normal: new Map([
      ['凡人', [
        createMonster({
          id: 'normal-human-a',
          name: '凡人怪甲',
          realm: '凡人',
          kind: 'normal',
        }),
      ]],
      ['炼精化炁·养气期', [
        createMonster({
          id: 'normal-qi-b',
          name: '养气怪乙',
          realm: '炼精化炁·养气期',
          kind: 'normal',
        }),
      ]],
    ]),
    elite: new Map([
      ['凡人', [
        createMonster({
          id: 'elite-human-a',
          name: '凡人精英甲',
          realm: '凡人',
          kind: 'elite',
        }),
      ]],
      ['炼精化炁·养气期', [
        createMonster({
          id: 'elite-qi-b',
          name: '养气精英乙',
          realm: '炼精化炁·养气期',
          kind: 'elite',
        }),
      ]],
    ]),
    boss: new Map([
      ['凡人', [
        createMonster({
          id: 'boss-human-a',
          name: '凡人首领甲',
          realm: '凡人',
          kind: 'boss',
        }),
      ]],
      ['炼精化炁·养气期', [
        createMonster({
          id: 'boss-qi-b',
          name: '养气首领乙',
          realm: '炼精化炁·养气期',
          kind: 'boss',
        }),
      ]],
    ]),
  };
};

test('resolveTowerMonsterCandidatesForFloor: 封顶前应继续使用当前境界池', () => {
  const resolved = resolveTowerMonsterCandidatesForFloor({
    floor: 11,
    kind: 'normal',
    pools: createTowerPools(),
  });

  assert.equal(resolved.poolMode, 'realm');
  assert.equal(resolved.realm, '炼精化炁·养气期');
  assert.equal(resolved.overflowTierCount, 0);
  assert.deepEqual(resolved.candidates.map((monster) => monster.id), ['normal-qi-b']);
});

test('resolveTowerMonsterCandidatesForFloor: 封顶后普通层应切到 normal 全量混池', () => {
  const resolved = resolveTowerMonsterCandidatesForFloor({
    floor: 21,
    kind: 'normal',
    pools: createTowerPools(),
  });

  assert.equal(resolved.poolMode, 'mixed');
  assert.equal(resolved.realm, '炼精化炁·养气期');
  assert.equal(resolved.overflowTierCount, 1);
  assert.deepEqual(resolved.candidates.map((monster) => monster.id), ['normal-human-a', 'normal-qi-b']);
});

test('resolveTowerMonsterCandidatesForFloor: 封顶后精英层应切到 elite 全量混池', () => {
  const resolved = resolveTowerMonsterCandidatesForFloor({
    floor: 25,
    kind: 'elite',
    pools: createTowerPools(),
  });

  assert.equal(resolved.poolMode, 'mixed');
  assert.equal(resolved.overflowTierCount, 1);
  assert.deepEqual(resolved.candidates.map((monster) => monster.id), ['elite-human-a', 'elite-qi-b']);
});

test('resolveTowerMonsterCandidatesForFloor: 封顶后 Boss 层应切到 boss 全量混池', () => {
  const resolved = resolveTowerMonsterCandidatesForFloor({
    floor: 30,
    kind: 'boss',
    pools: createTowerPools(),
  });

  assert.equal(resolved.poolMode, 'mixed');
  assert.equal(resolved.overflowTierCount, 1);
  assert.deepEqual(resolved.candidates.map((monster) => monster.id), ['boss-human-a', 'boss-qi-b']);
});

test('resolveTowerMonsterCountForFloor: 普通层每 50 层加 1 且最多 5 只', () => {
  const floor1Count = resolveTowerMonsterCountForFloor({
    floor: 1,
    kind: 'normal',
    seed: 'tower:1',
  });
  const floor50Count = resolveTowerMonsterCountForFloor({
    floor: 50,
    kind: 'normal',
    seed: 'tower:50',
  });
  const floor150Count = resolveTowerMonsterCountForFloor({
    floor: 150,
    kind: 'normal',
    seed: 'tower:150',
  });
  const floor500Count = resolveTowerMonsterCountForFloor({
    floor: 500,
    kind: 'normal',
    seed: 'tower:500',
  });

  assert.ok(floor1Count >= 2 && floor1Count <= 3);
  assert.ok(floor50Count >= 3 && floor50Count <= 4);
  assert.equal(floor150Count, 5);
  assert.equal(floor500Count, 5);
});

test('resolveTowerMonsterCountForFloor: 精英层每 75 层加 1 且最多 4 只', () => {
  assert.equal(resolveTowerMonsterCountForFloor({
    floor: 5,
    kind: 'elite',
    seed: 'tower:5',
  }), 2);
  assert.equal(resolveTowerMonsterCountForFloor({
    floor: 75,
    kind: 'elite',
    seed: 'tower:75',
  }), 3);
  assert.equal(resolveTowerMonsterCountForFloor({
    floor: 150,
    kind: 'elite',
    seed: 'tower:150',
  }), 4);
  assert.equal(resolveTowerMonsterCountForFloor({
    floor: 600,
    kind: 'elite',
    seed: 'tower:600',
  }), 4);
});

test('resolveTowerMonsterCountForFloor: Boss 层每 100 层加 1 且最多 3 只', () => {
  assert.equal(resolveTowerMonsterCountForFloor({
    floor: 10,
    kind: 'boss',
    seed: 'tower:10',
  }), 1);
  assert.equal(resolveTowerMonsterCountForFloor({
    floor: 100,
    kind: 'boss',
    seed: 'tower:100',
  }), 2);
  assert.equal(resolveTowerMonsterCountForFloor({
    floor: 200,
    kind: 'boss',
    seed: 'tower:200',
  }), 3);
  assert.equal(resolveTowerMonsterCountForFloor({
    floor: 1000,
    kind: 'boss',
    seed: 'tower:1000',
  }), 3);
});
