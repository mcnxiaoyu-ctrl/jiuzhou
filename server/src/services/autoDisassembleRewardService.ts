import type { GenerateOptions } from './equipmentService.js';
import { generateEquipment } from './equipmentService.js';
import { buildDisassembleRewardPlan } from './disassembleRewardPlanner.js';
import { resolveItemCanDisassemble } from './shared/itemDisassembleRule.js';
import {
  shouldAutoDisassembleBySetting,
  type AutoDisassembleCandidateMeta,
  type AutoDisassembleSetting,
} from './autoDisassembleRules.js';
export type { AutoDisassembleRuleSet, AutoDisassembleSetting } from './autoDisassembleRules.js';

export type PendingMailItem = {
  item_def_id: string;
  qty: number;
  options?: {
    bindType?: string;
    equipOptions?: unknown;
  };
};

export interface GrantItemCreateResult {
  success: boolean;
  message: string;
  itemIds?: number[];
  equipment?: {
    quality?: string;
    qualityRank?: number;
  };
}

export type GrantItemCreateFn = (params: {
  itemDefId: string;
  qty: number;
  bindType?: string;
  obtainedFrom: string;
  equipOptions?: unknown;
}) => Promise<GrantItemCreateResult>;

export type AddCharacterSilverFn = (
  characterId: number,
  silver: number
) => Promise<{ success: boolean; message: string }>;

export interface GrantRewardItemWithAutoDisassembleInput {
  characterId: number;
  itemDefId: string;
  qty: number;
  bindType?: string;
  itemMeta: {
    itemName?: string | null;
    category: string;
    subCategory?: string | null;
    effectDefs?: unknown;
    qualityRank?: number | null;
    disassemblable?: boolean | null;
  };
  autoDisassembleSetting: AutoDisassembleSetting;
  sourceObtainedFrom: string;
  createItem: GrantItemCreateFn;
  addSilver?: AddCharacterSilverFn;
  sourceEquipOptions?: unknown;
}

export interface GrantedRewardItem {
  itemDefId: string;
  qty: number;
  itemIds: number[];
}

export interface GrantRewardItemWithAutoDisassembleResult {
  grantedItems: GrantedRewardItem[];
  pendingMailItems: PendingMailItem[];
  warnings: string[];
  gainedSilver: number;
}

const normalizeItemIds = (itemIds?: number[]): number[] => {
  if (!Array.isArray(itemIds)) return [];
  return itemIds.filter((id) => Number.isInteger(id) && id > 0);
};

const appendGrantedItem = (
  result: GrantRewardItemWithAutoDisassembleResult,
  itemDefId: string,
  qty: number,
  itemIds: number[]
): void => {
  const existing = result.grantedItems.find((item) => item.itemDefId === itemDefId);
  if (existing) {
    existing.qty += qty;
    if (itemIds.length > 0) {
      existing.itemIds.push(...itemIds);
    }
    return;
  }
  result.grantedItems.push({ itemDefId, qty, itemIds: [...itemIds] });
};

const appendPendingMailItem = (
  result: GrantRewardItemWithAutoDisassembleResult,
  mailItem: PendingMailItem
): void => {
  const targetOptions = mailItem.options;
  const targetBindType = targetOptions?.bindType || 'none';
  const targetEquipOptionsKey = JSON.stringify(targetOptions?.equipOptions || null);
  const existing = result.pendingMailItems.find((item) => {
    const bindType = item.options?.bindType || 'none';
    const equipOptionsKey = JSON.stringify(item.options?.equipOptions || null);
    return item.item_def_id === mailItem.item_def_id && bindType === targetBindType && equipOptionsKey === targetEquipOptionsKey;
  });

  if (existing) {
    existing.qty += mailItem.qty;
    return;
  }
  result.pendingMailItems.push({
    item_def_id: mailItem.item_def_id,
    qty: mailItem.qty,
    ...(targetOptions ? { options: { ...targetOptions } } : {}),
  });
};

const mergeResult = (
  target: GrantRewardItemWithAutoDisassembleResult,
  source: GrantRewardItemWithAutoDisassembleResult
): void => {
  for (const item of source.grantedItems) {
    appendGrantedItem(target, item.itemDefId, item.qty, item.itemIds);
  }
  for (const mailItem of source.pendingMailItems) {
    appendPendingMailItem(target, mailItem);
  }
  if (source.gainedSilver > 0) {
    target.gainedSilver += source.gainedSilver;
  }
};

