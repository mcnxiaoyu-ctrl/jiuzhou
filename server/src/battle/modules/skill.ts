/**
 * 九州修仙录 - 技能执行模块
 */

import type { 
  BattleState, 
  BattleUnit, 
  BattleSkill, 
  SkillEffect,
  AttrModifier,
  DotEffect,
  HotEffect,
  ReflectDamageEffect,
  ActionLog,
  BattleLogEntry,
  TargetHitResult,
  TargetResult
} from '../types.js';
import { BATTLE_CONSTANTS } from '../types.js';
import { rollChance } from '../utils/random.js';
import { calculateDamage, applyDamage } from './damage.js';
import { applyHealing, applyLifesteal } from './healing.js';
import { addBuff, addShield, getUnitReflectDamageRate, removeBuff } from './buff.js';
import { tryApplyControl, canUseSkill, isSilenced, isDisarmed } from './control.js';
import { resolveTargets } from './target.js';
import { triggerSetBonusEffects } from './setBonus.js';
import { applyMarkStacks, consumeMarkStacks, resolveMarkEffectConfig } from './mark.js';
import {
  consumeMomentumStacks,
  gainMomentumStacks,
  resolveMomentumEffectConfig,
  type MomentumBonusType,
} from './momentum.js';
import { applyReactiveTrueDamage, calculateReactiveDamageByRate } from './reactiveDamage.js';
import { resolveSkillCostForResourceState } from '../../shared/skillCost.js';
import {
  applySkillCooldownAfterCast,
  getSkillCooldownBlockedMessage,
  getSkillCooldownRemainingRounds,
} from '../utils/cooldown.js';
import {
  DEFAULT_PERCENT_BUFF_ATTR_SET,
  normalizeBuffApplyType,
  normalizeBuffAttrKey,
  normalizeBuffKind,
  resolveBuffEffectKey,
  resolveSignedAttrValue,
} from '../utils/buffSpec.js';

interface SkillExecutionResult {
  success: boolean;
  log?: ActionLog;
  error?: string;
}

const resolveCasterSkillCost = (caster: BattleUnit, skill: BattleSkill) => {
  return resolveSkillCostForResourceState(skill.cost, {
    maxLingqi: caster.currentAttrs.max_lingqi,
    maxQixue: caster.currentAttrs.max_qixue,
  });
};

const PERCENT_BUFF_ATTR_SET = DEFAULT_PERCENT_BUFF_ATTR_SET;

type BuffRuntimeData = {
  attrModifiers?: AttrModifier[];
  dot?: DotEffect;
  hot?: HotEffect;
  reflectDamage?: ReflectDamageEffect;
};

type SkillExecutionContext = {
  momentumBonusRateByType: Record<'damage' | 'heal' | 'shield' | 'resource', number>;
  momentumGained: string[];
  momentumConsumed: string[];
};

type BuffOrDebuffEffect = SkillEffect & { type: 'buff' | 'debuff' };

function hasBuffRuntimeData(data: BuffRuntimeData): boolean {
  return Boolean(
    data.dot
    || data.hot
    || data.reflectDamage
    || (Array.isArray(data.attrModifiers) && data.attrModifiers.length > 0)
  );
}

function createSkillExecutionContext(): SkillExecutionContext {
  return {
    momentumBonusRateByType: {
      damage: 0,
      heal: 0,
      shield: 0,
      resource: 0,
    },
    momentumGained: [],
    momentumConsumed: [],
  };
}

function applyContextBonus(value: number, bonusRate: number): number {
  if (value === 0) return 0;
  if (bonusRate <= 0) return Math.floor(value);
  return Math.floor(value * (1 + bonusRate));
}

function addMomentumBonusToContext(
  context: SkillExecutionContext,
  bonusType: MomentumBonusType,
  bonusRate: number,
): void {
  if (bonusRate <= 0) return;
  if (bonusType === 'all') {
    context.momentumBonusRateByType.damage += bonusRate;
    context.momentumBonusRateByType.heal += bonusRate;
    context.momentumBonusRateByType.shield += bonusRate;
    context.momentumBonusRateByType.resource += bonusRate;
    return;
  }
  context.momentumBonusRateByType[bonusType] += bonusRate;
}

function toFiniteNumber(value: unknown, fallback = 0): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

