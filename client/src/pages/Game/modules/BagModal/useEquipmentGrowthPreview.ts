/**
 * 装备成长预览 Hook（强化/精炼）
 *
 * 作用（做什么 / 不做什么）：
 * - 做：统一从后端获取装备强化/精炼下一次成长的消耗、成功率、属性预览，并组装成 UI 可直接使用的状态。
 * - 不做：不发起强化/精炼实际操作，不处理洗炼/镶嵌，不做本地成本/属性公式兜底。
 *
 * 输入/输出：
 * - 输入：当前选中装备 `item`、背包物品列表 `allItems`、是否启用预览 `enabled`。
 * - 输出：`enhanceState`、`refineState`、`loading`。
 *
 * 数据流/状态流：
 * - item/enabled 变化 -> 请求 `/inventory/growth/cost-preview` -> 存储后端预览 -> 结合本地背包数量和名称映射 -> 输出成长状态。
 *
 * 关键边界条件与坑点：
 * 1) `item` 不是装备或未启用时，必须清空预览状态，避免展示上一个装备的旧数据。
 * 2) 接口失败时返回 `null` 状态，不在前端回退到本地公式，确保成长规则单一来源在后端。
 */
import { useEffect, useMemo, useState } from 'react';
import {
  getInventoryGrowthCostPreview,
  type InventoryGrowthCostPreviewResponse,
} from '../../../../services/api';
import { type BagItem } from './bagShared';

type GrowthCostPreviewData = NonNullable<InventoryGrowthCostPreviewResponse['data']>;
type GrowthMode = 'enhance' | 'refine';
export type EquipmentGrowthFailMode = 'none' | 'downgrade' | 'destroy';

export interface EquipmentGrowthStageState {
  curLv: number;
  targetLv: number;
  maxLv: number | null;
  materialItemDefId: string | null;
  materialName: string;
  materialQty: number;
  owned: number;
  silverCost: number;
  spiritStoneCost: number;
  successRate: number;
  failMode: EquipmentGrowthFailMode;
  previewBaseAttrs: Record<string, number>;
}

export const getEquipmentGrowthFailModeText = (
  failMode: EquipmentGrowthFailMode,
): string => {
  if (failMode === 'destroy') return '失败碎装';
  if (failMode === 'downgrade') return '失败掉级';
  return '';
};

interface UseEquipmentGrowthPreviewOptions {
  item: BagItem | null;
  allItems: BagItem[];
  enabled: boolean;
}

const buildMaterialNameByDefId = (allItems: BagItem[]): Record<string, string> => {
  const nameByDefId: Record<string, string> = {};
  for (const it of allItems) {
    if (!it.itemDefId || !it.name) continue;
    if (nameByDefId[it.itemDefId]) continue;
    nameByDefId[it.itemDefId] = it.name;
  }
  return nameByDefId;
};

const buildMaterialCountByDefId = (allItems: BagItem[]): Record<string, number> => {
  const countByDefId: Record<string, number> = {};
  for (const it of allItems) {
    if (it.location !== 'bag') continue;
    if (it.category !== 'material') continue;
    countByDefId[it.itemDefId] = (countByDefId[it.itemDefId] ?? 0) + Math.max(0, Math.floor(it.qty));
  }
  return countByDefId;
};

const buildStageState = (
  mode: GrowthMode,
  previewData: GrowthCostPreviewData,
  materialCountByDefId: Record<string, number>,
  materialNameByDefId: Record<string, string>,
): EquipmentGrowthStageState => {
  const source = mode === 'enhance' ? previewData.enhance : previewData.refine;
  const costs = source.costs;
  const materialItemDefId = costs?.materialItemDefId ?? null;
  const materialQty = costs?.materialQty ?? 0;
  const silverCost = costs?.silverCost ?? 0;
  const spiritStoneCost = costs?.spiritStoneCost ?? 0;
  const materialName =
    materialItemDefId === null
      ? ''
      : costs?.materialName ?? materialNameByDefId[materialItemDefId] ?? materialItemDefId;
  const owned = materialItemDefId === null ? 0 : (materialCountByDefId[materialItemDefId] ?? 0);
  return {
    curLv: source.currentLevel,
    targetLv: source.targetLevel,
    maxLv: source.maxLevel,
    materialItemDefId,
    materialName,
    materialQty,
    owned,
    silverCost,
    spiritStoneCost,
    successRate: source.successRate,
    failMode: source.failMode,
    previewBaseAttrs: source.previewBaseAttrs,
  };
};

export const useEquipmentGrowthPreview = ({
  item,
  allItems,
  enabled,
}: UseEquipmentGrowthPreviewOptions): {
  enhanceState: EquipmentGrowthStageState | null;
  refineState: EquipmentGrowthStageState | null;
  loading: boolean;
} => {
  const [previewData, setPreviewData] = useState<GrowthCostPreviewData | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!enabled || !item || item.category !== 'equipment' || !item.equip) {
      setPreviewData(null);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    getInventoryGrowthCostPreview({ itemId: item.id })
      .then((res) => {
        if (cancelled) return;
        if (res.success && res.data) {
          setPreviewData(res.data);
        } else {
          setPreviewData(null);
        }
      })
      .catch(() => {
        if (cancelled) return;
        setPreviewData(null);
      })
      .finally(() => {
        if (cancelled) return;
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [enabled, item?.id, item?.category, item?.equip]);

  const materialCountByDefId = useMemo(
    () => buildMaterialCountByDefId(allItems),
    [allItems],
  );
  const materialNameByDefId = useMemo(
    () => buildMaterialNameByDefId(allItems),
    [allItems],
  );

  const enhanceState = useMemo(() => {
    if (!item || item.category !== 'equipment' || !item.equip || !previewData) {
      return null;
    }
    return buildStageState(
      'enhance',
      previewData,
      materialCountByDefId,
      materialNameByDefId,
    );
  }, [item, previewData, materialCountByDefId, materialNameByDefId]);

  const refineState = useMemo(() => {
    if (!item || item.category !== 'equipment' || !item.equip || !previewData) {
      return null;
    }
    return buildStageState(
      'refine',
      previewData,
      materialCountByDefId,
      materialNameByDefId,
    );
  }, [item, previewData, materialCountByDefId, materialNameByDefId]);

  return { enhanceState, refineState, loading };
};
