/**
 * 千层塔冻结前沿回归测试。
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：先锁定“冻结前沿区间内，楼层生成必须从冻结怪物池快照读取”的目标行为。
 * 2. 做什么：把“同一层全服一致 + 冻结区间不漂移”这条规则写成可执行的失败测试，给后续实现留钩子。
 * 3. 不做什么：不实现冻结池构建，不读写数据库，不改 tower service 生产代码。
 *
 * 输入/输出：
 * - 输入：楼层号与未来冻结前沿的怪物池来源。
 * - 输出：该楼层实际应使用的候选池标记与楼层结果。
 *
 * 数据流/状态流：
 * - 测试 -> 未来冻结前沿选择器 -> 冻结/最新怪物池来源 -> 楼层结果。
 *
 * 关键边界条件与坑点：
 * 1. 冻结前沿不是“每层手工配置”，而是一个全局边界，因此测试必须表达“按边界选来源”而不是按单层静态写死。
 * 2. 旧层和新层可以共享同一套生成算法，但不能共享会漂移的怪物池来源。
 */

import assert from 'node:assert/strict';
import test from 'node:test';

interface TowerFloorPreview {
  floor: number;
  kind: 'normal' | 'elite' | 'boss';
  seed: string;
  realm: string;
  monsterIds: string[];
  monsterNames: string[];
}

interface TowerMonsterSnapshot {
  id: string;
  name: string;
}

interface TowerFloorResolution {
  poolSource: 'frozen' | 'latest';
  preview: TowerFloorPreview;
  monsters: TowerMonsterSnapshot[];
}

interface TowerPoolResolver {
  (floor: number): TowerFloorResolution;
}

test('resolveTowerFloorFromFrozenFrontier: 冻结前沿内应使用冻结怪物池快照', async () => {
  const modulePath = '../tower/' + 'frozenFrontier.js';
  const { resolveTowerFloorFromFrozenFrontier } = await import(modulePath);
  const frozenResolver: TowerPoolResolver = (floor) => ({
    poolSource: 'frozen',
    preview: {
      floor,
      kind: 'normal',
      seed: `frozen:${floor}`,
      realm: '炼精化炁·养气期',
      monsterIds: ['frozen-monster-a'],
      monsterNames: ['冻结怪A'],
    },
    monsters: [{ id: 'frozen-monster-a', name: '冻结怪A' }],
  });
  const latestResolver: TowerPoolResolver = (floor) => ({
    poolSource: 'latest',
    preview: {
      floor,
      kind: 'normal',
      seed: `latest:${floor}`,
      realm: '炼精化炁·养气期',
      monsterIds: ['latest-monster-b'],
      monsterNames: ['最新怪B'],
    },
    monsters: [{ id: 'latest-monster-b', name: '最新怪B' }],
  });

  const resolved = resolveTowerFloorFromFrozenFrontier({
    floor: 37,
    frozenFloorMax: 80,
    frozenResolver,
    latestResolver,
  });

  assert.equal(resolved.poolSource, 'frozen');
  assert.equal(resolved.preview.floor, 37);
  assert.equal(resolved.preview.kind, 'normal');
  assert.deepEqual(resolved.preview.monsterIds, ['frozen-monster-a']);
  assert.deepEqual(resolved.monsters, [{ id: 'frozen-monster-a', name: '冻结怪A' }]);
  assert.notDeepEqual(resolved.preview.monsterIds, ['latest-monster-b']);
});

test('resolveTowerFloorFromFrozenFrontier: 冻结前沿外应使用最新怪物池', async () => {
  const modulePath = '../tower/' + 'frozenFrontier.js';
  const { resolveTowerFloorFromFrozenFrontier } = await import(modulePath);
  const frozenResolver: TowerPoolResolver = (floor) => ({
    poolSource: 'frozen',
    preview: {
      floor,
      kind: 'boss',
      seed: `frozen:${floor}`,
      realm: '炼精化炁·养气期',
      monsterIds: ['frozen-monster-a'],
      monsterNames: ['冻结怪A'],
    },
    monsters: [{ id: 'frozen-monster-a', name: '冻结怪A' }],
  });
  const latestResolver: TowerPoolResolver = (floor) => ({
    poolSource: 'latest',
    preview: {
      floor,
      kind: 'boss',
      seed: `latest:${floor}`,
      realm: '炼神返虚·还虚期',
      monsterIds: ['latest-monster-b'],
      monsterNames: ['最新怪B'],
    },
    monsters: [{ id: 'latest-monster-b', name: '最新怪B' }],
  });

  const resolved = resolveTowerFloorFromFrozenFrontier({
    floor: 137,
    frozenFloorMax: 80,
    frozenResolver,
    latestResolver,
  });

  assert.equal(resolved.poolSource, 'latest');
  assert.equal(resolved.preview.floor, 137);
  assert.deepEqual(resolved.preview.monsterIds, ['latest-monster-b']);
  assert.deepEqual(resolved.monsters, [{ id: 'latest-monster-b', name: '最新怪B' }]);
  assert.notDeepEqual(resolved.preview.monsterIds, ['frozen-monster-a']);
});