/**
 * 解析灼烧额外伤害比例。
 *
 * 作用：
 * - 从技能效果数据中读取“目标最大气血附加比例伤害”，作为运行时 DOT 计算参数。
 *
 * 输入/输出：
 * - 输入：effect.bonusTargetMaxQixueRate（后端技能定义字段）
 * - 输出：>= 0 的比例值，非正数一律视为 0
 *
 * 数据流：
 * - 技能定义 effects[] -> SkillEffect -> 本函数 -> DotEffect.bonusTargetMaxQixueRate
 *
 * 边界条件与坑点：
 * 1) 非数值或空值会被归零，避免污染 DOT 结算。
 * 2) 本函数不做默认常量兜底，配置缺失即表示“无附加比例伤害”。
 */
function resolveBurnTargetMaxQixueRate(effect: SkillEffect): number {
  const rate = toFiniteNumber(effect.bonusTargetMaxQixueRate, 0);
  return rate > 0 ? rate : 0;
}

function resolveReflectDamageEffect(effect: SkillEffect): ReflectDamageEffect | null {
  const rate = toFiniteNumber(effect.value, 0);
  if (rate <= 0) return null;
  return { rate };
}

function getAttrValue(unit: BattleUnit, attrKey: string): number {
  const attrs = unit.currentAttrs as unknown as Record<string, unknown>;
  const value = attrs[attrKey];
  return toFiniteNumber(value, 0);
}

function resolveEffectValue(
  caster: BattleUnit,
  skill: BattleSkill,
  effect: SkillEffect,
  fallbackScaleAttr: string
): number {
  const value = toFiniteNumber(effect.value, 0);
  const scaleAttrRaw = typeof effect.scaleAttr === 'string' ? effect.scaleAttr.trim() : '';
  const scaleAttr = scaleAttrRaw || fallbackScaleAttr;
  if (!scaleAttr) return Math.floor(value);

  // 固定值 + 属性加成模式：baseValue + 属性值 * scaleRate
  if (effect.valueType === 'combined') {
    const baseValue = toFiniteNumber(effect.baseValue, 0);
    const rate = toFiniteNumber(effect.scaleRate, 0);
    return Math.floor(baseValue + getAttrValue(caster, scaleAttr) * rate);
  }

  if (effect.valueType === 'scale') {
    const rate = toFiniteNumber(effect.scaleRate, value);
    return Math.floor(getAttrValue(caster, scaleAttr) * rate);
  }

  if (scaleAttrRaw) {
    return Math.floor(getAttrValue(caster, scaleAttr) * value);
  }

  if (effect.valueType === 'percent') {
    return Math.floor(getAttrValue(caster, scaleAttr) * value);
  }

  if (effect.valueType === 'flat') {
    return Math.floor(value);
  }

  const defaultScaleAttr = skill.damageType === 'magic' ? 'fagong' : 'wugong';
  if (scaleAttr === defaultScaleAttr && value > 0 && value <= 1) {
    return Math.floor(getAttrValue(caster, scaleAttr) * value);
  }

  return Math.floor(value);
}

function buildBuffRuntimeData(
  caster: BattleUnit,
  target: BattleUnit,
  skill: BattleSkill,
  effect: BuffOrDebuffEffect
): BuffRuntimeData {
  const buffKind = normalizeBuffKind(effect.buffKind);
  if (!buffKind) return {};

  if (buffKind === 'dot') {
    const scaleAttr = skill.damageType === 'magic' ? 'fagong' : 'wugong';
    const dotDamage = Math.max(1, resolveEffectValue(caster, skill, effect, scaleAttr));
    const burnBonusRate = resolveBurnTargetMaxQixueRate(effect);
    return {
      dot: {
        damage: dotDamage,
        damageType: skill.damageType === 'magic' ? 'magic' : 'physical',
        element: skill.element || 'none',
        bonusTargetMaxQixueRate: burnBonusRate > 0 ? burnBonusRate : undefined,
      },
    };
  }

  if (buffKind === 'hot') {
    const heal = Math.max(1, resolveEffectValue(caster, skill, effect, 'fagong'));
    return { hot: { heal } };
  }

  if (buffKind === 'dodge_next') {
    const stacks = Math.max(1, Math.floor(toFiniteNumber(effect.stacks, 1)));
    return {
      attrModifiers: [{ attr: 'shanbi', value: 1 * stacks, mode: 'flat' }],
    };
  }

  if (buffKind === 'reflect_damage') {
    const reflectDamage = resolveReflectDamageEffect(effect);
    return reflectDamage ? { reflectDamage } : {};
  }

  if (buffKind !== 'attr') return {};
  const attr = normalizeBuffAttrKey(effect.attrKey);
  if (!attr) return {};
  const value = resolveSignedAttrValue(effect.type, effect.value);
  if (value === 0) return {};
  const mode: AttrModifier['mode'] =
    normalizeBuffApplyType(effect.applyType)
    ?? (PERCENT_BUFF_ATTR_SET.has(attr) ? 'percent' : 'flat');

  if (target.currentAttrs[attr as keyof typeof target.currentAttrs] == null) {
    return {};
  }

  return {
    attrModifiers: [{ attr, value, mode }],
  };
}

