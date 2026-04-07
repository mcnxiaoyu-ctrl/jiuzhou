/**
 * 伙伴打书待处理预览存储模块
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：集中读取 `item_instance.location = 'partner_preview'` 的待处理预览书，并统一解析 metadata 里的伙伴打书预览状态。
 * 2. 做什么：提供按伙伴实例批量清理预览书的单一入口，供伙伴总览自愈、坊市交易、伙伴删除等链路复用。
 * 3. 不做什么：不判断伙伴功法替换是否合法，不构建预览 DTO，也不处理背包拆堆逻辑。
 *
 * 输入/输出：
 * - 输入：角色 ID、是否加锁、待清理的伙伴 ID / 预览书实例 ID。
 * - 输出：预览书行与其解析状态，或已删除的预览书实例 ID 列表。
 *
 * 数据流/状态流：
 * item_instance(partner_preview) -> 本模块查询/解析 -> partnerService / partnerMarketService / partnerFusionService 消费。
 *
 * 复用设计说明：
 * - 待处理预览是“伙伴 -> 预览书实例”的跨模块引用，集中后总览自愈、上架校验和伙伴转移/删除只维护一套读取与清理逻辑。
 * - 伙伴 ID 关联删除属于高频变化点，放在共享层后，后续新增“销毁伙伴”“回收伙伴”等入口也能直接复用。
 *
 * 关键边界条件与坑点：
 * 1. metadata 解析失败时只能把状态标记为 `null` 交给上层决定如何处理，不能在这里擅自吞掉整条记录。
 * 2. 删除必须限定 `owner_character_id`，防止跨角色误删别人的待处理预览书。
 */
import { query } from '../../config/database.js';
import {
  PARTNER_TECHNIQUE_PREVIEW_ITEM_LOCATION,
  readPartnerTechniqueLearnPreviewState,
  type PartnerTechniqueLearnPreviewState,
} from './partnerTechniqueLearnPreviewState.js';

export type PartnerTechniqueLearnPreviewItemRow = {
  id: number;
  item_def_id: string;
  qty: number;
  location: string;
  location_slot: number | null;
  metadata: object | null;
};

export type PartnerTechniqueLearnPreviewRecord = {
  row: PartnerTechniqueLearnPreviewItemRow;
  state: PartnerTechniqueLearnPreviewState | null;
};

const normalizeInteger = (value: number | string | bigint | null | undefined): number => {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 0;
};

export const loadPartnerTechniqueLearnPreviewRecords = async (params: {
  characterId: number;
  forUpdate: boolean;
}): Promise<PartnerTechniqueLearnPreviewRecord[]> => {
  const lockSql = params.forUpdate ? 'FOR UPDATE' : '';
  const result = await query(
    `
      SELECT id, item_def_id, qty, location, location_slot, metadata
      FROM item_instance
      WHERE owner_character_id = $1
        AND location = $2
      ORDER BY created_at ASC, id ASC
      ${lockSql}
    `,
    [params.characterId, PARTNER_TECHNIQUE_PREVIEW_ITEM_LOCATION],
  );

  return (result.rows as PartnerTechniqueLearnPreviewItemRow[]).map((row) => ({
    row,
    state: readPartnerTechniqueLearnPreviewState(row.metadata),
  }));
};

export const hasPendingPartnerTechniqueLearnPreviewForPartner = async (params: {
  characterId: number;
  partnerId: number;
  forUpdate: boolean;
}): Promise<boolean> => {
  const normalizedPartnerId = normalizeInteger(params.partnerId);
  if (normalizedPartnerId <= 0) return false;

  const records = await loadPartnerTechniqueLearnPreviewRecords(params);
  return records.some((record) => record.state?.partnerId === normalizedPartnerId);
};

export const deletePartnerTechniqueLearnPreviewItemsByIds = async (params: {
  characterId: number;
  itemInstanceIds: number[];
}): Promise<number[]> => {
  const normalizedItemIds = [...new Set(
    params.itemInstanceIds
      .map((itemInstanceId) => normalizeInteger(itemInstanceId))
      .filter((itemInstanceId) => itemInstanceId > 0),
  )];
  if (normalizedItemIds.length <= 0) {
    return [];
  }

  const result = await query(
    `
      DELETE FROM item_instance
      WHERE owner_character_id = $1
        AND id = ANY($2::int[])
        AND location = $3
      RETURNING id
    `,
    [params.characterId, normalizedItemIds, PARTNER_TECHNIQUE_PREVIEW_ITEM_LOCATION],
  );
  return result.rows.map((row) => normalizeInteger(row.id)).filter((id) => id > 0);
};

export const clearPendingPartnerTechniqueLearnPreviewByPartnerIds = async (params: {
  characterId: number;
  partnerIds: number[];
  forUpdate: boolean;
}): Promise<number[]> => {
  const normalizedPartnerIds = new Set(
    params.partnerIds
      .map((partnerId) => normalizeInteger(partnerId))
      .filter((partnerId) => partnerId > 0),
  );
  if (normalizedPartnerIds.size <= 0) {
    return [];
  }

  const records = await loadPartnerTechniqueLearnPreviewRecords({
    characterId: params.characterId,
    forUpdate: params.forUpdate,
  });
  const matchedItemIds = records
    .filter((record) => {
      const partnerId = record.state?.partnerId ?? 0;
      return normalizedPartnerIds.has(partnerId);
    })
    .map((record) => normalizeInteger(record.row.id))
    .filter((itemInstanceId) => itemInstanceId > 0);

  return deletePartnerTechniqueLearnPreviewItemsByIds({
    characterId: params.characterId,
    itemInstanceIds: matchedItemIds,
  });
};
