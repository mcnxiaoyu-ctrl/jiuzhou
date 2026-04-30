/**
 * 混沌战斗机制测试
 *
 * 作用（做什么 / 不做什么）：
 * 1) 做什么：验证延迟爆发、禁疗、下一次技能强化与命运交换这几类夸张机制在战斗执行层可用。
 * 2) 不做什么：不覆盖完整 AI 选技与回放链路，也不验证前端展示。
 *
 * 输入/输出：
 * - 输入：BattleState、BattleUnit、BattleSkill，以及人工布置的 Buff / Shield 状态。
 * - 输出：技能执行结果、回合开始日志、Buff 迁移结果与最终伤害/治疗变化。
 *
 * 数据流/状态流：
 * 技能 effects[] -> skill.ts / buff.ts -> BattleUnit.buffs / shields / qixue -> 日志断言。
 *
 * 关键边界条件与坑点：
 * 1) 新机制必须走现有状态源，不能偷偷挂到测试私有字段上，否则 AI 生成链接不进去。
 * 2) “下一次技能强化”必须只生效一次；“命运交换”必须真的搬运状态，而不是只输出文案。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import type { ActiveBuff, BattleSkill } from '../../battle/types.js';
import { addShield, processRoundStartEffects } from '../../battle/modules/buff.js';
import { SOUL_SHACKLE_MARK_ID } from '../../battle/modules/mark.js';
import { executeSkill } from '../../battle/modules/skill.js';
import { asActionLog, createState, createUnit } from './battleTestUtils.js';

const createChaosBuff = (overrides: Partial<ActiveBuff>): ActiveBuff => ({
  id: `buff-${Math.random().toString(36).slice(2, 8)}`,
  buffDefId: `buff-${Math.random().toString(36).slice(2, 8)}`,
  name: '测试状态',
  type: 'debuff',
  category: 'chaos',
  sourceUnitId: 'source-1',
  remainingDuration: 2,
  stacks: 1,
  maxStacks: 1,
  tags: [],
  dispellable: true,
  ...overrides,
});

test('delayed_burst 应在回合开始触发延迟爆发伤害', () => {
  const caster = createUnit({ id: 'player-1', name: '火修' });
  const target = createUnit({ id: 'monster-1', name: '木桩妖', type: 'monster' });
  const state = createState({ attacker: [caster], defender: [target], round: 3 });

  const skill: BattleSkill = {
    id: 'skill-delayed-burst',
    name: '烬星伏脉',
    source: 'technique',
    sourceId: 'tech-chaos',
    cost: {},
    cooldown: 0,
    targetType: 'single_enemy',
    targetCount: 1,
    damageType: 'magic',
    element: 'huo',
    effects: [
      {
        type: 'delayed_burst',
        duration: 2,
        valueType: 'flat',
        value: 180,
        damageType: 'true',
        element: 'huo',
      },
    ],
    triggerType: 'active',
    aiPriority: 88,
  };

  const execution = executeSkill(state, caster, skill, [target.id]);
  assert.equal(execution.success, true);
  assert.equal(target.buffs.length, 1);

  const logsRound3 = processRoundStartEffects(state, target);
  assert.equal(logsRound3.length, 0);
  assert.equal(target.qixue, target.currentAttrs.max_qixue);

  state.roundCount = 4;
  const logsRound4 = processRoundStartEffects(state, target);
  assert.equal(logsRound4.length, 1);
  assert.equal(logsRound4[0]?.type, 'dot');
  assert.match(String(logsRound4[0]?.buffName ?? ''), /延迟爆发/);
  assert.ok(target.qixue < target.currentAttrs.max_qixue);
});

test('heal_forbid 应同时阻断直接治疗与 HOT 结算', () => {
  const caster = createUnit({ id: 'player-2', name: '毒修' });
  const ally = createUnit({ id: 'player-3', name: '伤者' });
  ally.qixue = 500;
  ally.buffs.push(
    createChaosBuff({
      id: 'debuff-heal-forbid',
      buffDefId: 'debuff-heal-forbid',
      name: '断脉绝生',
      type: 'debuff',
      healForbidden: true,
    }),
  );

  const state = createState({ attacker: [caster, ally], defender: [] });

  const healSkill: BattleSkill = {
    id: 'skill-heal',
    name: '回春诀',
    source: 'technique',
    sourceId: 'tech-heal',
    cost: {},
    cooldown: 0,
    targetType: 'single_ally',
    targetCount: 1,
    damageType: 'magic',
    element: 'mu',
    effects: [
      {
        type: 'heal',
        valueType: 'flat',
        value: 240,
      },
    ],
    triggerType: 'active',
    aiPriority: 40,
  };

  const healExecution = executeSkill(state, caster, healSkill, [ally.id]);
  assert.equal(healExecution.success, true);
  assert.equal(ally.qixue, 500);

  ally.buffs.push(
    createChaosBuff({
      id: 'buff-hot',
      buffDefId: 'buff-hot',
      name: '木灵温养',
      type: 'buff',
      hot: { heal: 100 },
      sourceUnitId: caster.id,
    }),
  );
  const hotLogs = processRoundStartEffects(state, ally);
  assert.equal(hotLogs.length, 0);
  assert.equal(ally.qixue, 500);
});

test('目标自身减疗属性不应压低其受到的治疗与 HOT', () => {
  const caster = createUnit({ id: 'player-healer', name: '医修' });
  const ally = createUnit({
    id: 'player-high-jianliao',
    name: '高减疗队友',
    attrs: { jianliao: 1.8 },
  });
  ally.qixue = 500;
  const state = createState({ attacker: [caster, ally], defender: [] });

  const healSkill: BattleSkill = {
    id: 'skill-heal-high-jianliao-ally',
    name: '回春诀',
    source: 'technique',
    sourceId: 'tech-heal',
    cost: {},
    cooldown: 0,
    targetType: 'single_ally',
    targetCount: 1,
    damageType: 'magic',
    element: 'mu',
    effects: [
      {
        type: 'heal',
        valueType: 'flat',
        value: 240,
      },
    ],
    triggerType: 'active',
    aiPriority: 40,
  };

  const healExecution = executeSkill(state, caster, healSkill, [ally.id]);
  assert.equal(healExecution.success, true);
  assert.equal(ally.qixue, 740);

  ally.buffs.push(
    createChaosBuff({
      id: 'buff-hot-high-jianliao-ally',
      buffDefId: 'buff-hot-high-jianliao-ally',
      name: '木灵温养',
      type: 'buff',
      hot: { heal: 100 },
      sourceUnitId: caster.id,
    }),
  );
  const logs = processRoundStartEffects(state, ally);
  assert.equal(logs.length, 1);
  assert.equal(logs[0]?.type, 'hot');
  assert.equal(ally.qixue, 840);
});

test('敌方减疗属性应以递减收益压制全体治疗且不叠加', () => {
  const caster = createUnit({ id: 'player-healer', name: '医修' });
  const ally = createUnit({ id: 'player-wounded', name: '伤者' });
  const primaryReducer = createUnit({
    id: 'enemy-high-jianliao',
    name: '玄脉血螭',
    attrs: { jianliao: 1.718 },
  });
  const secondaryReducer = createUnit({
    id: 'enemy-low-jianliao',
    name: '副减疗者',
    attrs: { jianliao: 0.2 },
  });
  ally.qixue = 0;
  const state = createState({
    attacker: [caster, ally],
    defender: [primaryReducer, secondaryReducer],
  });
  const reductionRate = 1.718 / (1.718 + 5);

  const healSkill: BattleSkill = {
    id: 'skill-heal-diminishing-jianliao',
    name: '回春诀',
    source: 'technique',
    sourceId: 'tech-heal',
    cost: {},
    cooldown: 0,
    targetType: 'single_ally',
    targetCount: 1,
    damageType: 'magic',
    element: 'mu',
    effects: [
      {
        type: 'heal',
        valueType: 'flat',
        value: 1000,
      },
    ],
    triggerType: 'active',
    aiPriority: 40,
  };

  const healExecution = executeSkill(state, caster, healSkill, [ally.id]);
  assert.equal(healExecution.success, true);
  assert.equal(ally.qixue, Math.floor(1000 * (1 - reductionRate)));

  ally.buffs.push(
    createChaosBuff({
      id: 'buff-hot-diminishing-jianliao',
      buffDefId: 'buff-hot-diminishing-jianliao',
      name: '木灵温养',
      type: 'buff',
      hot: { heal: 100 },
      sourceUnitId: caster.id,
    }),
  );
  const logs = processRoundStartEffects(state, ally);
  assert.equal(logs.length, 1);
  assert.equal(logs[0]?.type, 'hot');
  assert.equal(
    ally.qixue,
    Math.floor(1000 * (1 - reductionRate)) + Math.floor(100 * (1 - reductionRate)),
  );
});

test('蚀心锁应压低直接治疗与回灵效果', () => {
  const caster = createUnit({ id: 'player-6', name: '锁脉修士' });
  const ally = createUnit({ id: 'player-7', name: '伤者' });
  ally.qixue = 500;
  ally.lingqi = 0;
  ally.marks = [
    {
      id: SOUL_SHACKLE_MARK_ID,
      sourceUnitId: caster.id,
      stacks: 3,
      maxStacks: 5,
      remainingDuration: 2,
    },
  ];

  const state = createState({ attacker: [caster, ally], defender: [] });

  const healSkill: BattleSkill = {
    id: 'skill-heal-soul-shackle',
    name: '回春诀',
    source: 'technique',
    sourceId: 'tech-heal',
    cost: {},
    cooldown: 0,
    targetType: 'single_ally',
    targetCount: 1,
    damageType: 'magic',
    element: 'mu',
    effects: [
      {
        type: 'heal',
        valueType: 'flat',
        value: 200,
      },
    ],
    triggerType: 'active',
    aiPriority: 40,
  };

  const restoreSkill: BattleSkill = {
    id: 'skill-restore-soul-shackle',
    name: '聚灵诀',
    source: 'technique',
    sourceId: 'tech-restore',
    cost: {},
    cooldown: 0,
    targetType: 'single_ally',
    targetCount: 1,
    damageType: 'magic',
    element: 'shui',
    effects: [
      {
        type: 'restore_lingqi',
        value: 100,
      },
    ],
    triggerType: 'active',
    aiPriority: 30,
  };

  const healExecution = executeSkill(state, caster, healSkill, [ally.id]);
  assert.equal(healExecution.success, true);
  assert.equal(ally.qixue, 652);

  const restoreExecution = executeSkill(state, caster, restoreSkill, [ally.id]);
  assert.equal(restoreExecution.success, true);
  assert.equal(ally.lingqi, 76);
  const restoreLog = asActionLog(restoreExecution.log);
  assert.deepEqual(restoreLog.targets[0]?.resources, [{ type: 'lingqi', amount: 76 }]);
});

test('next_skill_bonus 应强化下一次技能并在施法后消耗', () => {
  const caster = createUnit({ id: 'player-4', name: '狂修' });
  const target = createUnit({ id: 'monster-2', name: '铁木人', type: 'monster' });
  const state = createState({ attacker: [caster], defender: [target] });

  const prepSkill: BattleSkill = {
    id: 'skill-next-bonus',
    name: '魔焰前兆',
    source: 'technique',
    sourceId: 'tech-chaos',
    cost: {},
    cooldown: 0,
    targetType: 'self',
    targetCount: 1,
    damageType: 'magic',
    element: 'huo',
    effects: [
      {
        type: 'buff',
        buffKind: 'next_skill_bonus',
        buffKey: 'buff-next-skill-chaos',
        duration: 1,
        value: 0.5,
        bonusType: 'damage',
      },
    ],
    triggerType: 'active',
    aiPriority: 60,
  };

  const strikeSkill: BattleSkill = {
    id: 'skill-chaos-strike',
    name: '坠日击',
    source: 'technique',
    sourceId: 'tech-chaos',
    cost: {},
    cooldown: 0,
    targetType: 'single_enemy',
    targetCount: 1,
    damageType: 'physical',
    element: 'none',
    effects: [
      {
        type: 'damage',
        valueType: 'flat',
        value: 100,
        damageType: 'true',
      },
    ],
    triggerType: 'active',
    aiPriority: 90,
  };

  assert.equal(executeSkill(state, caster, prepSkill).success, true);
  assert.equal(caster.buffs.length, 1);

  const strikeExecution = executeSkill(state, caster, strikeSkill, [target.id]);
  assert.equal(strikeExecution.success, true);
  const actionLog = asActionLog(strikeExecution.log);
  assert.equal(actionLog.targets[0]?.damage, 150);
  assert.equal(caster.buffs.length, 0);
});

test('fate_swap 应把施法者 debuff 转移给目标并夺取护盾', () => {
  const caster = createUnit({ id: 'player-5', name: '逆命修士' });
  const target = createUnit({ id: 'monster-3', name: '壁山魁', type: 'monster' });
  const state = createState({ attacker: [caster], defender: [target] });

  caster.buffs.push(
    createChaosBuff({
      id: 'debuff-burn',
      buffDefId: 'debuff-burn',
      name: '灼烧',
      type: 'debuff',
      dot: { damage: 60, damageType: 'magic', element: 'huo' },
      sourceUnitId: target.id,
    }),
  );
  addShield(target, {
    value: 200,
    maxValue: 200,
    duration: 2,
    absorbType: 'all',
    priority: 1,
    sourceSkillId: 'skill-target-shield',
  }, 'skill-target-shield');

  const skill: BattleSkill = {
    id: 'skill-fate-swap',
    name: '逆命换劫',
    source: 'technique',
    sourceId: 'tech-chaos',
    cost: {},
    cooldown: 0,
    targetType: 'single_enemy',
    targetCount: 1,
    damageType: 'magic',
    element: 'an',
    effects: [
      {
        type: 'fate_swap',
        swapMode: 'debuff_to_target',
        count: 1,
      },
      {
        type: 'fate_swap',
        swapMode: 'shield_steal',
        value: 0.5,
      },
    ],
    triggerType: 'active',
    aiPriority: 96,
  };

  const execution = executeSkill(state, caster, skill, [target.id]);
  assert.equal(execution.success, true);

  assert.equal(caster.buffs.some((buff) => buff.id === 'debuff-burn'), false);
  assert.equal(target.buffs.some((buff) => buff.id === 'debuff-burn'), true);
  assert.equal(caster.shields.length, 1);
  assert.equal(caster.shields[0]?.value, 100);
  assert.equal(target.shields[0]?.value, 100);

  const actionLog = asActionLog(execution.log);
  assert.ok((actionLog.targets[0]?.buffsRemoved ?? []).some((text) => text.includes('灼烧')));
  assert.ok((actionLog.targets[0]?.buffsApplied ?? []).some((text) => text.includes('夺取护盾')));
});