function isDirectDamageType(damageType: unknown): damageType is 'physical' | 'magic' | 'true' {
  return damageType === 'physical' || damageType === 'magic' || damageType === 'true';
}

function resolveEffectDamageType(skill: BattleSkill, effect: SkillEffect): 'physical' | 'magic' | 'true' | null {
  const raw = effect.damageType;
  if (isDirectDamageType(raw)) return raw;
  if (isDirectDamageType(skill.damageType)) return skill.damageType;
  return null;
}

function resolveEffectDamageElement(skill: BattleSkill, effect: SkillEffect): string {
  const raw = effect.element;
  return typeof raw === 'string' && raw.trim().length > 0 ? raw : (skill.element || 'none');
}

function resolveDamageHitCount(effect: SkillEffect): number {
  return Math.max(1, Math.floor(toFiniteNumber(effect.hit_count, 1)));
}

function resolveDamageBaseValue(
  caster: BattleUnit,
  target: BattleUnit,
  effect: SkillEffect,
  damageType: 'physical' | 'magic' | 'true'
): number {
  const value = toFiniteNumber(effect.value, 0);
  const valueType = effect.valueType || 'scale';

  if (valueType === 'flat') {
    return Math.max(0, Math.floor(value));
  }

  if (valueType === 'percent') {
    return Math.max(0, Math.floor(target.currentAttrs.max_qixue * value));
  }

  const fallbackScaleAttr = damageType === 'magic' ? 'fagong' : 'wugong';
  const scaleAttrRaw = typeof effect.scaleAttr === 'string' ? effect.scaleAttr.trim() : '';
  const scaleAttr = scaleAttrRaw || fallbackScaleAttr;
  const scaleRate = toFiniteNumber(effect.scaleRate, value);
  return Math.max(0, Math.floor(getAttrValue(caster, scaleAttr) * scaleRate));
}

type DamageExecutionSummary = {
  attempted: boolean;
  landed: boolean;
};

function executeDamageEffect(
  state: BattleState,
  caster: BattleUnit,
  target: BattleUnit,
  skill: BattleSkill,
  effect: SkillEffect,
  result: TargetResult,
  context: SkillExecutionContext,
): DamageExecutionSummary {
  const damageType = resolveEffectDamageType(skill, effect);
  if (!damageType) return { attempted: false, landed: false };

  const hitCount = resolveDamageHitCount(effect);
  const rawBaseDamage = resolveDamageBaseValue(caster, target, effect, damageType);
  const baseDamage = applyContextBonus(rawBaseDamage, context.momentumBonusRateByType.damage);
  if (baseDamage <= 0) return { attempted: false, landed: false };

  let attempted = false;
  let landed = false;

  for (let i = 0; i < hitCount; i++) {
    if (!target.isAlive) break;
    attempted = true;
    const hitIndex = result.hits.length + 1;

    const damageResult = calculateDamage(state, caster, target, {
      damageType,
      element: resolveEffectDamageElement(skill, effect),
      baseDamage,
    });
    if (damageResult.isMiss) {
      const missedHit: TargetHitResult = {
        index: hitIndex,
        damage: 0,
        isMiss: true,
        isCrit: false,
        isParry: false,
        isElementBonus: false,
        shieldAbsorbed: 0,
      };
      result.hits.push(missedHit);
      continue;
    }

    landed = true;
    const { actualDamage: damageApplied, shieldAbsorbed } = applyDamage(
      state, target, damageResult.damage, damageType
    );
    const actualDamage = Math.max(0, damageApplied);
    const landedHit: TargetHitResult = {
      index: hitIndex,
      damage: actualDamage,
      isMiss: false,
      isCrit: damageResult.isCrit,
      isParry: damageResult.isParry,
      isElementBonus: damageResult.isElementBonus,
      shieldAbsorbed,
    };
    result.hits.push(landedHit);

    result.damage = (result.damage || 0) + actualDamage;
    result.shieldAbsorbed = (result.shieldAbsorbed || 0) + shieldAbsorbed;
    result.isCrit = Boolean(result.isCrit || damageResult.isCrit);
    result.isParry = Boolean(result.isParry || damageResult.isParry);
    result.isElementBonus = Boolean(result.isElementBonus || damageResult.isElementBonus);

    caster.stats.damageDealt += actualDamage;
    if (actualDamage > 0) {
      applyLifesteal(caster, actualDamage);
    }

    if (!target.isAlive) {
      caster.stats.killCount++;
      state.logs.push({
        type: 'death',
        round: state.roundCount,
        unitId: target.id,
        unitName: target.name,
        killerId: caster.id,
        killerName: caster.name,
      });
    }

    const onHitLogs = triggerSetBonusEffects(state, 'on_hit', caster, {
      target,
      damage: actualDamage,
    });
    state.logs.push(...onHitLogs);
    const onBeHitLogs = triggerSetBonusEffects(state, 'on_be_hit', target, {
      target: caster,
      damage: actualDamage,
    });
    state.logs.push(...onBeHitLogs);
    if (damageResult.isCrit) {
      const onCritLogs = triggerSetBonusEffects(state, 'on_crit', caster, {
        target,
        damage: actualDamage,
      });
      state.logs.push(...onCritLogs);
    }

    const reflectLogs = buildReflectDamageLogs(state, target, caster, actualDamage);
    if (reflectLogs.length > 0) {
      state.logs.push(...reflectLogs);
    }
  }

  return { attempted, landed };
}

