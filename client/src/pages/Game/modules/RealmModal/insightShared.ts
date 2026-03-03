/**
 * 悟道前端共享计算（与服务端规则同源）
 *
 * 作用（做什么 / 不做什么）：
 * 1) 做什么：提供悟道单级消耗、按经验注入模拟、进度百分比与百分比文案格式化。
 * 2) 做什么：作为 RealmModal 的唯一前端数值入口，避免在组件内重复写循环结算逻辑。
 * 3) 不做什么：不发起网络请求，不依赖 React 状态，不读写全局 store。
 *
 * 输入/输出：
 * - 输入：当前等级、当前级进度、模拟注入经验、悟道成长配置。
 * - 输出：本次模拟可提升等级、消耗经验、注入后进度、加成增量等展示数据。
 *
 * 数据流/状态流：
 * RealmModal 长按状态 -> simulateInsightInjectByExp -> InsightPanel 展示预览；
 * 松开后把 `appliedExp` 提交后端，后端按同规则真实结算。
 *
 * 关键边界条件与坑点：
 * 1) 所有输入均会收敛为非负整数，避免浮点动画中间值污染最终展示。
 * 2) `currentProgressExp` 不允许大于等于当前升级需求，若异常将按边界收敛，避免前端出现负缺口。
 */

export interface InsightGrowthStageConfig {
  costStageLevels: number;
  costStageBaseExp: number;
  bonusPctPerLevel: number;
}

export interface InsightInjectByExpPreview {
  appliedExp: number;
  gainedLevels: number;
  afterLevel: number;
  afterProgressExp: number;
  nextLevelCostExp: number;
  gainedBonusPct: number;
  afterBonusPct: number;
}

const toSafeInteger = (value: number): number => {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.floor(value));
};

/**
 * 计算目标等级（1-based）对应的单级消耗。
 * 规则：每 `costStageLevels` 级进入下一档，每档单级成本增加一个 `costStageBaseExp`。
 */
export const calcInsightCostByLevel = (level: number, growth: InsightGrowthStageConfig): number => {
  const safeLevel = Math.max(1, toSafeInteger(level));
  const safeStageLevels = Math.max(1, toSafeInteger(growth.costStageLevels));
  const safeStageBaseExp = Math.max(1, toSafeInteger(growth.costStageBaseExp));
  const stageIndex = Math.floor((safeLevel - 1) / safeStageLevels) + 1;
  return safeStageBaseExp * stageIndex;
};

/**
 * 计算指定悟道等级对应的总百分比加成（小数形式）。
 */
export const buildInsightBonusPctByLevel = (level: number, bonusPctPerLevel: number): number => {
  return toSafeInteger(level) * Math.max(0, bonusPctPerLevel);
};

/**
 * 按“经验预算”模拟一次悟道注入（仅前端预览，不落库）。
 *
 * 说明：
 * 1) 预算经验会先填当前等级缺口，满级后自动进入下一等级继续计算；
 * 2) 预算不足升级时，剩余经验会停留在 `afterProgressExp`；
 * 3) 返回的 `appliedExp` 就是本次应提交给后端的经验值。
 */
export const simulateInsightInjectByExp = (params: {
  currentLevel: number;
  currentProgressExp: number;
  injectExp: number;
  growth: InsightGrowthStageConfig;
}): InsightInjectByExpPreview => {
  const { currentLevel, currentProgressExp, injectExp, growth } = params;
  let level = toSafeInteger(currentLevel);
  let progressExp = toSafeInteger(currentProgressExp);
  let budgetExp = toSafeInteger(injectExp);

  const currentLevelCost = calcInsightCostByLevel(level + 1, growth);
  if (progressExp >= currentLevelCost) {
    progressExp = Math.max(0, currentLevelCost - 1);
  }

  const beforeBonusPct = buildInsightBonusPctByLevel(level, growth.bonusPctPerLevel);
  let gainedLevels = 0;
  let appliedExp = 0;

  while (budgetExp > 0) {
    const nextLevelCost = calcInsightCostByLevel(level + 1, growth);
    const requiredExp = Math.max(0, nextLevelCost - progressExp);
    if (requiredExp <= 0) {
      level += 1;
      progressExp = 0;
      gainedLevels += 1;
      continue;
    }

    if (budgetExp >= requiredExp) {
      budgetExp -= requiredExp;
      appliedExp += requiredExp;
      level += 1;
      progressExp = 0;
      gainedLevels += 1;
      continue;
    }

    progressExp += budgetExp;
    appliedExp += budgetExp;
    budgetExp = 0;
  }

  const afterBonusPct = buildInsightBonusPctByLevel(level, growth.bonusPctPerLevel);
  return {
    appliedExp,
    gainedLevels,
    afterLevel: level,
    afterProgressExp: progressExp,
    nextLevelCostExp: calcInsightCostByLevel(level + 1, growth),
    gainedBonusPct: afterBonusPct - beforeBonusPct,
    afterBonusPct,
  };
};

/**
 * 计算当前级进度百分比（0~100）。
 */
export const calcInsightProgressPct = (progressExp: number, nextLevelCostExp: number): number => {
  const safeCost = toSafeInteger(nextLevelCostExp);
  if (safeCost <= 0) return 0;
  const safeProgress = Math.max(0, Math.min(safeCost, toSafeInteger(progressExp)));
  const rawPct = (safeProgress / safeCost) * 100;
  return Math.max(0, Math.min(100, rawPct));
};

/**
 * 百分比文案格式化：0.001 -> "0.10%"。
 */
export const formatInsightPctText = (pct: number): string => {
  return `${(Math.max(0, pct) * 100).toFixed(2)}%`;
};

