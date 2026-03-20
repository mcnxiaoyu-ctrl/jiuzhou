/**
 * 易名符前端语义模块测试
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：锁定前端对易名符 effect 语义的识别方式，避免伙伴页与背包页各写一套判断。
 * 2. 做什么：验证背包实例查找会返回首个可用易名符，保证改名入口总能拿到正确实例 ID。
 * 3. 不做什么：不发请求，不覆盖改名弹窗或接口提交流程。
 *
 * 输入/输出：
 * - 输入：轻量物品定义与背包实例列表。
 * - 输出：是否为易名符，以及首个可用易名符实例。
 *
 * 数据流/状态流：
 * inventory DTO -> `isRenameCardItemDefinitionLike` / `findRenameCardInventoryItem` -> 背包与伙伴页消费。
 *
 * 关键边界条件与坑点：
 * 1. 识别必须基于 `effect_type`，不能退回只看物品名称。
 * 2. `qty <= 0` 的实例不能被当成可用易名符，否则 UI 会拿到一张实际上已耗尽的卡。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import type { InventoryItemDto } from '../../../../services/api';
import {
  findRenameCardInventoryItem,
  isRenameCardItemDefinitionLike,
} from '../renameCard';

const createInventoryItem = (params: {
  id: number;
  qty: number;
  effectType?: string;
}): InventoryItemDto => ({
  id: params.id,
  item_def_id: `item-${params.id}`,
  qty: params.qty,
  location: 'bag',
  location_slot: params.id,
  equipped_slot: null,
  strengthen_level: 0,
  refine_level: 0,
  affixes: [],
  identified: true,
  locked: false,
  bind_type: 'none',
  created_at: new Date().toISOString(),
  def: {
    id: `item-${params.id}`,
    name: params.effectType === 'rename_character' ? '易名符' : '普通道具',
    icon: null,
    quality: '黄',
    category: 'consumable',
    sub_category: 'function',
    can_disassemble: false,
    stack_max: 9999,
    description: null,
    long_desc: null,
    tags: [],
    effect_defs: params.effectType
      ? [{ trigger: 'use', effect_type: params.effectType }]
      : [],
    base_attrs: [],
    equip_slot: null,
    use_type: 'self',
  },
});

test('isRenameCardItemDefinitionLike: 应识别 rename_character 效果', () => {
  assert.equal(
    isRenameCardItemDefinitionLike({
      effect_defs: [{ trigger: 'use', effect_type: 'rename_character' }],
    }),
    true,
  );
  assert.equal(
    isRenameCardItemDefinitionLike({
      effect_defs: [{ trigger: 'use', effect_type: 'resource' }],
    }),
    false,
  );
});

test('findRenameCardInventoryItem: 应返回首个数量大于 0 的易名符实例', () => {
  const result = findRenameCardInventoryItem([
    createInventoryItem({ id: 1, qty: 0, effectType: 'rename_character' }),
    createInventoryItem({ id: 2, qty: 3, effectType: 'resource' }),
    createInventoryItem({ id: 3, qty: 1, effectType: 'rename_character' }),
  ]);

  assert.equal(result?.id, 3);
});