function buildReflectDamageLogs(
  state: BattleState,
  defender: BattleUnit,
  attacker: BattleUnit,
  actualDamage: number
): BattleLogEntry[] {
  if (actualDamage <= 0 || !attacker.isAlive) return [];

  const reflectRate = getUnitReflectDamageRate(defender);
  const reflectDamage = calculateReactiveDamageByRate(actualDamage, reflectRate);
  if (reflectDamage <= 0) return [];

  const applied = applyReactiveTrueDamage(state, defender, attacker, reflectDamage);
  if (!applied) return [];

  return [{
    type: 'action',
    round: state.roundCount,
    actorId: defender.id,
    actorName: defender.name,
    skillId: `proc-${defender.id}-reflect-damage`,
    skillName: '反弹伤害',
    targets: [{
      targetId: attacker.id,
      targetName: attacker.name,
      hits: [applied.hit],
      damage: applied.actualDamage,
      shieldAbsorbed: applied.shieldAbsorbed,
    }],
  }, ...applied.extraLogs];
}

function processMomentumEffectsByOperation(
  state: BattleState,
  caster: BattleUnit,
  skill: BattleSkill,
  context: SkillExecutionContext,
  operation: 'gain' | 'consume',
): void {
  for (const effect of skill.effects) {
    if (effect.type !== 'momentum') continue;
    const config = resolveMomentumEffectConfig({ ...effect });
    if (!config || config.operation !== operation) continue;
    if (typeof effect.chance === 'number' && !rollChance(state, effect.chance)) continue;

    if (operation === 'consume') {
      const consumed = consumeMomentumStacks(caster, config);
      if (!consumed.consumed) continue;
      addMomentumBonusToContext(context, consumed.bonusType, consumed.bonusRate);
      context.momentumConsumed.push(consumed.text);
      continue;
    }

    const gained = gainMomentumStacks(caster, config);
    if (!gained.gained) continue;
    context.momentumGained.push(gained.text);
  }
}

/**
 * 执行技能
 */
