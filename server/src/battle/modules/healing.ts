/**
 * 九州修仙录 - 治疗计算模块
 *
 * 作用：
 * 1) 统一处理战斗内气血治疗、吸血与敌方减疗压制。
 * 2) 不处理护盾、回灵和气血恢复属性的自然回复。
 *
 * 输入/输出：
 * - 输入：战斗状态、治疗目标、基础治疗量，以及可选治疗来源。
 * - 输出：实际恢复气血值，并同步目标气血与治疗统计。
 *
 * 数据流/状态流：
 * 技能 / HOT / 光环 / 套装治疗量 -> 敌方最高 jianliao 递减压制 -> 断脉与蚀心锁 -> 目标气血。
 *
 * 复用设计说明：
 * - `jianliao` 是对敌全体生效的被动减疗能力，必须在这里统一按目标敌方阵营计算，避免技能治疗、HOT、吸血各自误用目标自身属性。
 * - 直接治疗、持续治疗、光环治疗和套装治疗都复用同一入口，避免同一业务规则散落维护。
 *
 * 关键边界条件与坑点：
 * 1) 目标自己的 jianliao 不能降低自己受到的治疗，否则高减疗伙伴会被自身属性永久禁疗。
 * 2) 敌方多单位减疗取最高值且不叠加，避免组队场景线性堆叠成全局禁疗。
 * 3) jianliao 使用递减收益并封顶，避免成长到 1 以上的伙伴属性直接按 100% 禁疗结算。
 */

import type { BattleState, BattleUnit } from '../types.js';
import { applySoulShackleRecoveryReduction } from './mark.js';

const JIANLIAO_PASSIVE_SCALE = 5;
const MAX_PASSIVE_HEAL_REDUCTION_RATE = 0.5;

function normalizePassiveHealingReduction(rawJianliao: number): number {
  if (!Number.isFinite(rawJianliao) || rawJianliao <= 0) return 0;
  const diminishingRate = rawJianliao / (rawJianliao + JIANLIAO_PASSIVE_SCALE);
  return Math.min(MAX_PASSIVE_HEAL_REDUCTION_RATE, diminishingRate);
}

function resolveOpponentHealingReductionRate(
  state: BattleState,
  target: BattleUnit,
): number {
  const isAttacker = state.teams.attacker.units.some((unit) => unit.id === target.id);
  const opponents = isAttacker ? state.teams.defender.units : state.teams.attacker.units;
  let maxReduction = 0;
  for (const opponent of opponents) {
    if (!opponent.isAlive) continue;
    const reduction = opponent.currentAttrs.jianliao;
    if (reduction > maxReduction) {
      maxReduction = reduction;
    }
  }
  if (maxReduction <= 0) return 0;
  return normalizePassiveHealingReduction(maxReduction);
}

/**
 * 应用治疗
 */
export function applyHealing(
  target: BattleUnit,
  healAmount: number,
  _healerId?: string
): number {
  if (target.buffs.some((buff) => buff.healForbidden)) {
    return 0;
  }
  const effectiveHealAmount = applySoulShackleRecoveryReduction(healAmount, target);
  if (effectiveHealAmount <= 0) {
    return 0;
  }
  const missingHp = target.currentAttrs.max_qixue - target.qixue;
  const actualHeal = Math.min(effectiveHealAmount, missingHp);
  
  target.qixue += actualHeal;
  target.stats.healingReceived += actualHeal;
  
  return actualHeal;
}

export function applyBattleHealing(
  state: BattleState,
  target: BattleUnit,
  healAmount: number,
): number {
  const healReduction = resolveOpponentHealingReductionRate(state, target);
  const reducedHealAmount = Math.floor(healAmount * (1 - healReduction));
  return applyHealing(target, reducedHealAmount);
}

/**
 * 计算吸血
 */
function calculateLifesteal(
  attacker: BattleUnit,
  damage: number
): number {
  const lifestealRate = attacker.currentAttrs.xixue;
  return Math.floor(damage * lifestealRate);
}

/**
 * 应用吸血
 */
export function applyLifesteal(
  state: BattleState,
  attacker: BattleUnit,
  damage: number
): number {
  const lifestealAmount = calculateLifesteal(attacker, damage);
  if (lifestealAmount <= 0) return 0;
  
  const actualHeal = applyBattleHealing(state, attacker, lifestealAmount);
  attacker.stats.healingDone += actualHeal;
  
  return actualHeal;
}
