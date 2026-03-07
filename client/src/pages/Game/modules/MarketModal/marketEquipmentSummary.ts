import { parseSocketedGems, type SocketedGemEntry } from '../../shared/socketedGemDisplay';

/**
 * 作用：
 * - 统一生成坊市列表里“装备成长摘要”文案，避免桌面表格和移动端卡片各自重复拼接强化/精炼/宝石数量。
 * - 不做什么：不负责 UI 渲染、不做 Tooltip 明细展示、不校正后端装备业务规则，只输出列表摘要所需的最小结构。
 *
 * 输入/输出：
 * - 输入：装备类别、强化等级、精炼等级、已镶嵌宝石原始数据。
 * - 输出：稳定顺序的摘要项数组，供坊市列表直接渲染。
 *
 * 数据流/状态流：
 * - `MarketModal` 的 `ListingItem` 把自身装备字段传入本模块。
 * - 本模块复用 `parseSocketedGems` 统计有效宝石数量，再返回统一摘要项给桌面和移动端列表。
 *
 * 边界条件与坑点：
 * 1. 只有 `category = equipment` 才输出摘要，避免普通物品额外占位。
 * 2. 宝石数量必须走共享解析逻辑统计，不能直接拿原始数组长度，避免脏数据把列表数量算错。
 */

export type MarketEquipmentSummaryInput = {
  category: string | null;
  strengthenLevel: number;
  refineLevel: number;
  socketedGems?: string | SocketedGemEntry[] | null;
};

export type MarketEquipmentSummaryItem = {
  key: 'strengthen' | 'refine' | 'gems';
  text: string;
};

const normalizeLevel = (value: number): number => {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.floor(value));
};

const normalizeCategory = (value: string | null): string => {
  return String(value ?? '').trim().toLowerCase();
};

export const buildMarketEquipmentSummary = (
  input: MarketEquipmentSummaryInput,
): MarketEquipmentSummaryItem[] => {
  if (normalizeCategory(input.category) !== 'equipment') {
    return [];
  }

  const strengthenLevel = normalizeLevel(input.strengthenLevel);
  const refineLevel = normalizeLevel(input.refineLevel);
  const gemCount = parseSocketedGems(input.socketedGems).length;
  const items: MarketEquipmentSummaryItem[] = [];

  if (strengthenLevel > 0) {
    items.push({ key: 'strengthen', text: `强化+${strengthenLevel}` });
  }
  if (refineLevel > 0) {
    items.push({ key: 'refine', text: `精炼+${refineLevel}` });
  }
  if (gemCount > 0) {
    items.push({ key: 'gems', text: `宝石${gemCount}` });
  }

  return items;
};