export function executeSkill(
  state: BattleState,
  caster: BattleUnit,
  skill: BattleSkill,
  selectedTargetIds?: string[]
): SkillExecutionResult {
  // 检查控制状态
  if (!canUseSkill(caster, skill.damageType)) {
    return { success: false, error: '被控制无法使用技能' };
  }
  
  // 检查沉默/缴械
  if (skill.damageType === 'magic' && isSilenced(caster)) {
    return { success: false, error: '被沉默无法使用法术' };
  }
  if (skill.damageType === 'physical' && isDisarmed(caster)) {
    return { success: false, error: '被缴械无法使用物理技能' };
  }
  
  // 检查冷却
  const cooldownMessage = getSkillCooldownBlockedMessage(caster, skill.id);
  if (cooldownMessage) {
    return { success: false, error: cooldownMessage };
  }
  
  // 检查消耗
  const cost = resolveCasterSkillCost(caster, skill);
  if (cost.totalLingqi > 0 && caster.lingqi < cost.totalLingqi) {
    return { success: false, error: '灵气不足' };
  }
  if (cost.totalQixue > 0 && caster.qixue <= cost.totalQixue) {
    return { success: false, error: '气血不足' };
  }
  
  // 扣除消耗
  if (cost.totalLingqi > 0) {
    caster.lingqi -= cost.totalLingqi;
  }
  if (cost.totalQixue > 0) {
    caster.qixue -= cost.totalQixue;
  }
  
  // 设置冷却
  if (skill.cooldown > 0) {
    applySkillCooldownAfterCast(caster, skill.id, skill.cooldown);
  }
  
  // 解析目标
  const targets = resolveTargets(state, caster, skill, selectedTargetIds);
  if (targets.length === 0) {
    return { success: false, error: '没有有效目标' };
  }

  const context = createSkillExecutionContext();
  
  // 先落主动作日志，再按触发时机追加触发日志，保证日志顺序符合战斗时序
  const targetResults: TargetResult[] = [];
  const log: ActionLog = {
    type: 'action',
    round: state.roundCount,
    actorId: caster.id,
    actorName: caster.name,
    skillId: skill.id,
    skillName: skill.name,
    targets: targetResults,
  };
  state.logs.push(log);

  const onSkillLogs = triggerSetBonusEffects(state, 'on_skill', caster);
  state.logs.push(...onSkillLogs);

  processMomentumEffectsByOperation(state, caster, skill, context, 'consume');
  
  for (const target of targets) {
    const result = executeSkillOnTarget(state, caster, target, skill, context);
    targetResults.push(result);
  }

  processMomentumEffectsByOperation(state, caster, skill, context, 'gain');

  if (targetResults.length > 0) {
    if (context.momentumConsumed.length > 0) {
      targetResults[0].momentumConsumed = [...context.momentumConsumed];
    }
    if (context.momentumGained.length > 0) {
      targetResults[0].momentumGained = [...context.momentumGained];
    }
  }
  
  return { success: true, log };
}

/**
 * 对单个目标执行技能效果
 */
function executeSkillOnTarget(
  state: BattleState,
  caster: BattleUnit,
  target: BattleUnit,
  skill: BattleSkill,
  context: SkillExecutionContext,
): TargetResult {
  const result: TargetResult = {
    targetId: target.id,
    targetName: target.name,
    hits: [],
    buffsApplied: [],
    buffsRemoved: [],
    marksApplied: [],
    marksConsumed: [],
  };

  // 先处理伤害效果，保持“先伤害后附加效果”的执行顺序
  let attemptedDamage = false;
  let landedDamage = false;
  for (const effect of skill.effects) {
    if (effect.type !== 'damage') continue;
    if (typeof effect.chance === 'number' && !rollChance(state, effect.chance)) {
      continue;
    }

    const summary = executeDamageEffect(state, caster, target, skill, effect, result, context);
    attemptedDamage = attemptedDamage || summary.attempted;
    landedDamage = landedDamage || summary.landed;
  }
  if (attemptedDamage && !landedDamage) {
    result.isMiss = true;
  }

  // 再处理非伤害技能效果
  for (const effect of skill.effects) {
    if (effect.type === 'damage' || effect.type === 'momentum') continue;
    // 控制效果走独立命中流程，避免重复概率判定
    if (effect.type !== 'control' && typeof effect.chance === 'number' && !rollChance(state, effect.chance)) {
      continue;
    }
    
    executeEffect(state, caster, target, skill, effect, result, context);
  }
  
  return result;
}

/**
 * 执行单个效果
 */
function executeEffect(
  state: BattleState,
  caster: BattleUnit,
  target: BattleUnit,
  skill: BattleSkill,
  effect: SkillEffect,
  result: TargetResult,
  context: SkillExecutionContext,
): void {
  switch (effect.type) {
    case 'damage':
      // 伤害效果在 executeSkillOnTarget 中统一执行
      break;
      
    case 'heal':
      executeHealEffect(state, caster, target, skill, effect, result, context);
      break;
      
    case 'shield':
      executeShieldEffect(caster, target, skill, effect, result, context);
      break;
      
    case 'buff':
    case 'debuff':
      executeBuffEffect(caster, target, skill, effect as BuffOrDebuffEffect, result);
      break;
      
    case 'dispel':
      executeDispelEffect(target, effect, result);
      break;
      
    case 'resource':
      executeResourceEffect(target, effect, result, context);
      break;

    case 'restore_lingqi':
      executeRestoreLingqiEffect(target, effect, result, context);
      break;

    case 'cleanse':
      executeCleanseEffect(target, effect, result);
      break;

    case 'cleanse_control':
      executeCleanseControlEffect(target, effect, result);
      break;

    case 'lifesteal':
      executeLifestealEffect(caster, result, effect);
      break;

    case 'control':
      executeControlEffect(state, caster, target, effect, result);
      break;

    case 'mark':
      executeMarkEffect(state, caster, target, skill, effect, result);
      break;

    case 'momentum':
      break;
  }
}

