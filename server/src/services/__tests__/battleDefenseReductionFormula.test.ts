/**
 * 作用：
 * - 校验新的防御减伤机制是否符合“攻击 × K / (防御 + K)”预期，避免战斗流程继续读取旧曲线参数。
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
  jianbaoshang: 0,
  jianfantan: 0,
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

function createUnit(
  id: string,
  overrides: Partial<BattleAttrs> = {},
  unitType: BattleUnit['type'] = 'player',
): BattleUnit {
  const attrs = createAttrs(overrides);
  return {
    id,
    name: id,
    type: unitType,
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
    randomSeed: 1,
    randomIndex: 0,
  };
}

function assertClose(actual: number, expected: number, message: string): void {
  assert.ok(Math.abs(actual - expected) < 1e-10, `${message}: actual=${actual}, expected=${expected}`);
}

function expectedDefenseReduction(defense: number): number {
  return defense / (defense + BATTLE_CONSTANTS.DEFENSE_DAMAGE_K);
}

test('物理防御结算应匹配 K 固定的新公式', () => {
  const defender = createUnit('defender-1', { wufang: 180 });
  const reduction = calculateDefenseReductionRate(defender, 'physical');
  const expected = expectedDefenseReduction(180);

  assert.ok(reduction > 0 && reduction < 0.2, `减伤率应低于20%，当前=${reduction}`);
  assertClose(reduction, expected, '攻防相等场景公式偏差');
});

test('防御提升时减伤应同步提升，但仍受固定 K 限制', () => {
  const baselineDefender = createUnit('defender-2', { wufang: 180 });
  const higherDefenseDefender = createUnit('defender-3', { wufang: 260 });

  const baselineReduction = calculateDefenseReductionRate(baselineDefender, 'physical');
  const higherDefenseReduction = calculateDefenseReductionRate(higherDefenseDefender, 'physical');
  const expected = expectedDefenseReduction(260);

  assert.ok(higherDefenseReduction > baselineReduction, '防御提升后减伤应同步提升');
  assert.ok(higherDefenseReduction < 0.5, `减伤不应接近免伤，当前=${higherDefenseReduction}`);
  assertClose(higherDefenseReduction, expected, '高防场景公式偏差');
});

test('同一防御下最终伤害应按固定倍率线性缩放', () => {
  const attacker = createUnit('attacker-4', {
    mingzhong: 1,
    baoji: 0,
    wugong: 260,
  });
  const defender = createUnit('defender-4', {
    shanbi: 0,
    zhaojia: 0,
    kangbao: 0,
    wufang: 180,
  });
  const state = createState(attacker, defender);
  const damageRate = 1 - expectedDefenseReduction(180);

  const lowDamageResult = calculateDamage(state, attacker, defender, {
    damageType: 'physical',
    element: 'none',
    baseDamage: 180,
  });
  const highDamageResult = calculateDamage(state, attacker, defender, {
    damageType: 'physical',
    element: 'none',
    baseDamage: 260,
  });

  assert.equal(lowDamageResult.damage, Math.floor(180 * damageRate));
  assert.equal(highDamageResult.damage, Math.floor(260 * damageRate));
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

  const magicReduction = calculateDefenseReductionRate(defender, 'magic');
  const physicalReduction = calculateDefenseReductionRate(defender, 'physical');
  const expectedMagicReduction = expectedDefenseReduction(100);
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

test('暴伤减免应降低暴击后的最终倍率，且最低不会低于1倍', () => {
  const attacker = createUnit('attacker-8', {
    mingzhong: 1,
    baoji: 1,
    baoshang: 2.1,
    wugong: 200,
  });
  const defender = createUnit('defender-8', {
    shanbi: 0,
    zhaojia: 0,
    kangbao: 0,
    jianbaoshang: 0.4,
    wufang: 0,
  });
  const state = createState(attacker, defender);

  const result = calculateDamage(state, attacker, defender, {
    damageType: 'physical',
    element: 'none',
    baseDamage: 200,
  });

  assert.equal(result.isCrit, true);
  assert.equal(result.damage, 293);
});

test('暴伤减免高于暴伤收益时，暴击伤害应被钳制为1倍', () => {
  const attacker = createUnit('attacker-9', {
    mingzhong: 1,
    baoji: 1,
    baoshang: 1.3,
    wugong: 200,
  });
  const defender = createUnit('defender-9', {
    shanbi: 0,
    zhaojia: 0,
    kangbao: 0,
    jianbaoshang: 0.8,
    wufang: 0,
  });
  const state = createState(attacker, defender);

  const result = calculateDamage(state, attacker, defender, {
    damageType: 'physical',
    element: 'none',
    baseDamage: 200,
  });

  assert.equal(result.isCrit, true);
  assert.equal(result.damage, 200);
});

test('怪物暴伤高于 300% 时，最终暴击倍率应按 300% 上限结算', () => {
  const attacker = createUnit(
    'monster-attacker-10',
    {
      mingzhong: 1,
      baoji: 1,
      baoshang: 3.6,
      wugong: 200,
    },
    'monster',
  );
  const defender = createUnit('defender-10', {
    shanbi: 0,
    zhaojia: 0,
    kangbao: 0,
    wufang: 0,
  });
  const state = createState(attacker, defender);

  const result = calculateDamage(state, attacker, defender, {
    damageType: 'physical',
    element: 'none',
    baseDamage: 200,
  });

  assert.equal(result.isCrit, true);
  assert.equal(result.damage, 600);
});

test('玩家暴伤高于 300% 时，不应被怪物专属上限误钳制', () => {
  const attacker = createUnit('attacker-11', {
    mingzhong: 1,
    baoji: 1,
    baoshang: 3.6,
    wugong: 200,
  });
  const defender = createUnit('defender-11', {
    shanbi: 0,
    zhaojia: 0,
    kangbao: 0,
    wufang: 0,
  });
  const state = createState(attacker, defender);

  const result = calculateDamage(state, attacker, defender, {
    damageType: 'physical',
    element: 'none',
    baseDamage: 200,
  });

  assert.equal(result.isCrit, true);
  assert.equal(result.damage, 720);
});
