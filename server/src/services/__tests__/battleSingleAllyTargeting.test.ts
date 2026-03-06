/**
 * 单体友方技能目标回归测试
 *
 * 作用（做什么 / 不做什么）：
 * - 做什么：验证单体友方技能在显式指定队友时会命中该队友；验证传错目标时不会静默回退到自己或首个友方。
 * - 不做什么：不覆盖 AI 选目标策略，不验证前端点击逻辑，只锁定服务端目标校验与执行链路。
 *
 * 输入/输出：
 * - 输入：BattleState、BattleUnit、单体友方 BattleSkill、显式 targetIds。
 * - 输出：validateSkillUse 校验结果，以及 executeSkill 的成功/失败与治疗/Buff 落点。
 *
 * 数据流/状态流：
 * - 测试用例 -> validateSkillUse / executeSkill -> target.ts 解析单体友方目标 -> skill.ts 结算 heal/buff。
 * - 通过 battleTestUtils 统一创建单位与战斗状态，避免每个用例重复拼装基础字段。
 *
 * 关键边界条件与坑点：
 * 1) 传入的 targetIds 即便长度正确，只要不是存活友方，也必须拒绝，不能静默回退到 allies[0]。
 * 2) 同时包含治疗与增益的单体友方技能，必须把两类效果都施加到显式选中的队友身上，而不是施法者自身。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { executeSkill } from '../../battle/modules/skill.js';
import { validateSkillUse } from '../../battle/utils/validation.js';
import type { BattleSkill } from '../../battle/types.js';
import { createState, createUnit } from './battleTestUtils.js';

function createSingleAllySupportSkill(): BattleSkill {
  return {
    id: 'skill-support-single-ally',
    name: '回春护体诀',
    source: 'innate',
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
        value: 180,
      },
      {
        type: 'buff',
        value: 0.25,
        duration: 2,
        buffKind: 'attr',
        attrKey: 'wugong',
        applyType: 'percent',
      },
    ],
    triggerType: 'active',
    aiPriority: 60,
  };
}

test('单体友方技能传入敌方目标时应直接判定非法，避免静默回退到首个友方', () => {
  const caster = createUnit({ id: 'player-1', name: '施法者' });
  const ally = createUnit({ id: 'player-2', name: '队友' });
  const enemy = createUnit({ id: 'monster-1', name: '敌人', type: 'monster' });
  const skill = createSingleAllySupportSkill();
  caster.skills = [skill];
  caster.qixue = 600;

  const state = createState({
    attacker: [caster, ally],
    defender: [enemy],
  });

  const validation = validateSkillUse(state, caster, skill, [enemy.id]);
  assert.equal(validation.valid, false);
  assert.equal(validation.error, '目标不是有效的友方单位');

  const result = executeSkill(state, caster, skill, [enemy.id]);
  assert.equal(result.success, false);
  assert.equal(result.error, '没有有效目标');
  assert.equal(caster.qixue, 600, '无效目标不应让技能回退为治疗自己');
  assert.equal(caster.buffs.length, 0, '无效目标不应让技能回退为给自己加增益');
  assert.equal(ally.buffs.length, 0, '无效目标也不应误加到其他友方');
});

test('单体友方技能显式指定队友时，治疗与增益都应命中该队友', () => {
  const caster = createUnit({ id: 'player-1', name: '施法者' });
  const ally = createUnit({ id: 'player-2', name: '队友' });
  const enemy = createUnit({ id: 'monster-1', name: '敌人', type: 'monster' });
  const skill = createSingleAllySupportSkill();
  caster.skills = [skill];
  ally.qixue = 700;

  const state = createState({
    attacker: [caster, ally],
    defender: [enemy],
  });

  const validation = validateSkillUse(state, caster, skill, [ally.id]);
  assert.equal(validation.valid, true);

  const result = executeSkill(state, caster, skill, [ally.id]);
  assert.equal(result.success, true);

  const actionLog = state.logs[0];
  if (!actionLog || actionLog.type !== 'action') {
    assert.fail('期望产生 action 日志');
  }

  assert.equal(ally.qixue, 880, '治疗应命中被选中的队友');
  assert.equal(caster.qixue, caster.currentAttrs.max_qixue, '施法者自身不应被误治疗');
  assert.equal(ally.buffs.length, 1, '增益应命中被选中的队友');
  assert.equal(caster.buffs.length, 0, '施法者自身不应被误加增益');
  assert.equal(actionLog.targets[0]?.targetId, ally.id);
  assert.equal(actionLog.targets[0]?.heal, 180);
  assert.deepEqual(actionLog.targets[0]?.buffsApplied, ['buff-wugong']);
});