function executeMarkEffect(
  state: BattleState,
  caster: BattleUnit,
  target: BattleUnit,
  skill: BattleSkill,
  effect: SkillEffect,
  result: TargetResult
): void {
  const config = resolveMarkEffectConfig(effect as unknown as Record<string, unknown>);
  if (!config) return;

  if (config.operation === 'apply') {
    const applied = applyMarkStacks(target, caster.id, config);
    if (applied.applied) {
      result.marksApplied?.push(applied.text);
    }
    return;
  }

  const fallbackScaleAttr = skill.damageType === 'magic' ? 'fagong' : 'wugong';
  const baseValue = Math.max(0, resolveEffectValue(caster, skill, effect, fallbackScaleAttr));
  const consumed = consumeMarkStacks(
    target,
    caster.id,
    config,
    baseValue,
    target.currentAttrs.max_qixue
  );
  if (!consumed.consumed) return;

  const consumeText = consumed.wasCapped ? `${consumed.text}（触发35%上限）` : consumed.text;
  result.marksConsumed?.push(consumeText);

  const convertedValue = Math.max(0, consumed.finalValue);
  if (convertedValue <= 0) return;

  if (consumed.resultType === 'damage') {
    const hitIndex = result.hits.length + 1;
    const { actualDamage, shieldAbsorbed } = applyDamage(state, target, convertedValue, 'true');
    const safeDamage = Math.max(0, actualDamage);
    const safeShieldAbsorbed = Math.max(0, shieldAbsorbed);
    result.hits.push({
      index: hitIndex,
      damage: safeDamage,
      isMiss: false,
      isCrit: false,
      isParry: false,
      isElementBonus: false,
      shieldAbsorbed: safeShieldAbsorbed,
    });
    result.damage = (result.damage || 0) + safeDamage;
    result.shieldAbsorbed = (result.shieldAbsorbed || 0) + safeShieldAbsorbed;
    caster.stats.damageDealt += safeDamage;

    if (!target.isAlive) {
      caster.stats.killCount++;
      state.logs.push({
        type: 'death',
        round: state.roundCount,
        unitId: target.id,
        unitName: target.name,
        killerId: caster.id,
        killerName: caster.name,
      });
    }
    return;
  }

  if (consumed.resultType === 'shield_self') {
    const duration = Math.max(1, Math.floor(toFiniteNumber(effect.duration, 2)));
    addShield(caster, {
      value: convertedValue,
      maxValue: convertedValue,
      duration,
      absorbType: 'all',
      priority: 1,
      sourceSkillId: skill.id,
    }, caster.id);
    if (target.id === caster.id) {
      result.buffsApplied?.push('护盾');
    }
    return;
  }

  const actualHeal = applyHealing(caster, convertedValue);
  if (actualHeal > 0) {
    caster.stats.healingDone += actualHeal;
    if (target.id === caster.id) {
      result.heal = (result.heal || 0) + actualHeal;
    }
  }
}

/**
 * 执行治疗效果
 */
function executeHealEffect(
  state: BattleState,
  caster: BattleUnit,
  target: BattleUnit,
  skill: BattleSkill,
  effect: SkillEffect,
  result: TargetResult,
  context: SkillExecutionContext,
): void {
  let healValue = effect.valueType === 'percent'
    ? Math.floor(target.currentAttrs.max_qixue * toFiniteNumber(effect.value, 0))
    : resolveEffectValue(caster, skill, effect, 'fagong');
  healValue = applyContextBonus(healValue, context.momentumBonusRateByType.heal);
  
  // 治疗加成
  const healBonus = Math.min(caster.currentAttrs.zhiliao, BATTLE_CONSTANTS.MAX_HEAL_BONUS);
  healValue = Math.floor(healValue * (1 + healBonus));
  
  // 减疗
  const healReduction = Math.min(target.currentAttrs.jianliao, BATTLE_CONSTANTS.MAX_HEAL_REDUCTION);
  healValue = Math.floor(healValue * (1 - healReduction));
  
  const actualHeal = applyHealing(target, healValue);
  result.heal = actualHeal;
  caster.stats.healingDone += actualHeal;
  if (actualHeal > 0) {
    const logs = triggerSetBonusEffects(state, 'on_heal', caster, {
      target,
      heal: actualHeal,
    });
    state.logs.push(...logs);
  }
}

