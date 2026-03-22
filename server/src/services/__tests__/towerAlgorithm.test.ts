/**
 * 千层塔算法回归测试。
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：锁定“同角色同层、不同角色同层都必定生成同一批怪物/楼层预览”的稳定性，避免 hash 逻辑漂移后让楼层内容悄悄改变。
 * 2. 做什么：验证 5/10 层的层型节奏，防止后续重构把普通层、精英层、首领层判定写乱。
 * 3. 不做什么：不发起真实战斗，不校验数据库进度，也不覆盖掉落服务的随机分配实现。
 *
 * 输入/输出：
 * - 输入：角色 ID、楼层数。
 * - 输出：`resolveTowerFloor` 生成的楼层预览与怪物列表。
 *
 * 数据流/状态流：
 * - 调用 tower algorithm -> 读取静态怪物池 -> 断言层型与怪物预览符合预期规则。
 *
 * 关键边界条件与坑点：
 * 1. 这里锁的是“稳定性”和“节奏规则”，不是具体某只怪物名称；怪物池扩容后，测试仍应允许合法的新内容。
 * 2. 如果未来调整 5/10 层节奏，必须同步更新断言，否则会把设计变更误判成回归。
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import type { MonsterDefConfig } from '../staticConfigLoader.js';
import {
  resolveTowerFloor,
  resolveTowerFloorFromPools,
} from '../tower/algorithm.js';
import type { TowerMonsterPoolState } from '../tower/types.js';

const createAlgorithmTestMonster = (params: {
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

const createAlgorithmTestPools = (): TowerMonsterPoolState => {
  return {
    normal: new Map([
      ['凡人', [
        createAlgorithmTestMonster({
          id: 'normal-human-a',
          name: '凡人怪甲',
          realm: '凡人',
          kind: 'normal',
        }),
      ]],
      ['炼精化炁·养气期', [
        createAlgorithmTestMonster({
          id: 'normal-qi-a',
          name: '养气怪甲',
          realm: '炼精化炁·养气期',
          kind: 'normal',
        }),
        createAlgorithmTestMonster({
          id: 'normal-qi-b',
          name: '养气怪乙',
          realm: '炼精化炁·养气期',
          kind: 'normal',
        }),
      ]],
    ]),
    elite: new Map([
      ['凡人', [
        createAlgorithmTestMonster({
          id: 'elite-human-a',
          name: '凡人精英甲',
          realm: '凡人',
          kind: 'elite',
        }),
      ]],
      ['炼精化炁·养气期', [
        createAlgorithmTestMonster({
          id: 'elite-qi-a',
          name: '养气精英甲',
          realm: '炼精化炁·养气期',
          kind: 'elite',
        }),
      ]],
    ]),
    boss: new Map([
      ['凡人', [
        createAlgorithmTestMonster({
          id: 'boss-human-a',
          name: '凡人首领甲',
          realm: '凡人',
          kind: 'boss',
        }),
      ]],
      ['炼精化炁·养气期', [
        createAlgorithmTestMonster({
          id: 'boss-qi-a',
          name: '养气首领甲',
          realm: '炼精化炁·养气期',
          kind: 'boss',
        }),
        createAlgorithmTestMonster({
          id: 'boss-qi-b',
          name: '养气首领乙',
          realm: '炼精化炁·养气期',
          kind: 'boss',
        }),
      ]],
    ]),
  };
};

test('resolveTowerFloor: 同角色同层应生成稳定一致的楼层结果', () => {
  const first = resolveTowerFloor({ characterId: 1001, floor: 17 });
  const second = resolveTowerFloor({ characterId: 1001, floor: 17 });

  assert.deepEqual(first.preview, second.preview);
  assert.deepEqual(first.monsters, second.monsters);
});

test('resolveTowerFloor: 不同角色同层应生成完全一致的楼层结果', () => {
  const first = resolveTowerFloor({ characterId: 1001, floor: 17 });
  const second = resolveTowerFloor({ characterId: 2002, floor: 17 });

  assert.deepEqual(first.preview, second.preview);
  assert.deepEqual(first.monsters, second.monsters);
});

test('resolveTowerFloor: 第 5 层应为精英层', () => {
  const resolved = resolveTowerFloor({ characterId: 1001, floor: 5 });

  assert.equal(resolved.preview.kind, 'elite');
  assert.ok(resolved.monsters.length >= 1);
});

test('resolveTowerFloor: 第 10 层应为首领层且只有单个怪物', () => {
  const bossFloor = resolveTowerFloor({ characterId: 1001, floor: 10 });

  assert.equal(bossFloor.preview.kind, 'boss');
  assert.equal(bossFloor.monsters.length, 1);
});

test('resolveTowerFloorFromPools: 封顶后精英层应进入 elite 混池并按规则增长怪物数量', () => {
  const resolved = resolveTowerFloorFromPools({
    floor: 155,
    pools: createAlgorithmTestPools(),
  });

  assert.equal(resolved.preview.kind, 'elite');
  assert.equal(resolved.preview.realm, '炼精化炁·养气期·混池');
  assert.ok(
    resolved.preview.monsterIds.every((monsterId) => (
      monsterId === 'elite-human-a' || monsterId === 'elite-qi-a'
    )),
  );
  assert.equal(resolved.monsters.length, 4);
});

test('resolveTowerFloorFromPools: 封顶后普通层应进入 normal 混池并尽量避免重复怪', () => {
  const resolved = resolveTowerFloorFromPools({
    floor: 151,
    pools: createAlgorithmTestPools(),
  });

  assert.equal(resolved.preview.kind, 'normal');
  assert.equal(resolved.preview.realm, '炼精化炁·养气期·混池');
  assert.ok(
    resolved.preview.monsterIds.every((monsterId) => (
      monsterId === 'normal-human-a' || monsterId === 'normal-qi-a' || monsterId === 'normal-qi-b'
    )),
  );
  assert.equal(new Set(resolved.preview.monsterIds).size, 3);
  assert.equal(resolved.monsters.length, 5);
});

test('resolveTowerFloorFromPools: 封顶后 Boss 层应进入 boss 混池并按规则增长怪物数量', () => {
  const resolved = resolveTowerFloorFromPools({
    floor: 200,
    pools: createAlgorithmTestPools(),
  });

  assert.equal(resolved.preview.kind, 'boss');
  assert.equal(resolved.preview.realm, '炼精化炁·养气期·混池');
  assert.ok(
    resolved.preview.monsterIds.every((monsterId) => (
      monsterId === 'boss-human-a' || monsterId === 'boss-qi-a' || monsterId === 'boss-qi-b'
    )),
  );
  assert.equal(resolved.monsters.length, 3);
});

test('resolveTowerFloor: 怪物静态配置中的注释项不应参与怪物池构建', () => {
  const resolved = resolveTowerFloor({ characterId: 1001, floor: 1 });

  assert.ok(resolved.preview.monsterIds.length > 0);
  for (const monsterId of resolved.preview.monsterIds) {
    assert.equal(typeof monsterId, 'string');
    assert.ok(monsterId.trim().length > 0);
  }
});
