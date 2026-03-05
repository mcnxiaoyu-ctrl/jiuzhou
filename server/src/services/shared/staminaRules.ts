/**
 * 体力上限规则（纯函数）
 *
 * 作用（做什么 / 不做什么）：
 * 1) 做什么：统一维护“基础体力上限 + 悟道等级增量”的计算规则。
 * 2) 不做什么：不读写数据库、不处理体力恢复时钟与扣减事务。
 *
 * 输入/输出：
 * - 输入：悟道等级（0-based）。
 * - 输出：角色体力上限（正整数）。
 *
 * 数据流/状态流：
 * staminaService / characterComputedService -> 调用本模块 ->
 * 统一得到角色体力上限，避免多处散落同样公式。
 *
 * 关键边界条件与坑点：
 * 1) 悟道等级统一按非负整数处理，非法值会被归一为 0。
 * 2) 体力上限至少为 1，避免配置异常导致上限为 0。
 */
import { calcInsightStaminaBonusByLevel } from './insightRules.js';

const toPositiveInt = (value: string | undefined, fallback: number): number => {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  const v = Math.floor(n);
  return v > 0 ? v : fallback;
};

const toNonNegativeInt = (value: unknown): number => {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  const v = Math.floor(n);
  return v >= 0 ? v : 0;
};

/**
 * 角色基础体力上限（不含悟道增量）。
 */
export const STAMINA_BASE_MAX = toPositiveInt(process.env.STAMINA_MAX, 100);

/**
 * 按悟道等级计算角色体力上限。
 * 规则：每 10 级悟道，体力上限 +1。
 */
export const calcCharacterStaminaMaxByInsightLevel = (insightLevel: number): number => {
  const safeInsightLevel = toNonNegativeInt(insightLevel);
  const bonus = calcInsightStaminaBonusByLevel(safeInsightLevel);
  return Math.max(1, STAMINA_BASE_MAX + bonus);
};
