import type { SkillEffect } from '../battle/types.js';

/**
 * 光环语义归一化共享模块
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：把光环外层 `type/buffKey` 与 `auraEffects` 子效果整体语义的判定收敛到单一入口，供战斗运行时归一化与数据库巡检脚本复用。
 * 2. 做什么：统一识别“整体应为增益光环”与“整体应为减益光环”的纯语义场景，避免各处各自写一套 buff/debuff 统计规则。
 * 3. 不做什么：不读写数据库，不直接执行战斗结算，也不替调用方决定是否落库修复。
 *
 * 输入 / 输出：
 * - 输入：单个 aura effect，或其 `auraEffects` 子效果数组。
 * - 输出：语义统计、预期宿主类型，以及可直接回写的标准化 aura 宿主 effect。
 *
 * 数据流 / 状态流：
 * `generated_skill_def.effects[*]` / battle `SkillEffect`
 * -> 本模块判定整体语义
 * -> 运行时决定旧数据如何归一化，或脚本决定是否需要修复持久化数据。
 *
 * 复用设计说明：
 * - 这里承载的是“光环整体语义”这一条高频变化规则；战斗模块与数据库脚本都依赖它，如果继续散落判断，后续再修规则时一定会出现前后口径分裂。
 * - 输出尽量保持结构化，既能支持只读审计，也能支持实际修复，不需要每个消费端再次解析文本或数值方向。
 *
 * 关键边界条件与坑点：
 * 1. 只在“整体纯正向”或“整体纯负向”时返回预期宿主类型；一旦正负子效果混搭，必须返回 `null`，不能擅自替调用方判定。
 * 2. `damage` 与负数 `resource` 一律按负向语义处理，`heal/restore_lingqi` 与正数 `resource` 一律按正向语义处理，避免持续伤害/减资源被误归到增益侧。
 */

export type AuraHostEffectType = 'buff' | 'debuff';
export type AuraHostMismatchKind = 'should_be_buff_aura' | 'should_be_debuff_aura';

export type AuraHostSemanticValidationResult =
  | { success: true }
  | { success: false; reason: string };

export type AuraSemanticSummary = {
  buffCount: number;
  debuffCount: number;
  healCount: number;
  restoreLingqiCount: number;
  positiveResourceCount: number;
  negativeResourceCount: number;
  damageCount: number;
  positiveCount: number;
  negativeCount: number;
};

const EMPTY_AURA_SEMANTIC_SUMMARY: AuraSemanticSummary = {
  buffCount: 0,
  debuffCount: 0,
  healCount: 0,
  restoreLingqiCount: 0,
  positiveResourceCount: 0,
  negativeResourceCount: 0,
  damageCount: 0,
  positiveCount: 0,
  negativeCount: 0,
};

const toFiniteNumber = (value: number | undefined): number => {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
};

const isAuraEffect = (effect: SkillEffect): boolean => {
  return (effect.type === 'buff' || effect.type === 'debuff') && effect.buffKind === 'aura';
};

export function summarizeAuraSubEffectSemantics(subEffects: SkillEffect[] | undefined): AuraSemanticSummary {
  if (!Array.isArray(subEffects) || subEffects.length <= 0) {
    return { ...EMPTY_AURA_SEMANTIC_SUMMARY };
  }

  const summary: AuraSemanticSummary = { ...EMPTY_AURA_SEMANTIC_SUMMARY };
  for (const sub of subEffects) {
    if (sub.type === 'buff') {
      summary.buffCount += 1;
      summary.positiveCount += 1;
      continue;
    }
    if (sub.type === 'debuff') {
      summary.debuffCount += 1;
      summary.negativeCount += 1;
      continue;
    }
    if (sub.type === 'heal') {
      summary.healCount += 1;
      summary.positiveCount += 1;
      continue;
    }
    if (sub.type === 'restore_lingqi') {
      summary.restoreLingqiCount += 1;
      summary.positiveCount += 1;
      continue;
    }
    if (sub.type === 'damage') {
      summary.damageCount += 1;
      summary.negativeCount += 1;
      continue;
    }
    if (sub.type === 'resource') {
      const value = toFiniteNumber(sub.value);
      if (value > 0) {
        summary.positiveResourceCount += 1;
        summary.positiveCount += 1;
      } else if (value < 0) {
        summary.negativeResourceCount += 1;
        summary.negativeCount += 1;
      }
    }
  }

  return summary;
}

export function resolveExpectedAuraHostType(
  effect: Pick<SkillEffect, 'auraEffects'>,
): AuraHostEffectType | null {
  const summary = summarizeAuraSubEffectSemantics(effect.auraEffects);
  if (summary.positiveCount > 0 && summary.negativeCount === 0) {
    return 'buff';
  }
  if (summary.negativeCount > 0 && summary.positiveCount === 0) {
    return 'debuff';
  }
  return null;
}

export function resolveCanonicalAuraHostBuffKey(type: AuraHostEffectType): 'buff-aura' | 'debuff-aura' {
  return type === 'buff' ? 'buff-aura' : 'debuff-aura';
}

export function resolveAuraHostMismatchKind(
  effect: SkillEffect,
): AuraHostMismatchKind | null {
  if (!isAuraEffect(effect)) return null;
  const expectedType = resolveExpectedAuraHostType(effect);
  if (!expectedType) return null;

  const expectedBuffKey = resolveCanonicalAuraHostBuffKey(expectedType);
  if (effect.type === expectedType && effect.buffKey === expectedBuffKey) {
    return null;
  }
  return expectedType === 'buff' ? 'should_be_buff_aura' : 'should_be_debuff_aura';
}

export function normalizeAuraHostEffect(effect: SkillEffect): SkillEffect {
  if (!isAuraEffect(effect)) return effect;
  const expectedType = resolveExpectedAuraHostType(effect);
  if (!expectedType) return effect;

  const expectedBuffKey = resolveCanonicalAuraHostBuffKey(expectedType);
  if (effect.type === expectedType && effect.buffKey === expectedBuffKey) {
    return effect;
  }

  return {
    ...effect,
    type: expectedType,
    buffKey: expectedBuffKey,
  };
}

export function validateAuraHostEffectSemantics(
  effect: Pick<SkillEffect, 'type' | 'buffKey' | 'auraEffects'>,
): AuraHostSemanticValidationResult {
  const summary = summarizeAuraSubEffectSemantics(effect.auraEffects);

  if (summary.positiveCount > 0 && summary.negativeCount > 0) {
    return {
      success: false,
      reason: 'auraEffects 不能混合正向和负向子效果；同一光环会把所有子效果施加到同一个 auraTarget，若要伤敌并治疗自身，请拆成多个顶层 aura effect',
    };
  }

  const expectedType = resolveExpectedAuraHostType(effect);
  if (!expectedType) {
    return {
      success: false,
      reason: 'auraEffects 必须至少包含一个明确正向或负向的可结算子效果',
    };
  }

  const expectedBuffKey = resolveCanonicalAuraHostBuffKey(expectedType);
  if (effect.type !== expectedType || effect.buffKey !== expectedBuffKey) {
    return {
      success: false,
      reason: `光环外层必须匹配子效果语义：当前应使用 type=${expectedType} + buffKey=${expectedBuffKey}`,
    };
  }

  return { success: true };
}
