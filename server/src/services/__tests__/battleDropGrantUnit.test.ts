/**
 * 战斗掉落发放单元聚合测试
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：锁定普通非装备掉落在同角色、同物品、同绑定类型下合并数量。
 * 2. 做什么：锁定装备和带品质权重的掉落保持逐件发放，避免改变装备生成随机性。
 * 3. 不做什么：不调用 itemService，不连接数据库，不验证掉落概率。
 *
 * 输入 / 输出：
 * - 输入：战斗掉落条目及其静态分类。
 * - 输出：发放单元数组，包含聚合后的 quantity 和 sourceDropCount。
 *
 * 数据流 / 状态流：
 * plan.drops -> buildBattleDropGrantUnits -> battleDropService 顺序调用发奖服务。
 *
 * 复用设计说明：
 * - 聚合规则集中到纯函数，战斗结算和后续秘境结算都能复用，不在事务循环里散落判断。
 * - 测试只依赖公开输入类型，避免和 battleDropService 的事务、邮件、背包上下文耦合。
 *
 * 关键边界条件与坑点：
 * 1. 装备不可合并，否则会把逐件品质/词缀/福缘随机压成一次。
 * 2. 不同 receiver、bindType 或 qualityWeights 不可合并，否则归属、绑定状态或品质随机会错。
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { buildBattleDropGrantUnits, type BattleDropGrantInput } from '../battleDropGrantUnit.js';

const createInput = (overrides: Partial<BattleDropGrantInput>): BattleDropGrantInput => ({
  receiverCharacterId: 1001,
  receiverUserId: 101,
  receiverFuyuan: 1,
  itemDefId: 'material_herb',
  quantity: 1,
  bindType: 'bound',
  category: 'material',
  ...overrides,
});

test('普通非装备掉落应按角色、物品和绑定类型合并', () => {
  const units = buildBattleDropGrantUnits([
    createInput({ quantity: 1 }),
    createInput({ quantity: 2 }),
  ]);

  assert.equal(units.length, 1);
  assert.equal(units[0]?.quantity, 3);
  assert.equal(units[0]?.sourceDropCount, 2);
});

test('装备掉落必须保持逐件发放', () => {
  const units = buildBattleDropGrantUnits([
    createInput({
      receiverFuyuan: 8,
      itemDefId: 'weapon_test_blade',
      category: 'equipment',
    }),
    createInput({
      receiverFuyuan: 8,
      itemDefId: 'weapon_test_blade',
      category: 'equipment',
    }),
  ]);

  assert.equal(units.length, 2);
  assert.deepEqual(units.map((unit) => unit.quantity), [1, 1]);
  assert.deepEqual(units.map((unit) => unit.sourceDropCount), [1, 1]);
});

test('不同角色或不同绑定类型不得合并', () => {
  const units = buildBattleDropGrantUnits([
    createInput({ receiverCharacterId: 1001, receiverUserId: 101, bindType: 'bound' }),
    createInput({ receiverCharacterId: 1002, receiverUserId: 102, bindType: 'bound' }),
    createInput({ receiverCharacterId: 1001, receiverUserId: 101, bindType: 'unbound' }),
    createInput({ receiverCharacterId: 1001, receiverUserId: 102, bindType: 'bound' }),
  ]);

  assert.equal(units.length, 4);
  assert.deepEqual(
    units.map((unit) => [unit.receiverCharacterId, unit.receiverUserId, unit.bindType, unit.quantity]),
    [
      [1001, 101, 'bound', 1],
      [1002, 102, 'bound', 1],
      [1001, 101, 'unbound', 1],
      [1001, 102, 'bound', 1],
    ],
  );
});

test('同角色同用户的普通非装备掉落不按福缘拆开发放单元', () => {
  const units = buildBattleDropGrantUnits([
    createInput({ receiverFuyuan: 1, quantity: 1 }),
    createInput({ receiverFuyuan: 9, quantity: 2 }),
  ]);

  assert.equal(units.length, 1);
  assert.equal(units[0]?.quantity, 3);
  assert.equal(units[0]?.receiverFuyuan, 1);
});

test('带 qualityWeights 的普通掉落不得合并', () => {
  const units = buildBattleDropGrantUnits([
    createInput({ itemDefId: 'material_weighted', qualityWeights: { '黄': 100 } }),
    createInput({ itemDefId: 'material_weighted', qualityWeights: { '黄': 100 } }),
  ]);

  assert.equal(units.length, 2);
  assert.deepEqual(units.map((unit) => unit.sourceDropCount), [1, 1]);
});
