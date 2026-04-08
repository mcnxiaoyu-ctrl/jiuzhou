/**
 * 邮件附件预览统一出口。
 *
 * 作用：把旧附件、通用奖励、实例附件收敛成同一份 `GrantedRewardPreviewResult[]`；不负责真实发奖与数据库读取。
 * 输入/输出：输入邮件附件原始字段与实例预览条目，输出前端可直接展示的附件预览。
 * 数据流：mailService.getMailList -> 本模块 -> buildGrantedRewardPreview -> MailModal。
 * 复用说明：前端继续只消费 `attachRewards`，避免把实例附件判定复制到多个 UI 分支。
 * 边界条件：1) `attachRewards` 优先级最高；2) 实例附件预览只暴露 `itemDefId + quantity`，不扩散实例细节。
 */

import {
  buildGrantedRewardPreview,
  hasGrantedRewardPayload,
  normalizeGrantedRewardPayload,
  type GrantedRewardItemPayload,
  type GrantedRewardPreviewResult,
} from './rewardPayload.js';

type MailAttachmentPreviewItem = {
  item_def_id: string;
  item_name?: string;
  qty: number;
};

export type MailInstanceAttachmentPreviewItem = {
  itemDefId: string;
  quantity: number;
};

const normalizeLegacyAttachmentItems = (
  items: readonly MailAttachmentPreviewItem[],
): GrantedRewardItemPayload[] => {
  const normalized: GrantedRewardItemPayload[] = [];
  for (const item of items) {
    const itemDefId = String(item.item_def_id || '').trim();
    const quantity = Math.max(0, Math.floor(Number(item.qty) || 0));
    const itemName = String(item.item_name || '').trim();
    if (!itemDefId || quantity <= 0) {
      continue;
    }
    normalized.push({
      itemDefId,
      quantity,
      ...(itemName ? { itemName } : {}),
    });
  }
  return normalized;
};

const normalizeInstanceAttachmentItems = (
  items: readonly MailInstanceAttachmentPreviewItem[],
): GrantedRewardItemPayload[] => {
  const normalized: GrantedRewardItemPayload[] = [];
  for (const item of items) {
    const itemDefId = String(item.itemDefId || '').trim();
    const quantity = Math.max(0, Math.floor(Number(item.quantity) || 0));
    if (!itemDefId || quantity <= 0) {
      continue;
    }
    normalized.push({ itemDefId, quantity });
  }
  return normalized;
};

export const buildMailAttachmentPreviewRewards = (input: {
  attachSilver: number;
  attachSpiritStones: number;
  attachItems: readonly MailAttachmentPreviewItem[];
  attachRewardsRaw: unknown;
  attachInstanceItems?: readonly MailInstanceAttachmentPreviewItem[];
}): GrantedRewardPreviewResult[] => {
  const normalizedAttachRewards = normalizeGrantedRewardPayload(input.attachRewardsRaw);
  if (hasGrantedRewardPayload(normalizedAttachRewards)) {
    return buildGrantedRewardPreview(normalizedAttachRewards);
  }

  const items = [
    ...normalizeLegacyAttachmentItems(input.attachItems),
    ...normalizeInstanceAttachmentItems(input.attachInstanceItems ?? []),
  ];

  return buildGrantedRewardPreview({
    silver: Math.max(0, Math.floor(Number(input.attachSilver) || 0)),
    spiritStones: Math.max(0, Math.floor(Number(input.attachSpiritStones) || 0)),
    ...(items.length > 0 ? { items } : {}),
  });
};