const createEmptyResult = (): GrantRewardItemWithAutoDisassembleResult => ({
  grantedItems: [],
  pendingMailItems: [],
  warnings: [],
  gainedSilver: 0,
});

const AUTO_DISASSEMBLE_EXCLUDED_SOURCES = new Set<string>([
  'task_reward',
  'main_quest',
]);

const normalizeSourceObtainedFrom = (sourceObtainedFrom: string): string => sourceObtainedFrom.trim().toLowerCase();

const shouldSkipAutoDisassembleBySource = (sourceObtainedFrom: string): boolean =>
  AUTO_DISASSEMBLE_EXCLUDED_SOURCES.has(normalizeSourceObtainedFrom(sourceObtainedFrom));

const isQualityName = (value: unknown): value is '黄' | '玄' | '地' | '天' => {
  return value === '黄' || value === '玄' || value === '地' || value === '天';
};

const toGenerateOptions = (raw: unknown): GenerateOptions => {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const record = raw as Record<string, unknown>;
  const out: GenerateOptions = {};

  if (isQualityName(record.quality)) {
    out.quality = record.quality;
  }

  if (record.qualityWeights && typeof record.qualityWeights === 'object' && !Array.isArray(record.qualityWeights)) {
    const inputWeights = record.qualityWeights as Record<string, unknown>;
    const weights: Partial<Record<'黄' | '玄' | '地' | '天', number>> = {};
    for (const [key, value] of Object.entries(inputWeights)) {
      if (!isQualityName(key)) continue;
      const n = Number(value);
      if (!Number.isFinite(n) || n <= 0) continue;
      weights[key] = n;
    }
    if (Object.keys(weights).length > 0) {
      out.qualityWeights = weights as Record<'黄' | '玄' | '地' | '天', number>;
    }
  }

  const realmRank = Number(record.realmRank);
  if (Number.isInteger(realmRank) && realmRank > 0) {
    out.realmRank = realmRank;
  }

  if (typeof record.identified === 'boolean') {
    out.identified = record.identified;
  }

  const bindType = String(record.bindType || '').trim();
  if (bindType) {
    out.bindType = bindType;
  }

  const obtainedFrom = String(record.obtainedFrom || '').trim();
  if (obtainedFrom) {
    out.obtainedFrom = obtainedFrom;
  }

  const seed = Number(record.seed);
  if (Number.isInteger(seed)) {
    out.seed = seed;
  }

  const fuyuan = Number(record.fuyuan);
  if (Number.isFinite(fuyuan) && fuyuan > 0) {
    out.fuyuan = fuyuan;
  }

  return out;
};

const buildEquipRollOptionsForAttempt = (raw: unknown, attemptIndex: number): GenerateOptions => {
  const normalized = toGenerateOptions(raw);
  if (Number.isInteger(normalized.seed)) return normalized;
  return {
    ...normalized,
    seed: Date.now() + attemptIndex * 7919 + Math.floor(Math.random() * 1000),
  };
};

/**
 * 批量发放自动分解产物，并在“整批入包失败”时按更小块重试。
 *
 * 作用：
 * 1. 优先用大批量写入吃掉可堆叠产物，减少逐件 createItem 的事务往返。
 * 2. 仅在背包空间不足时缩小批次，尽量保持“能进包的先进包，剩余走邮件”的既有结算语义。
 *
 * 不做：
 * 1. 不处理装备原始奖励的逐件随机生成。
 * 2. 不负责银两累加；银两仍由调用方统一处理。
 *
 * 输入 / 输出：
 * - 输入：自动分解后的单种产物定义与数量。
 * - 输出：成功时把结果写回 `result`；失败时返回首个非背包已满错误文案。
 *
 * 数据流 / 状态流：
 * reward qty -> 尝试整批 createItem -> 失败则二分缩小批次
 * -> 成功部分记入 grantedItems -> 最小批次仍满时剩余全部转邮件。
 *
 * 复用设计说明：
 * - 把“批量尝试 + 缩块重试”集中在自动分解服务内部，battleDrop/mail/mainQuest 等上层入口继续复用同一发奖边界。
 * - 同一规则同时覆盖功法书残页、材料分解等非装备产物，避免每条奖励链路各写一套容量探测逻辑。
 *
 * 关键边界条件与坑点：
 * 1. 仅对同一种产物做缩块，不能跨 itemDefId 混批，否则无法保证邮件补发与实例 ID 的归属正确。
 * 2. 当 `qty=1` 仍返回“背包已满”时，说明当前剩余产物都不可能继续入包，必须一次性转邮件，避免退化成 O(n) 次失败调用。
 */
