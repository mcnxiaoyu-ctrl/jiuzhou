import type {
  AffixPoolPreviewAffixEntry,
  InventoryRerolledAffixDto,
  InventoryRerollRequest,
  InventoryRerollResponse,
} from '../../../../services/api';
import type { EquipmentAffix } from './bagShared';

/**
 * 装备自动洗炼共享规则
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：集中处理自动洗炼的目标词条选项构建、目标命中判定、资源可执行次数估算与循环执行流程，供桌面端和移动端共用。
 * 2. 做什么：把“何时停止自动洗炼”收敛成单一纯逻辑，避免两个界面各自维护 while 循环与停止条件。
 * 3. 不做什么：不直接持有 React state、不管理弹窗开关，也不负责 toast 文案展示。
 *
 * 输入/输出：
 * - 输入：词条池预览、当前装备词条、目标 key 列表、锁定索引、资源余量，以及实际洗炼请求函数。
 * - 输出：下拉选项、是否命中、可执行次数，以及自动洗炼执行结果。
 *
 * 数据流/状态流：
 * - `/inventory/reroll-affixes/pool-preview` + 当前装备词条 -> 目标选项；
 * - 当前资源与最大次数 -> 可执行次数；
 * - 自动洗炼按钮 -> `runAutoRerollUntilMatch` -> 组件刷新库存与提示结果。
 *
 * 关键边界条件与坑点：
 * 1. 目标词条 key 可能为空或重复，必须先统一去空去重，否则会出现“空目标永远命中”或重复目标导致次数白跑。
 * 2. 单次消耗可能为 0，次数估算必须把该资源视为“不构成上限”，不能直接除 0。
 */

export type AutoRerollRuntimeAffix = InventoryRerolledAffixDto | EquipmentAffix;

export type AutoRerollTargetOption = {
  key: string;
  label: string;
};

export type AutoRerollStopReason = 'matched' | 'max_attempts' | 'request_failed';

export type AutoRerollRunResult = {
  stopReason: AutoRerollStopReason;
  attempts: number;
  failureMessage: string;
  latestAffixes: AutoRerollRuntimeAffix[];
  latestLockIndexes: number[];
};

const normalizeAffixKey = (value: string | undefined): string => {
  return value?.trim() ?? '';
};

const buildOptionLabel = (name: string | undefined, key: string): string => {
  const nameText = name?.trim() ?? '';
  if (!nameText) return key;
  return `${nameText}（${key}）`;
};

export const normalizeAutoRerollTargetKeys = (targetKeys: string[]): string[] => {
  const seen = new Set<string>();
  const normalized: string[] = [];

  for (const rawKey of targetKeys) {
    const key = normalizeAffixKey(rawKey);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    normalized.push(key);
  }

  return normalized;
};

export const buildAutoRerollTargetOptions = (
  poolAffixes: AffixPoolPreviewAffixEntry[],
  currentAffixes: EquipmentAffix[],
): AutoRerollTargetOption[] => {
  const optionMap = new Map<string, AutoRerollTargetOption>();

  for (const affix of poolAffixes) {
    const key = normalizeAffixKey(affix.key);
    if (!key) continue;
    optionMap.set(key, {
      key,
      label: buildOptionLabel(affix.name, key),
    });
  }

  for (const affix of currentAffixes) {
    const key = normalizeAffixKey(affix.key);
    if (!key || optionMap.has(key)) continue;
    optionMap.set(key, {
      key,
      label: buildOptionLabel(affix.name, key),
    });
  }

  return [...optionMap.values()].sort((left, right) => (
    left.label.localeCompare(right.label, 'zh-Hans-CN')
  ));
};

export const hasMatchedAutoRerollTargets = (
  affixes: AutoRerollRuntimeAffix[],
  targetKeys: string[],
): boolean => {
  const normalizedTargets = normalizeAutoRerollTargetKeys(targetKeys);
  if (normalizedTargets.length <= 0) return false;

  const currentKeys = new Set(
    affixes
      .map((affix) => normalizeAffixKey(affix.key))
      .filter((key) => key.length > 0),
  );

  return normalizedTargets.every((targetKey) => currentKeys.has(targetKey));
};

export const getAffordableAutoRerollTimes = (input: {
  rerollScrollOwned: number;
  rerollScrollCost: number;
  spiritStoneOwned: number;
  spiritStoneCost: number;
  silverOwned: number;
  silverCost: number;
  maxAttempts: number;
}): number => {
  const resolveTimesByCost = (owned: number, cost: number): number => {
    if (cost <= 0) return Number.POSITIVE_INFINITY;
    return Math.floor(Math.max(0, owned) / cost);
  };

  return Math.max(0, Math.min(
    resolveTimesByCost(input.rerollScrollOwned, input.rerollScrollCost),
    resolveTimesByCost(input.spiritStoneOwned, input.spiritStoneCost),
    resolveTimesByCost(input.silverOwned, input.silverCost),
    Math.max(0, Math.floor(input.maxAttempts)),
  ));
};

export const runAutoRerollUntilMatch = async (input: {
  itemId: number;
  lockIndexes: number[];
  initialAffixes: AutoRerollRuntimeAffix[];
  targetKeys: string[];
  maxAttempts: number;
  reroll: (body: InventoryRerollRequest) => Promise<InventoryRerollResponse>;
}): Promise<AutoRerollRunResult> => {
  const normalizedTargets = normalizeAutoRerollTargetKeys(input.targetKeys);
  let latestAffixes = input.initialAffixes;
  let latestLockIndexes = input.lockIndexes;

  if (hasMatchedAutoRerollTargets(latestAffixes, normalizedTargets)) {
    return {
      stopReason: 'matched',
      attempts: 0,
      failureMessage: '',
      latestAffixes,
      latestLockIndexes,
    };
  }

  for (let attemptIndex = 0; attemptIndex < input.maxAttempts; attemptIndex += 1) {
    const response = await input.reroll({
      itemId: input.itemId,
      lockIndexes: latestLockIndexes,
    });

    if (!response.success || !response.data) {
      return {
        stopReason: 'request_failed',
        attempts: attemptIndex,
        failureMessage: response.message,
        latestAffixes,
        latestLockIndexes,
      };
    }

    latestAffixes = response.data.affixes;
    latestLockIndexes = response.data.lockIndexes;
    const attempts = attemptIndex + 1;

    if (hasMatchedAutoRerollTargets(latestAffixes, normalizedTargets)) {
      return {
        stopReason: 'matched',
        attempts,
        failureMessage: '',
        latestAffixes,
        latestLockIndexes,
      };
    }
  }

  return {
    stopReason: 'max_attempts',
    attempts: Math.max(0, Math.floor(input.maxAttempts)),
    failureMessage: '',
    latestAffixes,
    latestLockIndexes,
  };
};