/**
 * 执行护盾效果
 */
function executeShieldEffect(
  caster: BattleUnit,
  target: BattleUnit,
  skill: BattleSkill,
  effect: SkillEffect,
  result: TargetResult,
  context: SkillExecutionContext,
): void {
  const shieldValue = Math.max(
    1,
    applyContextBonus(
      resolveEffectValue(caster, skill, effect, 'max_qixue'),
      context.momentumBonusRateByType.shield,
    ),
  );
  const duration = Math.max(1, Math.floor(toFiniteNumber(effect.duration, 2)));
  
  addShield(target, {
    value: shieldValue,
    maxValue: shieldValue,
    duration,
    absorbType: 'all',
    priority: 1,
    sourceSkillId: '',
  }, '');
  
  result.buffsApplied?.push('护盾');
}

/**
 * 执行Buff/Debuff效果
 */
function executeBuffEffect(
  caster: BattleUnit,
  target: BattleUnit,
  skill: BattleSkill,
  effect: BuffOrDebuffEffect,
  result: TargetResult
): void {
  const buffDefId = resolveBuffEffectKey(effect);
  if (!buffDefId) return;
  
  const buffType = effect.type === 'buff' ? 'buff' : 'debuff';
  const stacks = Math.max(1, Math.floor(toFiniteNumber(effect.stacks, 1)));
  const duration = Math.max(1, Math.floor(toFiniteNumber(effect.duration, 1)));
  const runtimeData = buildBuffRuntimeData(caster, target, skill, effect);
  if (!hasBuffRuntimeData(runtimeData)) return;
  
  addBuff(target, {
    id: `${buffDefId}-${Date.now()}`,
    buffDefId,
    name: buffDefId,
    type: buffType,
    category: 'skill',
    sourceUnitId: caster.id,
    maxStacks: stacks,
    attrModifiers: runtimeData.attrModifiers,
    dot: runtimeData.dot,
    hot: runtimeData.hot,
    reflectDamage: runtimeData.reflectDamage,
    tags: [],
    dispellable: true,
  }, duration, stacks);
  
  result.buffsApplied?.push(buffDefId);
}

/**
 * 执行驱散效果
 */
function executeDispelEffect(
  target: BattleUnit,
  effect: SkillEffect,
  result: TargetResult
): void {
  const dispelCount = Math.max(1, Math.floor(toFiniteNumber(effect.count, 1)));
  const dispelType = effect.dispelType || 'debuff';
  const toRemove = target.buffs
    .filter((buff) => buff.dispellable)
    .filter((buff) => dispelType === 'all' || buff.type === dispelType)
    .slice(0, dispelCount);

  for (const buff of toRemove) {
    if (removeBuff(target, buff.id)) {
      result.buffsRemoved?.push(buff.name);
    }
  }
}

/**
 * 执行净化效果（移除Debuff）
 */
function executeCleanseEffect(
  target: BattleUnit,
  effect: SkillEffect,
  result: TargetResult
): void {
  const count = Math.max(1, Math.floor(toFiniteNumber(effect.count, 1)));
  const tempEffect: SkillEffect = {
    type: 'dispel',
    dispelType: 'debuff',
    count,
  };
  executeDispelEffect(target, tempEffect, result);
}

/**
 * 执行净控效果（仅移除控制Debuff）
 */
function executeCleanseControlEffect(
  target: BattleUnit,
  effect: SkillEffect,
  result: TargetResult
): void {
  const count = Math.max(1, Math.floor(toFiniteNumber(effect.count, 1)));
  const toRemove = target.buffs
    .filter((buff) => buff.type === 'debuff' && !!buff.control)
    .slice(0, count);

  for (const buff of toRemove) {
    if (removeBuff(target, buff.id)) {
      result.buffsRemoved?.push(buff.name);
    }
  }
}

