/**
 * AI 功法技能机制共享规格测试
 *
 * 作用（做什么 / 不做什么）：
 * 1) 做什么：验证 AI 生成功法的 effect/upgrade 共享校验已覆盖 control、resource、mark 等新增技能机制。
 * 2) 不做什么：不调用外部模型、不走数据库落库，也不测试完整生成功法任务状态流。
 *
 * 输入/输出：
 * - 输入：单个 SkillEffect，与单个 upgrades 项对象。
 * - 输出：共享校验函数的成功/失败结果。
 *
 * 数据流/状态流：
 * 新技能机制样例 -> techniqueSkillGenerationSpec 校验入口 -> service/constraints 共同复用。
 *
 * 关键边界条件与坑点：
 * 1) 必须同时覆盖基础 effects 与 upgrades.addEffect/effects，避免只同步一半链路。
 * 2) 失败断言要尽量锁定具体原因，防止未来把严格校验又放松成“只看 type 名称”。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import type { SkillEffect } from '../../battle/types.js';
import {
  TECHNIQUE_UPGRADE_DAMAGE_EFFECT_MAX_TOTAL_SCALE_RATE,
  validateTechniqueSkillEffect,
  validateTechniqueSkillEffectList,
  validateTechniqueSkillTargetCount,
  validateTechniqueSkillUpgrade,
} from '../shared/techniqueSkillGenerationSpec.js';

test('resource 效果应支持 ally 灵气回复机制', () => {
  const validation = validateTechniqueSkillEffect({
    type: 'resource',
    resourceType: 'lingqi',
    target: 'ally',
    value: 35,
  });

  assert.deepEqual(validation, { success: true });
});

test('buff 效果应支持显式指定自身为施加目标', () => {
  const validation = validateTechniqueSkillEffect({
    type: 'buff',
    target: 'self',
    buffKind: 'attr',
    buffKey: 'buff-zengshang-up',
    attrKey: 'zengshang',
    applyType: 'percent',
    value: 0.2,
    duration: 2,
  });

  assert.deepEqual(validation, { success: true });
});

test('heal 效果应支持显式指定自身为治疗目标', () => {
  const validation = validateTechniqueSkillEffect({
    type: 'heal',
    target: 'self',
    valueType: 'scale',
    scaleAttr: 'fagong',
    scaleRate: 0.8,
  });

  assert.deepEqual(validation, { success: true });
});

test('momentum 效果应支持 gain 势机制', () => {
  const validation = validateTechniqueSkillEffect({
    type: 'momentum',
    momentumId: 'battle_momentum',
    operation: 'gain',
    gainStacks: 1,
    maxStacks: 5,
  });

  assert.deepEqual(validation, { success: true });
});

test('mark:consume 效果应支持引爆印记机制', () => {
  const effect: SkillEffect = {
    type: 'mark',
    markId: 'void_erosion',
    operation: 'consume',
    consumeMode: 'all',
    resultType: 'damage',
    valueType: 'scale',
    scaleAttr: 'fagong',
    scaleRate: 0.9,
    perStackRate: 0.3,
  };

  assert.deepEqual(validateTechniqueSkillEffect(effect), { success: true });
});

test('damage 效果应支持使用主战属性作为倍率来源', () => {
  const validation = validateTechniqueSkillEffect({
    type: 'damage',
    valueType: 'scale',
    scaleAttr: 'wugong',
    scaleRate: 1.2,
    damageType: 'physical',
  });

  assert.deepEqual(validation, { success: true });
});

test('基础 damage 效果允许高连击与高总倍率组合', () => {
  const validation = validateTechniqueSkillEffect({
    type: 'damage',
    valueType: 'scale',
    scaleAttr: 'fagong',
    scaleRate: 1.68,
    damageType: 'magic',
    element: 'huo',
    hit_count: 6,
  });

  assert.deepEqual(validation, { success: true });
});

test('非法 controlType 应被共享校验拦截', () => {
  const validation = validateTechniqueSkillEffect({
    type: 'control',
    controlType: 'banish',
    chance: 0.25,
    duration: 1,
  });

  assert.deepEqual(validation, { success: false, reason: 'controlType 不在允许枚举中' });
});

test('升级项应支持 addEffect 追加控制效果', () => {
  const validation = validateTechniqueSkillUpgrade(
    {
      layer: 5,
      changes: {
        addEffect: {
          type: 'control',
          controlType: 'stun',
          chance: 0.2,
          duration: 1,
        },
      },
    },
    9,
    'random_enemy',
  );

  assert.deepEqual(validation, { success: true });
});

test('升级项的 changes.effects 不应放行超预算总伤害倍率', () => {
  const validation = validateTechniqueSkillUpgrade(
    {
      layer: 5,
      changes: {
        effects: [
          {
            type: 'damage',
            valueType: 'scale',
            scaleAttr: 'fagong',
            scaleRate: 1.68,
            damageType: 'magic',
            element: 'huo',
            hit_count: 6,
          },
        ],
      },
    },
    9,
    'all_enemy',
  );

  assert.deepEqual(validation, {
    success: false,
    reason: `upgrades.changes.effects.scaleRate × hit_count 不能大于 ${TECHNIQUE_UPGRADE_DAMAGE_EFFECT_MAX_TOTAL_SCALE_RATE}`,
  });
});

test('升级项的 addEffect 不应放行超预算总伤害倍率', () => {
  const validation = validateTechniqueSkillUpgrade(
    {
      layer: 5,
      changes: {
        addEffect: {
          type: 'damage',
          valueType: 'scale',
          scaleAttr: 'wugong',
          scaleRate: 1.3,
          damageType: 'physical',
          hit_count: 2,
        },
      },
    },
    9,
    'random_enemy',
  );

  assert.deepEqual(validation, {
    success: false,
    reason: `upgrades.changes.addEffect.scaleRate × hit_count 不能大于 ${TECHNIQUE_UPGRADE_DAMAGE_EFFECT_MAX_TOTAL_SCALE_RATE}`,
  });
});

test('光环中的进攻类百分比增益总和即使较高也不应被程序硬拦截', () => {
  const validation = validateTechniqueSkillEffect(
    {
      type: 'buff',
      buffKind: 'aura',
      buffKey: 'buff-aura',
      auraTarget: 'self',
      auraEffects: [
        {
          type: 'buff',
          buffKind: 'attr',
          buffKey: 'buff-fagong-up',
          attrKey: 'fagong',
          applyType: 'percent',
          value: 0.3,
        },
        {
          type: 'buff',
          buffKind: 'attr',
          buffKey: 'buff-zengshang-up',
          attrKey: 'zengshang',
          applyType: 'percent',
          value: 0.2,
        },
      ],
    },
    { quality: '玄' },
  );

  assert.deepEqual(validation, { success: true });
});

test('光环中的进攻类百分比增益总和在预算内时应允许通过', () => {
  const validation = validateTechniqueSkillEffect(
    {
      type: 'buff',
      buffKind: 'aura',
      buffKey: 'buff-aura',
      auraTarget: 'self',
      auraEffects: [
        {
          type: 'buff',
          buffKind: 'attr',
          buffKey: 'buff-fagong-up',
          attrKey: 'fagong',
          applyType: 'percent',
          value: 0.05,
        },
        {
          type: 'buff',
          buffKind: 'attr',
          buffKey: 'buff-zengshang-up',
          attrKey: 'zengshang',
          applyType: 'percent',
          value: 0.05,
        },
      ],
    },
    { quality: '玄' },
  );

  assert.deepEqual(validation, { success: true });
});

test('光环子效果不应再声明 duration', () => {
  const validation = validateTechniqueSkillEffect({
    type: 'buff',
    buffKind: 'aura',
    buffKey: 'buff-aura',
    auraTarget: 'self',
    auraEffects: [
      {
        type: 'buff',
        buffKind: 'attr',
        buffKey: 'buff-shanbi-up',
        attrKey: 'shanbi',
        applyType: 'percent',
        value: 0.2,
        duration: 2,
      },
    ],
  });

  assert.deepEqual(validation, {
    success: false,
    reason: 'auraEffects 子效果不允许声明 duration，光环效果持续时间由宿主光环统一决定',
  });
});

test('光环子效果不应允许 next_skill_bonus', () => {
  const validation = validateTechniqueSkillEffect({
    type: 'buff',
    buffKind: 'aura',
    buffKey: 'buff-aura',
    auraTarget: 'self',
    auraEffects: [
      {
        type: 'buff',
        buffKind: 'next_skill_bonus',
        buffKey: 'buff-next-skill-chaos',
        value: 0.5,
        bonusType: 'damage',
      },
    ],
  });

  assert.deepEqual(validation, {
    success: false,
    reason: 'auraEffects 子效果不允许使用 buffKind=next_skill_bonus',
  });
});

test('同一光环不应混合伤害敌人与治疗自身这类跨目标语义', () => {
  const validation = validateTechniqueSkillEffect({
    type: 'buff',
    buffKind: 'aura',
    buffKey: 'buff-aura',
    auraTarget: 'all_enemy',
    auraEffects: [
      {
        type: 'damage',
        valueType: 'scale',
        scaleAttr: 'max_qixue',
        scaleRate: 0.35,
        damageType: 'true',
      },
      {
        type: 'heal',
        valueType: 'scale',
        scaleAttr: 'max_qixue',
        scaleRate: 0.25,
      },
    ],
  });

  assert.deepEqual(validation, {
    success: false,
    reason: 'auraEffects 不能混合正向和负向子效果；同一光环会把所有子效果施加到同一个 auraTarget，若要伤敌并治疗自身，请拆成多个顶层 aura effect',
  });
});

test('负向光环外层不应伪装成增益光环', () => {
  const validation = validateTechniqueSkillEffect({
    type: 'buff',
    buffKind: 'aura',
    buffKey: 'buff-aura',
    auraTarget: 'all_enemy',
    auraEffects: [
      {
        type: 'damage',
        valueType: 'scale',
        scaleAttr: 'max_qixue',
        scaleRate: 0.2,
        damageType: 'true',
      },
    ],
  });

  assert.deepEqual(validation, {
    success: false,
    reason: '光环外层必须匹配子效果语义：当前应使用 type=debuff + buffKey=debuff-aura',
  });
});

test('伤敌并治疗自身应拆成两个顶层光环 effect', () => {
  const validation = validateTechniqueSkillEffectList(
    [
      {
        type: 'debuff',
        buffKind: 'aura',
        buffKey: 'debuff-aura',
        auraTarget: 'all_enemy',
        auraEffects: [
          {
            type: 'damage',
            valueType: 'scale',
            scaleAttr: 'max_qixue',
            scaleRate: 0.2,
            damageType: 'true',
          },
        ],
      },
      {
        type: 'buff',
        buffKind: 'aura',
        buffKey: 'buff-aura',
        auraTarget: 'self',
        auraEffects: [
          {
            type: 'heal',
            valueType: 'scale',
            scaleAttr: 'max_qixue',
            scaleRate: 0.15,
          },
        ],
      },
    ],
    'skill.effects',
  );

  assert.deepEqual(validation, { success: true });
});

test('升级项中的旧式 effectChanges 字段应被拒绝', () => {
  const validation = validateTechniqueSkillUpgrade(
    {
      layer: 3,
      effectChanges: [
        {
          effectIndex: 0,
          scaleRate: 1.8,
        },
      ],
      changes: {
        cooldown: -1,
      },
    },
    9,
    'single_enemy',
  );

  assert.deepEqual(validation, { success: false, reason: 'upgrades 不支持字段 effectChanges' });
});

test('single_enemy 不应允许 targetCount 大于 1', () => {
  const validation = validateTechniqueSkillTargetCount('single_enemy', 2, 'targetCount');

  assert.deepEqual(validation, {
    success: false,
    reason: 'targetCount 仅允许 random_enemy/random_ally 在 > 1 时使用，当前 targetType=single_enemy',
  });
});

test('single_enemy 升级项不应把 target_count 提升到 1 以上', () => {
  const validation = validateTechniqueSkillUpgrade(
    {
      layer: 3,
      changes: {
        target_count: 2,
      },
    },
    9,
    'single_enemy',
  );

  assert.deepEqual(validation, {
    success: false,
    reason: 'upgrades.changes.target_count 仅允许 random_enemy/random_ally 在 > 1 时使用，当前 targetType=single_enemy',
  });
});

test('delayed_burst 效果应支持延迟爆发机制', () => {
  const validation = validateTechniqueSkillEffect({
    type: 'delayed_burst',
    duration: 2,
    valueType: 'scale',
    scaleAttr: 'fagong',
    scaleRate: 1.4,
    damageType: 'magic',
    element: 'huo',
  });

  assert.deepEqual(validation, { success: true });
});

test('fate_swap 效果应支持命运交换机制', () => {
  const validation = validateTechniqueSkillEffect({
    type: 'fate_swap',
    swapMode: 'debuff_to_target',
    count: 2,
  });

  assert.deepEqual(validation, { success: true });
});

test('heal_forbid 结构化 Buff 应被允许用于禁疗效果', () => {
  const validation = validateTechniqueSkillEffect({
    type: 'debuff',
    buffKind: 'heal_forbid',
    buffKey: 'debuff-heal-forbid',
    duration: 2,
  });

  assert.deepEqual(validation, { success: true });
});

test('next_skill_bonus 结构化 Buff 应支持下一次技能强化', () => {
  const validation = validateTechniqueSkillEffect({
    type: 'buff',
    buffKind: 'next_skill_bonus',
    buffKey: 'buff-next-skill-chaos',
    value: 0.5,
    duration: 1,
    bonusType: 'all',
  });

  assert.deepEqual(validation, { success: true });
});

test('扩充后的 markId 与 momentumId 应通过共享校验', () => {
  const markValidation = validateTechniqueSkillEffect({
    type: 'mark',
    markId: 'ember_brand',
    operation: 'apply',
    maxStacks: 5,
  });
  const momentumValidation = validateTechniqueSkillEffect({
    type: 'momentum',
    momentumId: 'blood_tide',
    operation: 'gain',
    gainStacks: 2,
    maxStacks: 6,
  });

  assert.deepEqual(markValidation, { success: true });
  assert.deepEqual(momentumValidation, { success: true });
});