const grantAutoDisassembleRewardItemInChunks = async (
  result: GrantRewardItemWithAutoDisassembleResult,
  createItem: GrantItemCreateFn,
  rewardItem: {
    itemDefId: string;
    qty: number;
  },
): Promise<{ success: boolean; message?: string }> => {
  let remainingQty = Math.max(0, Math.floor(rewardItem.qty));

  while (remainingQty > 0) {
    let attemptQty = remainingQty;
    let applied = false;

    while (attemptQty > 0) {
      const rewardCreateResult = await createItem({
        itemDefId: rewardItem.itemDefId,
        qty: attemptQty,
        obtainedFrom: 'auto_disassemble',
      });

      if (rewardCreateResult.success) {
        appendGrantedItem(result, rewardItem.itemDefId, attemptQty, normalizeItemIds(rewardCreateResult.itemIds));
        remainingQty -= attemptQty;
        applied = true;
        break;
      }

      if (rewardCreateResult.message !== '背包已满') {
        return {
          success: false,
          message: `自动分解奖励入包失败: ${rewardItem.itemDefId}, ${rewardCreateResult.message}`,
        };
      }

      if (attemptQty === 1) {
        appendPendingMailItem(result, {
          item_def_id: rewardItem.itemDefId,
          qty: remainingQty,
        });
        appendGrantedItem(result, rewardItem.itemDefId, remainingQty, []);
        remainingQty = 0;
        applied = true;
        break;
      }

      attemptQty = Math.floor(attemptQty / 2);
    }

    if (!applied) {
      return {
        success: false,
        message: `自动分解奖励入包失败: ${rewardItem.itemDefId}, 无法分配奖励数量`,
      };
    }
  }

  return { success: true };
};

const grantOriginalSourceItemBatch = async (
  result: GrantRewardItemWithAutoDisassembleResult,
  input: GrantRewardItemWithAutoDisassembleInput,
  qty: number,
): Promise<void> => {
  const createResult = await input.createItem({
    itemDefId: input.itemDefId,
    qty,
    ...(input.bindType ? { bindType: input.bindType } : {}),
    obtainedFrom: input.sourceObtainedFrom,
  });

  if (createResult.success) {
    appendGrantedItem(result, input.itemDefId, qty, normalizeItemIds(createResult.itemIds));
    return;
  }

  if (createResult.message === '背包已满') {
    appendPendingMailItem(result, {
      item_def_id: input.itemDefId,
      qty,
      ...(input.bindType ? { options: { bindType: input.bindType } } : {}),
    });
    appendGrantedItem(result, input.itemDefId, qty, []);
    return;
  }

  result.warnings.push(`物品创建失败: ${input.itemDefId}, ${createResult.message}`);
};