/**
 * 执行吸血效果（按本次命中伤害比例回复施法者）
 */
function executeLifestealEffect(
  caster: BattleUnit,
  result: TargetResult,
  effect: SkillEffect
): void {
  const damage = Math.max(0, Math.floor(toFiniteNumber(result.damage, 0)));
  if (damage <= 0) return;
  const rate = Math.max(0, toFiniteNumber(effect.value, 0));
  if (rate <= 0) return;
  const healAmount = Math.floor(damage * rate);
  if (healAmount <= 0) return;

  const actualHeal = applyHealing(caster, healAmount);
  if (actualHeal > 0) {
    caster.stats.healingDone += actualHeal;
  }
}

/**
 * 执行控制效果
 */
function executeControlEffect(
  state: BattleState,
  caster: BattleUnit,
  target: BattleUnit,
  effect: SkillEffect,
  result: TargetResult
): void {
  const controlType = typeof effect.controlType === 'string' ? effect.controlType.trim() : '';
  if (!controlType) return;
  const controlRate = Math.max(0, toFiniteNumber(effect.chance, 1));
  const controlDuration = Math.max(1, Math.floor(toFiniteNumber(effect.duration, 1)));

  const controlResult = tryApplyControl(
    state,
    caster,
    target,
    controlType,
    controlRate,
    controlDuration
  );
  
  if (controlResult.success) {
    result.controlApplied = controlType;
  } else if (controlResult.resisted) {
    result.controlResisted = true;
  }
}

/**
 * 执行灵气回复效果
 */
function executeRestoreLingqiEffect(
  target: BattleUnit,
  effect: SkillEffect,
  result: TargetResult,
  context: SkillExecutionContext,
): void {
  const value = Math.max(
    0,
    applyContextBonus(
      Math.floor(toFiniteNumber(effect.value, 0)),
      context.momentumBonusRateByType.resource,
    ),
  );
  if (value <= 0) return;
  target.lingqi = Math.min(target.lingqi + value, target.currentAttrs.max_lingqi);
  result.resources = [...(result.resources ?? []), { type: 'lingqi', amount: value }];
}

/**
 * 执行资源效果
 */
function executeResourceEffect(
  target: BattleUnit,
  effect: SkillEffect,
  result: TargetResult,
  context: SkillExecutionContext,
): void {
  const value = applyContextBonus(toFiniteNumber(effect.value, 0), context.momentumBonusRateByType.resource);
  if (value === 0) return;
  
  if (effect.resourceType === 'lingqi') {
    target.lingqi = Math.min(
      target.lingqi + value,
      target.currentAttrs.max_lingqi
    );
    result.resources = [...(result.resources ?? []), { type: 'lingqi', amount: Math.abs(Math.floor(value)) }];
  } else if (effect.resourceType === 'qixue') {
    target.qixue = Math.min(
      target.qixue + value,
      target.currentAttrs.max_qixue
    );
    result.resources = [...(result.resources ?? []), { type: 'qixue', amount: Math.abs(Math.floor(value)) }];
  }
}

/**
 * 获取普通攻击技能
 */
export function getNormalAttack(unit: BattleUnit): BattleSkill {
  const damageType = unit.currentAttrs.fagong > unit.currentAttrs.wugong 
    ? 'magic' 
    : 'physical';
  
  return {
    id: 'skill-normal-attack',
    name: '普通攻击',
    source: 'innate',
    cost: {},
    cooldown: 0,
    targetType: 'single_enemy',
    targetCount: 1,
    damageType,
    element: (unit.currentAttrs.element as string) || 'none',
    effects: [{
      type: 'damage',
      valueType: 'scale',
      scaleAttr: damageType === 'magic' ? 'fagong' : 'wugong',
      scaleRate: 1,
    }],
    triggerType: 'active',
    aiPriority: 0,
  };
}

/**
 * 获取可用技能列表
 */
export function getAvailableSkills(unit: BattleUnit): BattleSkill[] {
  return unit.skills.filter(skill => {
    // 检查冷却
    if (getSkillCooldownRemainingRounds(unit, skill.id) > 0) return false;
    
    // 检查消耗
    const cost = resolveCasterSkillCost(unit, skill);
    if (cost.totalLingqi > 0 && unit.lingqi < cost.totalLingqi) return false;
    if (cost.totalQixue > 0 && unit.qixue <= cost.totalQixue) return false;
    
    // 检查触发类型
    if (skill.triggerType !== 'active') return false;
    
    return true;
  });
}
