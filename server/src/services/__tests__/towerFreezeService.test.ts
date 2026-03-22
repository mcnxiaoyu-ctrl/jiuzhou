/**
 * 千层塔冻结前沿服务测试。
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：锁定冻结前沿推进必须单调递增，避免误把旧前沿回退或重复冻结成合法操作。
 * 2. 做什么：锁定 live 怪物池到冻结成员快照的扁平化规则，避免 freeze 入口和读取入口各自拼一套快照结构。
 * 3. 不做什么：不触发真实数据库写入，不执行脚本命令行，只测 freeze service 的纯规则。
 *
 * 输入/输出：
 * - 输入：当前/目标冻结前沿，以及 live 怪物池。
 * - 输出：冻结前沿校验结果与待写入的冻结成员快照列表。
 *
 * 数据流/状态流：
 * - 测试 -> freeze service 纯函数 -> 前沿校验 / 快照列表。
 *
 * 关键边界条件与坑点：
 * 1. 前沿推进只能前进，不能原地重复，也不能回退。
 * 2. 冻结的是怪物池成员关系，不是属性快照，所以输出里只应包含 `frozen_floor_max + kind + realm + monster_def_id`。
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import type { TowerMonsterPoolState } from '../tower/types.js';
import {
  assertTowerFrozenFrontierAdvanceable,
  buildTowerFrozenMonsterSnapshots,
} from '../tower/freezeService.js';

test('assertTowerFrozenFrontierAdvanceable: 目标前沿不大于当前前沿应报错', () => {
  assert.throws(
    () => assertTowerFrozenFrontierAdvanceable({ currentFrozenFloorMax: 80, nextFrozenFloorMax: 80 }),
    /冻结前沿必须大于当前前沿/,
  );
  assert.throws(
    () => assertTowerFrozenFrontierAdvanceable({ currentFrozenFloorMax: 80, nextFrozenFloorMax: 60 }),
    /冻结前沿必须大于当前前沿/,
  );
});

test('buildTowerFrozenMonsterSnapshots: 应把 live 怪物池拍平成冻结成员快照', () => {
  const pools: TowerMonsterPoolState = {
    normal: new Map([
      ['凡人', [
        { id: 'monster-a', name: '怪甲' },
        { id: 'monster-b', name: '怪乙' },
      ]],
    ]),
    elite: new Map([
      ['炼精化炁·养气期', [
        { id: 'monster-c', name: '怪丙' },
      ]],
    ]),
    boss: new Map(),
  };

  const snapshots = buildTowerFrozenMonsterSnapshots({
    frozenFloorMax: 80,
    pools,
  });

  assert.deepEqual(snapshots, [
    {
      frozenFloorMax: 80,
      kind: 'elite',
      realm: '炼精化炁·养气期',
      monsterDefId: 'monster-c',
    },
    {
      frozenFloorMax: 80,
      kind: 'normal',
      realm: '凡人',
      monsterDefId: 'monster-a',
    },
    {
      frozenFloorMax: 80,
      kind: 'normal',
      realm: '凡人',
      monsterDefId: 'monster-b',
    },
  ]);
});