export const grantRewardItemWithAutoDisassemble = async (
  input: GrantRewardItemWithAutoDisassembleInput
): Promise<GrantRewardItemWithAutoDisassembleResult> => {
  const result = createEmptyResult();

  const normalizedQty = Math.max(0, Math.floor(input.qty));
  if (normalizedQty <= 0) return result;

  const category = String(input.itemMeta.category || '').trim();
  const subCategory = input.itemMeta.subCategory ?? null;
  const itemName = String(input.itemMeta.itemName || '').trim();
  const effectDefs = input.itemMeta.effectDefs;
  const baseQualityRank = (() => {
    const n = Number(input.itemMeta.qualityRank);
    if (Number.isInteger(n) && n > 0) return n;
    return 1;
  })();
  const canDisassemble = resolveItemCanDisassemble({
    disassemblable: input.itemMeta.disassemblable,
  });
  const allowAutoDisassemble =
    canDisassemble
    && input.autoDisassembleSetting.enabled
    && !shouldSkipAutoDisassembleBySource(input.sourceObtainedFrom);

  if (
    category !== 'equipment'
    && !allowAutoDisassemble
  ) {
    const createResult = await input.createItem({
      itemDefId: input.itemDefId,
      qty: normalizedQty,
      ...(input.bindType ? { bindType: input.bindType } : {}),
      obtainedFrom: input.sourceObtainedFrom,
      ...(input.sourceEquipOptions !== undefined ? { equipOptions: input.sourceEquipOptions } : {}),
    });

    if (createResult.success) {
      appendGrantedItem(result, input.itemDefId, normalizedQty, normalizeItemIds(createResult.itemIds));
      return result;
    }

    if (createResult.message === '背包已满') {
      const options =
        input.bindType || input.sourceEquipOptions
          ? {
              ...(input.bindType ? { bindType: input.bindType } : {}),
              ...(input.sourceEquipOptions ? { equipOptions: input.sourceEquipOptions } : {}),
            }
          : undefined;
      appendPendingMailItem(result, {
        item_def_id: input.itemDefId,
        qty: normalizedQty,
        ...(options ? { options } : {}),
      });
      appendGrantedItem(result, input.itemDefId, normalizedQty, []);
      return result;
    }

    result.warnings.push(`物品创建失败: ${input.itemDefId}, ${createResult.message}`);
    return result;
  }

  if (category !== 'equipment') {
    const candidateMeta: AutoDisassembleCandidateMeta = {
      itemName,
      category,
      subCategory,
      effectDefs,
      qualityRank: baseQualityRank,
    };

    if (!shouldAutoDisassembleBySetting(input.autoDisassembleSetting, candidateMeta)) {
      await grantOriginalSourceItemBatch(result, input, normalizedQty);
      return result;
    }

    const rewardPlan = buildDisassembleRewardPlan({
      category,
      subCategory,
      effectDefs,
      qualityRankRaw: baseQualityRank,
      strengthenLevelRaw: 0,
      refineLevelRaw: 0,
      affixesRaw: [],
      qty: normalizedQty,
    });
    if (!rewardPlan.success) {
      result.warnings.push(`自动分解规则计算失败: ${input.itemDefId}, ${rewardPlan.message}`);
      await grantOriginalSourceItemBatch(result, input, normalizedQty);
      return result;
    }

    const tempResult = createEmptyResult();
    for (const rewardItem of rewardPlan.rewards.items) {
      const chunkGrantResult = await grantAutoDisassembleRewardItemInChunks(
        tempResult,
        input.createItem,
        rewardItem,
      );
      if (!chunkGrantResult.success) {
        result.warnings.push(
          chunkGrantResult.message ?? `自动分解奖励入包失败: ${rewardItem.itemDefId}`,
        );
        await grantOriginalSourceItemBatch(result, input, normalizedQty);
        return result;
      }
    }

    if (rewardPlan.rewards.silver > 0) {
      if (!input.addSilver) {
        result.warnings.push(`自动分解银两发放失败: ${input.itemDefId}, 缺少addSilver实现`);
        await grantOriginalSourceItemBatch(result, input, normalizedQty);
        return result;
      }

      const addSilverResult = await input.addSilver(input.characterId, rewardPlan.rewards.silver);
      if (!addSilverResult.success) {
        result.warnings.push(`自动分解银两发放失败: ${input.itemDefId}, ${addSilverResult.message}`);
        await grantOriginalSourceItemBatch(result, input, normalizedQty);
        return result;
      }
      tempResult.gainedSilver += rewardPlan.rewards.silver;
    }

    mergeResult(result, tempResult);
    return result;
  }

  for (let i = 0; i < normalizedQty; i++) {
    let sourceEquipOptionsForCreate = input.sourceEquipOptions;
    let sourceEquipOptionsForMail = input.sourceEquipOptions;
    let generatedQualityRank = baseQualityRank;

    const createSourceItem = async () => {
      const sourceCreateResult = await input.createItem({
        itemDefId: input.itemDefId,
        qty: 1,
        ...(input.bindType ? { bindType: input.bindType } : {}),
        obtainedFrom: input.sourceObtainedFrom,
        ...(sourceEquipOptionsForCreate !== undefined ? { equipOptions: sourceEquipOptionsForCreate } : {}),
      });

      if (sourceCreateResult.success) {
        appendGrantedItem(result, input.itemDefId, 1, normalizeItemIds(sourceCreateResult.itemIds));
        return;
      }

      if (sourceCreateResult.message === '背包已满') {
        const options =
          input.bindType || sourceEquipOptionsForMail !== undefined
            ? {
                ...(input.bindType ? { bindType: input.bindType } : {}),
                ...(sourceEquipOptionsForMail !== undefined ? { equipOptions: sourceEquipOptionsForMail } : {}),
              }
            : undefined;
        appendPendingMailItem(result, {
          item_def_id: input.itemDefId,
          qty: 1,
          ...(options ? { options } : {}),
        });
        appendGrantedItem(result, input.itemDefId, 1, []);
        return;
      }

      result.warnings.push(`物品创建失败: ${input.itemDefId}, ${sourceCreateResult.message}`);
    };

    if (!allowAutoDisassemble) {
      await createSourceItem();
      continue;
    }

    /**
     * 装备品质由生成器最终决定，必须先做一次“预生成”拿到真实品质，
     * 才能进行自动分解判定；否则会用模板品质误判。
     */
    if (category === 'equipment') {
      const equipRollOptions = buildEquipRollOptionsForAttempt(input.sourceEquipOptions, i + 1);
      const generated = await generateEquipment(input.itemDefId, equipRollOptions);
      if (generated) {
        sourceEquipOptionsForMail = equipRollOptions;
        sourceEquipOptionsForCreate = {
          ...equipRollOptions,
          preGeneratedEquipment: generated,
        };
        generatedQualityRank = Number.isInteger(generated.qualityRank) && generated.qualityRank > 0
          ? generated.qualityRank
          : baseQualityRank;
      } else {
        result.warnings.push(`装备预生成失败: ${input.itemDefId}`);
        await createSourceItem();
        continue;
      }
    }

    const candidateMeta: AutoDisassembleCandidateMeta = {
      itemName,
      category,
      subCategory,
      effectDefs,
      qualityRank: generatedQualityRank,
    };

    if (!shouldAutoDisassembleBySetting(input.autoDisassembleSetting, candidateMeta)) {
      await createSourceItem();
      continue;
    }

    const rewardPlan = buildDisassembleRewardPlan({
      category,
      subCategory,
      effectDefs,
      qualityRankRaw: generatedQualityRank,
      strengthenLevelRaw: 0,
      refineLevelRaw: 0,
      affixesRaw: [],
      qty: 1,
    });
    if (!rewardPlan.success) {
      result.warnings.push(`自动分解规则计算失败: ${input.itemDefId}, ${rewardPlan.message}`);
      await createSourceItem();
      continue;
    }

    const tempResult = createEmptyResult();
    let rewardApplySuccess = true;

    for (const rewardItem of rewardPlan.rewards.items) {
      const rewardCreateResult = await input.createItem({
        itemDefId: rewardItem.itemDefId,
        qty: rewardItem.qty,
        obtainedFrom: 'auto_disassemble',
      });

      if (rewardCreateResult.success) {
        appendGrantedItem(tempResult, rewardItem.itemDefId, rewardItem.qty, normalizeItemIds(rewardCreateResult.itemIds));
        continue;
      }

      if (rewardCreateResult.message === '背包已满') {
        appendPendingMailItem(tempResult, {
          item_def_id: rewardItem.itemDefId,
          qty: rewardItem.qty,
        });
        appendGrantedItem(tempResult, rewardItem.itemDefId, rewardItem.qty, []);
        continue;
      }

      rewardApplySuccess = false;
      result.warnings.push(`自动分解奖励入包失败: ${rewardItem.itemDefId}, ${rewardCreateResult.message}`);
      break;
    }

    if (rewardApplySuccess && rewardPlan.rewards.silver > 0) {
      if (!input.addSilver) {
        rewardApplySuccess = false;
        result.warnings.push(`自动分解银两发放失败: ${input.itemDefId}, 缺少addSilver实现`);
      } else {
        const addSilverResult = await input.addSilver(input.characterId, rewardPlan.rewards.silver);
        if (!addSilverResult.success) {
          rewardApplySuccess = false;
          result.warnings.push(`自动分解银两发放失败: ${input.itemDefId}, ${addSilverResult.message}`);
        } else {
          tempResult.gainedSilver += rewardPlan.rewards.silver;
        }
      }
    }

    if (!rewardApplySuccess) {
      await createSourceItem();
      continue;
    }

    mergeResult(result, tempResult);
  }

  return result;
};
