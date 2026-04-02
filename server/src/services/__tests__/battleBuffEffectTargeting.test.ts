/**
 * 技能 Buff 显式目标回归测试
 *
 * 作用（做什么 / 不做什么）：
 * 1) 做什么：验证 buff/debuff effect 支持显式指定目标，且缺省目标会按效果类型自动推断，并保证 action 日志落到真实受术单位。
 * 2) 做什么：锁定群攻技能给自身上 Buff 时只结算一次，避免按命中人数重复叠层。
 * 3) 不做什么：不覆盖资源效果、光环子效果或装备词条目标语义，只聚焦主动技能的 buff/debuff 结算。
 *
 * 输入 / 输出：
 * - 输入：BattleState、BattleSkill 与执行后的 battle log。
 * - 输出：单位 Buff 列表变化，以及 action 日志中的 targets 落点。
 *
 * 数据流 / 状态流：
 * - 测试技能定义 -> `executeSkill`
 * - `skill.ts` 解析 effect.target -> 真实受术单位
 * - 断言 Buff 结算结果与日志目标一致。
 *
 * 复用设计说明：
 * - 统一复用 `battleTestUtils` 构建单位、战斗态与日志读取，避免每个回归用例重复拼装基础结构。
 * - 这里直接命中 battle 执行唯一入口，后续若再扩展 effect.target 语义，只需继续在这一组回归上补例即可。
 *
 * 关键边界条件与坑点：
 * 1) 老技能未填写 `effect.target` 时，Buff 应默认施加给施法者自身，Debuff 应默认命中敌方目标。
 * 2) 群攻 + `target=self` 或缺省自增益若按“每个命中目标都触发一次”处理，会导致自增益重复叠加，这是本组测试要防住的核心回归点。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { executeSkill } from '../../battle/modules/skill.js';
import type { BattleSkill } from '../../battle/types.js';
import { asActionLog, consumeBattleLogs, createState, createUnit } from './battleTestUtils.js';

const createAttackBuffSkill = (
  targetType: BattleSkill['targetType'],
  buffTarget?: 'self' | 'target',
): BattleSkill => {
  return {
    id: `skill-buff-target-${targetType}-${buffTarget ?? 'default'}`,
    name: '裂空战诀',
    source: 'technique',
    sourceId: 'tech-buff-target',
    cost: {},
    cooldown: 0,
    targetType,
    targetCount: targetType === 'all_enemy' ? 2 : 1,
    damageType: 'physical',
    element: 'jin',
    effects: [
      {
        type: 'damage',
        valueType: 'flat',
        value: 120,
      },
      {
        type: 'buff',
        target: buffTarget,
        buffKind: 'attr',
        buffKey: 'buff-zengshang-up',
        attrKey: 'zengshang',
        applyType: 'percent',
        value: 0.15,
        duration: 2,
      },
    ],
    triggerType: 'active',
    aiPriority: 80,
  };
};

const createAttackDebuffSkill = (
  targetType: BattleSkill['targetType'],
  debuffTarget?: 'enemy' | 'target',
): BattleSkill => {
  return {
    id: `skill-debuff-target-${targetType}-${debuffTarget ?? 'default'}`,
    name: '玄阴蚀脉',
    source: 'technique',
    sourceId: 'tech-debuff-target',
    cost: {},
    cooldown: 0,
    targetType,
    targetCount: targetType === 'all_enemy' ? 2 : 1,
    damageType: 'magic',
    element: 'shui',
    effects: [
      {
        type: 'damage',
        valueType: 'flat',
        value: 90,
      },
      {
        type: 'debuff',
        target: debuffTarget,
        buffKind: 'attr',
        buffKey: 'debuff-wufang-down',
        attrKey: 'wufang',
        applyType: 'percent',
        value: 0.2,
        duration: 2,
      },
    ],
    triggerType: 'active',
    aiPriority: 80,
  };
};

test('攻击技能可在命中敌方后给施法者自身施加 Buff', () => {
  const caster = createUnit({ id: 'player-1', name: '剑修甲' });
  const enemy = createUnit({ id: 'monster-1', name: '木桩妖', type: 'monster' });
  const state = createState({ attacker: [caster], defender: [enemy] });
  const skill = createAttackBuffSkill('single_enemy', 'self');

  const result = executeSkill(state, caster, skill);
  assert.equal(result.success, true);
  assert.equal(caster.buffs.length, 1);
  assert.equal(enemy.buffs.length, 0);

  const actionLog = asActionLog(consumeBattleLogs(state)[0]);
  assert.equal(actionLog.targets[0]?.targetId, enemy.id);
  assert.equal(actionLog.targets[0]?.damage, 120);
  assert.deepEqual(actionLog.targets[1]?.buffsApplied, ['buff-zengshang']);
  assert.equal(actionLog.targets[1]?.targetId, caster.id);
});

test('老技能未填写 Buff 目标时默认施加给施法者自身', () => {
  const caster = createUnit({ id: 'player-2', name: '枪修甲' });
  const enemy = createUnit({ id: 'monster-2', name: '木桩妖', type: 'monster' });
  const state = createState({ attacker: [caster], defender: [enemy] });
  const skill = createAttackBuffSkill('single_enemy');

  const result = executeSkill(state, caster, skill);
  assert.equal(result.success, true);
  assert.equal(caster.buffs.length, 1);
  assert.equal(enemy.buffs.length, 0);

  const actionLog = asActionLog(consumeBattleLogs(state)[0]);
  assert.equal(actionLog.targets.length, 2);
  assert.equal(actionLog.targets[0]?.targetId, enemy.id);
  assert.equal(actionLog.targets[0]?.damage, 120);
  assert.equal(actionLog.targets[1]?.targetId, caster.id);
  assert.deepEqual(actionLog.targets[1]?.buffsApplied, ['buff-zengshang']);
});

test('老技能未填写 Debuff 目标时默认命中敌方目标', () => {
  const caster = createUnit({ id: 'player-4', name: '法修甲' });
  const enemy = createUnit({ id: 'monster-5', name: '木桩丙', type: 'monster' });
  const state = createState({ attacker: [caster], defender: [enemy] });
  const skill = createAttackDebuffSkill('single_enemy');

  const result = executeSkill(state, caster, skill);
  assert.equal(result.success, true);
  assert.equal(caster.buffs.length, 0);
  assert.equal(enemy.buffs.length, 1);

  const actionLog = asActionLog(consumeBattleLogs(state)[0]);
  assert.equal(actionLog.targets.length, 1);
  assert.equal(actionLog.targets[0]?.targetId, enemy.id);
  assert.equal(actionLog.targets[0]?.damage, 90);
  assert.deepEqual(actionLog.targets[0]?.buffsApplied, ['debuff-wufang']);
});

test('群攻技能缺省自增益时整次施法只应结算一次', () => {
  const caster = createUnit({ id: 'player-3', name: '刀修甲' });
  const enemyA = createUnit({ id: 'monster-3', name: '木桩甲', type: 'monster' });
  const enemyB = createUnit({ id: 'monster-4', name: '木桩乙', type: 'monster' });
  const state = createState({ attacker: [caster], defender: [enemyA, enemyB] });
  const skill = createAttackBuffSkill('all_enemy');

  const result = executeSkill(state, caster, skill);
  assert.equal(result.success, true);
  assert.equal(caster.buffs.length, 1);
  assert.equal(enemyA.buffs.length, 0);
  assert.equal(enemyB.buffs.length, 0);

  const actionLog = asActionLog(consumeBattleLogs(state)[0]);
  const selfResults = actionLog.targets.filter((entry) => entry.targetId === caster.id);
  assert.equal(selfResults.length, 1);
  assert.deepEqual(selfResults[0]?.buffsApplied, ['buff-zengshang']);
});
