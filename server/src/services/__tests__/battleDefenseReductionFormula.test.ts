/**
 * 作用：
 * - 校验新的防御减伤机制是否符合“攻防对抗曲线”预期，避免减伤回归到旧的高收益形态。
 * - 同时覆盖纯函数与伤害流程集成，保证公式与实战结算一致。
 *
 * 输入/输出：
 * - 输入：构造后的 BattleState / BattleUnit 与固定伤害配置。
 * - 输出：断言减伤率与最终伤害是否符合公式与业务目标。
 *
 * 数据流/状态流：
 * - 测试先调用 calculateDefenseReductionRate 获取理论减伤，再调用 calculateDamage 校验实际生效结果。
 * - 全部使用内存对象构造战斗状态，不依赖数据库或外部服务。
 *
 * 关键边界条件与坑点：
 * - 真实伤害不应进入防御减伤流程，即便目标防御极高也必须保持原值。
 * - 法术伤害必须读取 fagong/fafang，不能误读物理攻防属性。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateDefenseReductionRate } from '../../battle/modules/defense.js';
import { calculateDamage } from '../../battle/modules/damage.js';
import { BATTLE_CONSTANTS, type BattleAttrs, type BattleState, type BattleUnit } from '../../battle/types.js';

const BASE_ATTRS: BattleAttrs = {
  max_qixue: 1200,
  max_lingqi: 300,
  wugong: 120,
  fagong: 120,
  wufang: 120,
  fafang: 120,
  sudu: 100,
  mingzhong: 1,
  shanbi: 0,
  zhaojia: 0,
  baoji: 0,
  baoshang: 1.5,
  kangbao: 0,
  zengshang: 0,
  zhiliao: 0,
  jianliao: 0,
  xixue: 0,
  lengque: 0,
  kongzhi_kangxing: 0,
  jin_kangxing: 0,
  mu_kangxing: 0,
  shui_kangxing: 0,
  huo_kangxing: 0,
  tu_kangxing: 0,
  qixue_huifu: 0,
  lingqi_huifu: 0,
  realm: '炼炁化神·采药期',
  element: 'none',
};

function createAttrs(overrides: Partial<BattleAttrs> = {}): BattleAttrs {
  return {
    ...BASE_ATTRS,
    ...overrides,
  };
}

function createUnit(id: string, overrides: Partial<BattleAttrs> = {}): BattleUnit {
  const attrs = createAttrs(overrides);
  return {
    id,
    name: id,
    type: 'player',
    sourceId: Number(id.replace(/\D/g, '')) || 1,
    baseAttrs: { ...attrs },
    currentAttrs: { ...attrs },
    qixue: attrs.max_qixue,
    lingqi: attrs.max_lingqi,
    shields: [],
    buffs: [],
    skills: [],
    skillCooldowns: {},
    skillCooldownDiscountBank: {},
    setBonusEffects: [],
    controlDiminishing: {},
    isAlive: true,
    canAct: true,
    stats: {
      damageDealt: 0,
      damageTaken: 0,
      healingDone: 0,
      healingReceived: 0,
      killCount: 0,
    },
  };
}

function createState(attacker: BattleUnit, defender: BattleUnit): BattleState {
  return {
    battleId: 'battle-defense-formula-test',
    battleType: 'pve',
    teams: {
      attacker: {
        odwnerId: 1,
        units: [attacker],
        totalSpeed: attacker.currentAttrs.sudu,
      },
      defender: {
        odwnerId: 2,
        units: [defender],
        totalSpeed: defender.currentAttrs.sudu,
      },
    },
    roundCount: 1,
    currentTeam: 'attacker',
    currentUnitId: null,
    phase: 'action',
    firstMover: 'attacker',
    logs: [],
    randomSeed: 1,
    randomIndex: 0,
  };
}

function assertClose(actual: number, expected: number, message: string): void {
  assert.ok(Math.abs(actual - expected) < 1e-10, `${message}: actual=${actual}, expected=${expected}`);
}

function expectedDefenseReduction(defense: number, attack: number): number {
  return defense / (
    defense
    + attack * BATTLE_CONSTANTS.DEFENSE_ATTACK_FACTOR
    + BATTLE_CONSTANTS.DEFENSE_BASE_OFFSET
  );
}

test('物理攻防相等时减伤应位于20%-30%并匹配公式', () => {
  const attacker = createUnit('attacker-1', { wugong: 180 });
  const defender = createUnit('defender-1', { wufang: 180 });
  const reduction = calculateDefenseReductionRate(attacker, defender, 'physical');
  const expected = expectedDefenseReduction(180, 180);

  assert.ok(reduction >= 0.2 && reduction <= 0.3, `减伤率应在20%-30%，当前=${reduction}`);
  assertClose(reduction, expected, '攻防相等场景公式偏差');
});

test('防御高于攻击时减伤应提升但不会接近免伤', () => {
  const baselineAttacker = createUnit('attacker-2', { wugong: 180 });
  const baselineDefender = createUnit('defender-2', { wufang: 180 });
  const higherDefenseDefender = createUnit('defender-3', { wufang: 260 });

  const baselineReduction = calculateDefenseReductionRate(baselineAttacker, baselineDefender, 'physical');
  const higherDefenseReduction = calculateDefenseReductionRate(baselineAttacker, higherDefenseDefender, 'physical');
  const expected = expectedDefenseReduction(260, 180);

  assert.ok(higherDefenseReduction > baselineReduction, '防御提升后减伤应同步提升');
  assert.ok(higherDefenseReduction < 0.5, `减伤不应接近免伤，当前=${higherDefenseReduction}`);
  assertClose(higherDefenseReduction, expected, '高防场景公式偏差');
});

test('攻击高于防御时减伤应明显下降', () => {
  const equalAttacker = createUnit('attacker-4', { wugong: 180 });
  const equalDefender = createUnit('defender-4', { wufang: 180 });
  const highAttackAttacker = createUnit('attacker-5', { wugong: 260 });

  const equalReduction = calculateDefenseReductionRate(equalAttacker, equalDefender, 'physical');
  const highAttackReduction = calculateDefenseReductionRate(highAttackAttacker, equalDefender, 'physical');
  const expected = expectedDefenseReduction(180, 260);

  assert.ok(highAttackReduction < equalReduction, '攻击提升后减伤应下降');
  assert.ok(highAttackReduction < 0.2, `高攻压制场景减伤应低于20%，当前=${highAttackReduction}`);
  assertClose(highAttackReduction, expected, '高攻场景公式偏差');
});

test('真实伤害不受防御减伤影响', () => {
  const attacker = createUnit('attacker-6', {
    mingzhong: 1,
    wugong: 300,
    fagong: 300,
    baoji: 0,
  });
  const defender = createUnit('defender-6', {
    shanbi: 0,
    zhaojia: 0,
    kangbao: 0,
    wufang: 999,
    fafang: 999,
  });
  const state = createState(attacker, defender);

  const result = calculateDamage(state, attacker, defender, {
    damageType: 'true',
    element: 'none',
    baseDamage: 200,
  });

  assert.equal(result.isMiss, false);
  assert.equal(result.damage, 200);
});

test('法术伤害应读取 fagong/fafang，不应混用物理攻防', () => {
  const attacker = createUnit('attacker-7', {
    mingzhong: 1,
    wugong: 50,
    fagong: 200,
  });
  const defender = createUnit('defender-7', {
    shanbi: 0,
    zhaojia: 0,
    wufang: 500,
    fafang: 100,
  });
  const state = createState(attacker, defender);

  const magicReduction = calculateDefenseReductionRate(attacker, defender, 'magic');
  const physicalReduction = calculateDefenseReductionRate(attacker, defender, 'physical');
  const expectedMagicReduction = expectedDefenseReduction(100, 200);
  const expectedDamage = Math.floor(200 * (1 - expectedMagicReduction));

  const damageResult = calculateDamage(state, attacker, defender, {
    damageType: 'magic',
    element: 'none',
    baseDamage: 200,
  });

  assert.ok(physicalReduction > magicReduction, '物理减伤应更高，证明法术未误读 wufang');
  assertClose(magicReduction, expectedMagicReduction, '法术减伤公式偏差');
  assert.equal(damageResult.damage, expectedDamage);
});
