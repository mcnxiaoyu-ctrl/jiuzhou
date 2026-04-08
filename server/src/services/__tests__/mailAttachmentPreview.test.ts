import assert from 'node:assert/strict';
import test from 'node:test';

import { buildMailAttachmentPreviewRewards } from '../shared/mailAttachmentPreview.js';

test('实例附件应转换为邮件预览奖励，避免前端误判为无附件', () => {
  const rewards = buildMailAttachmentPreviewRewards({
    attachSilver: 0,
    attachSpiritStones: 0,
    attachItems: [],
    attachRewardsRaw: null,
    attachInstanceItems: [
      {
        itemDefId: 'iron_sword',
        quantity: 1,
      },
    ],
  });

  assert.deepEqual(rewards, [
    {
      type: 'item',
      itemDefId: 'iron_sword',
      quantity: 1,
      itemName: 'iron_sword',
      itemIcon: undefined,
    },
  ]);
});

test('通用奖励存在时应保持原预览优先级，不与实例附件混合', () => {
  const rewards = buildMailAttachmentPreviewRewards({
    attachSilver: 0,
    attachSpiritStones: 0,
    attachItems: [],
    attachRewardsRaw: {
      silver: 88,
    },
    attachInstanceItems: [
      {
        itemDefId: 'iron_sword',
        quantity: 1,
      },
    ],
  });

  assert.deepEqual(rewards, [
    {
      type: 'silver',
      amount: 88,
    },
  ]);
});
