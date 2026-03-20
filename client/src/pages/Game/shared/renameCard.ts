/**
 * 易名符前端共享语义模块
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：集中识别一个物品定义或背包实例是否具备“易名符”语义，供背包与伙伴改名入口共用。
 * 2. 做什么：提供“从背包列表中找到第一张易名符实例”的纯函数，避免多个界面重复遍历 `effect_defs`。
 * 3. 不做什么：不发请求、不管理弹窗状态，也不决定改名目标是角色还是伙伴。
 *
 * 输入/输出：
 * - 输入：轻量物品定义，或背包物品列表。
 * - 输出：是否为易名符，以及首个可用易名符实例。
 *
 * 数据流/状态流：
 * 背包/伙伴页拿到 inventory DTO -> 本模块识别 `rename_character` 效果 -> UI 决定是否打开改名弹窗。
 *
 * 关键边界条件与坑点：
 * 1. 只认显式 `effect_type = rename_character`，不能只看名称叫“易名符”。
 * 2. 查找实例时必须过滤 `qty > 0`，避免把已被扣空但列表未刷新的脏数据当成可用道具。
 */
import type { InventoryItemDto, ItemDefLite } from '../../../services/api';

type EffectDef = Record<string, unknown>;

const coerceEffectDefs = (value: unknown): EffectDef[] => {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (entry): entry is EffectDef =>
      Boolean(entry) && typeof entry === 'object' && !Array.isArray(entry),
  );
};

export const isRenameCardItemDefinitionLike = (
  def: Pick<ItemDefLite, 'effect_defs'> | null | undefined,
): boolean => {
  if (!def) return false;

  for (const effect of coerceEffectDefs(def.effect_defs)) {
    if (String(effect.trigger || '').trim() !== 'use') continue;
    if (String(effect.effect_type || '').trim() !== 'rename_character') continue;
    return true;
  }

  return false;
};

export const findRenameCardInventoryItem = (
  items: readonly InventoryItemDto[],
): InventoryItemDto | null => {
  return items.find((item) => {
    return (Number(item.qty) || 0) > 0 && isRenameCardItemDefinitionLike(item.def);
  }) ?? null;
};
