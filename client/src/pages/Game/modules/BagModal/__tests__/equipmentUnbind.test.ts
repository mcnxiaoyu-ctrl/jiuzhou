/**
 * 装备解绑前端共享规则测试
 *
 * 作用（做什么 / 不做什么）：
 * - 做什么：验证绑定文案统一映射，以及“解绑道具目标候选”筛选逻辑。
 * - 不做什么：不渲染真实 Modal / Sheet，不覆盖背包页面完整交互。
 *
 * 输入/输出：
 * - 输入：`bind_type` 原始值、最小化 BagItem 列表、道具 effect_defs。
 * - 输出：统一绑定展示结果、解绑目标类型、候选装备列表。
 *
 * 数据流/状态流：
 * - 测试直接调用纯函数；
 * - 断言前端 ViewModel 不再区分拾绑/装绑展示。
 *
 * 关键边界条件与坑点：
 * 1) 任何已绑定类型都必须收敛成“已绑定”，否则 Bag/Market 会继续出现多套文案。
 * 2) 候选装备只能包含已绑定装备，普通材料和未绑定装备都必须排除。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveItemBindMeta } from '../../../shared/itemBind';
import {
  collectEquipmentUnbindCandidates,
  resolveBagItemUseTargetType,
} from '../equipmentUnbind';

test('pickup 与 equip 绑定类型前端都应统一显示为已绑定', () => {
  const pickup = resolveItemBindMeta('pickup');
  const equip = resolveItemBindMeta('equip');

  assert.equal(pickup.detailLabel, '已绑定');
  assert.equal(pickup.cellBadgeLabel, '绑定');
  assert.equal(equip.detailLabel, '已绑定');
  assert.equal(equip.cellBadgeLabel, '绑定');
});

test('解绑道具应识别为需要选择已绑定装备目标', () => {
  const useTargetType = resolveBagItemUseTargetType({
    use_type: 'target',
    effect_defs: [
      {
        trigger: 'use',
        effect_type: 'unbind',
        params: {
          target_type: 'equipment',
          bind_state: 'bound',
        },
      },
    ],
  });

  assert.equal(useTargetType, 'boundEquipment');
});

test('易名符应识别为角色改名交互道具', () => {
  const useTargetType = resolveBagItemUseTargetType({
    use_type: null,
    effect_defs: [
      {
        trigger: 'use',
        target: 'self',
        effect_type: 'rename_character',
      },
    ],
  });

  assert.equal(useTargetType, 'characterRename');
});

test('归元洗髓露应识别为只能在伙伴详情页使用的交互道具', () => {
  const useTargetType = resolveBagItemUseTargetType({
    use_type: 'target',
    effect_defs: [
      {
        trigger: 'use',
        target: 'partner',
        effect_type: 'reroll_partner_base_attrs',
      },
    ],
  });

  assert.equal(useTargetType, 'partnerDetailOnly');
});

test('解绑候选列表只应包含已绑定装备', () => {
  const candidates = collectEquipmentUnbindCandidates([
    {
      id: 1,
      name: '未绑定长剑',
      quality: '黄',
      bind: { isBound: false },
      category: 'equipment',
      locked: false,
      location: 'bag',
      equip: { equipSlot: 'weapon', strengthenLevel: 0, refineLevel: 0 },
    },
    {
      id: 2,
      name: '已绑定护腕',
      quality: '玄',
      bind: { isBound: true },
      category: 'equipment',
      locked: false,
      location: 'bag',
      equip: { equipSlot: 'gloves', strengthenLevel: 3, refineLevel: 1 },
    },
    {
      id: 3,
      name: '已绑定丹药',
      quality: '黄',
      bind: { isBound: true },
      category: 'consumable',
      locked: false,
      location: 'bag',
      equip: null,
    },
  ]);

  assert.deepEqual(
    candidates.map((item) => item.id),
    [2],
  );
});
