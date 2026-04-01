/**
 * 交互型道具使用目标前端共享规则
 *
 * 作用（做什么 / 不做什么）：
 * - 做什么：集中解析“哪些道具在使用前还需要额外交互”，目前覆盖装备解绑、易名符改名与归元洗髓露的伙伴页专用入口。
 * - 做什么：提供可解绑装备候选列表筛选函数，避免桌面端和移动端背包各写一套判断。
 * - 不做什么：不发请求、不管理弹窗状态、不渲染具体桌面/移动端 UI。
 *
 * 输入/输出：
 * - 输入：物品定义的 `use_type/effect_defs`，以及背包页使用的 `BagItem` 样式对象列表。
 * - 输出：`BagItemUseTargetType` 与可解绑装备候选列表。
 *
 * 数据流/状态流：
 * - `buildBagItem` 调用 `resolveBagItemUseTargetType` 生成 ViewModel；
 * - BagModal / MobileBagModal 根据类型决定是开改名弹窗，还是开解绑目标选择。
 *
 * 关键边界条件与坑点：
 * 1) 易名符没有走通用 `/inventory/use`，因此必须在这里先识别出来，避免 UI 误发普通使用请求。
 * 2) 装备解绑候选列表只保留“已绑定装备且未锁定”的实例，避免 UI 与后端校验口径不一致。
 */
import type { ItemDefLite, InventoryLocation } from '../../../../services/api';
import { isRenameCardItemDefinitionLike } from '../../shared/renameCard';
import { isPartnerReboneElixirItemDefinitionLike } from '../../shared/partnerReboneElixir';

export type BagItemUseTargetType = 'none' | 'boundEquipment' | 'characterRename' | 'partnerDetailOnly';

type EffectDef = Record<string, unknown>;

type EquipmentUnbindCandidateLike = {
  id: number;
  name: string;
  quality: string;
  category: string;
  locked: boolean;
  location: InventoryLocation;
  bind: { isBound: boolean };
  equip: {
    equipSlot: string | null;
    strengthenLevel: number;
    refineLevel: number;
  } | null;
};

const coerceEffectDefs = (value: unknown): EffectDef[] => {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (entry): entry is EffectDef =>
      Boolean(entry) && typeof entry === 'object' && !Array.isArray(entry),
  );
};

export const resolveBagItemUseTargetType = (
  def: Pick<ItemDefLite, 'use_type' | 'effect_defs'> | null | undefined,
): BagItemUseTargetType => {
  if (!def) return 'none';
  const effectDefs = coerceEffectDefs(def.effect_defs);

  if (isRenameCardItemDefinitionLike(def)) {
    return 'characterRename';
  }

  if (isPartnerReboneElixirItemDefinitionLike(def)) {
    return 'partnerDetailOnly';
  }

  if (String(def.use_type || '').trim() !== 'target') return 'none';
  for (const effect of effectDefs) {
    if (String(effect.trigger || '').trim() !== 'use') continue;
    if (String(effect.effect_type || '').trim() !== 'unbind') continue;
    const params =
      effect.params && typeof effect.params === 'object' && !Array.isArray(effect.params)
        ? (effect.params as Record<string, unknown>)
        : null;
    if (String(params?.target_type || '').trim() !== 'equipment') continue;
    if (String(params?.bind_state || '').trim() !== 'bound') continue;
    return 'boundEquipment';
  }
  return 'none';
};

export const collectEquipmentUnbindCandidates = <T extends EquipmentUnbindCandidateLike>(
  items: readonly T[],
): T[] => {
  return items.filter((item) => {
    if (item.category !== 'equipment') return false;
    if (!item.equip) return false;
    if (item.locked) return false;
    return item.bind.isBound;
  });
};
