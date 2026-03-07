/**
 * itemService.createItem 普通物品事务入口回归测试
 *
 * 作用（做什么 / 不做什么）：
 * - 做什么：验证普通物品创建会复用 inventoryService 这个带 @Transactional 的统一入口。
 * - 不做什么：不触达真实数据库、不覆盖装备生成分支的完整词条生成流程。
 *
 * 输入/输出：
 * - 输入：真实存在的普通物品定义 ID、角色/用户 ID，以及对 inventoryService/equipmentService 的方法 mock。
 * - 输出：createItem 返回值，以及底层领域服务的调用次数和参数。
 *
 * 数据流/状态流：
 * - itemService.createItem 先读取静态物品定义；
 * - 命中普通物品分类后，必须转交给 inventoryService.addItemToInventory；
 * - 测试通过 mock 记录调用，确保不会再绕到底层 bag 函数或装备实例创建入口。
 *
 * 关键边界条件与坑点：
 * 1) 这里只验证“普通物品走事务服务入口”，因为线上报错正是普通物品奖励在背包锁处缺失事务上下文。
 * 2) 使用真实种子里的 `cons-001` 避免再为物品定义引入额外 mock，减少测试和生产实现的耦合。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { equipmentService } from '../equipmentService.js';
import { itemService } from '../itemService.js';
import { inventoryService } from '../inventory/service.js';

test('普通物品创建应复用 inventoryService 事务入口', async (t) => {
  type AddItemArgs = Parameters<typeof inventoryService.addItemToInventory>;
  const inventoryMock = t.mock.method(
    inventoryService,
    'addItemToInventory',
    async (..._args: AddItemArgs) => {
      return {
        success: true,
        message: 'ok',
        itemIds: [901, 902, 903],
      };
    },
  );
  const equipmentMock = t.mock.method(
    equipmentService,
    'createEquipmentInstance',
    async () => {
      throw new Error('普通物品创建不应调用装备实例入口');
    },
  );

  const result = await itemService.createItem(1001, 2002, 'cons-001', 3, {
    location: 'bag',
    bindType: 'bound',
    obtainedFrom: 'battle_drop',
  });

  assert.deepEqual(result, {
    success: true,
    message: 'ok',
    itemIds: [901, 902, 903],
  });
  assert.equal(inventoryMock.mock.callCount(), 1);
  assert.equal(equipmentMock.mock.callCount(), 0);
  assert.deepEqual(inventoryMock.mock.calls[0]?.arguments, [
    2002,
    1001,
    'cons-001',
    3,
    {
      location: 'bag',
      bindType: 'bound',
      obtainedFrom: 'battle_drop',
    },
  ]);
});
