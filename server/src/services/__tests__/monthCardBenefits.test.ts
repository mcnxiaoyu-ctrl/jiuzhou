/**
 * 月卡激活态共享查询测试
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：锁定批量月卡激活态映射的返回结构，确保多个调用方共享同一份查询逻辑。
 * 2. 做什么：验证已激活、已过期、无记录三种角色都能得到稳定布尔值，避免前端各入口出现判断漂移。
 * 3. 不做什么：不连接真实数据库，不验证月卡购买/续期业务流程。
 *
 * 输入/输出：
 * - 输入：角色 ID 列表、模拟的数据库返回行。
 * - 输出：`characterId -> monthCardActive` 的映射结果。
 *
 * 数据流/状态流：
 * - 测试通过 mock `query` 截获共享模块的 SQL；
 * - 返回一条“仍有效”的 ownership 记录；
 * - 断言映射里只有该角色为 true，其余角色为 false。
 *
 * 关键边界条件与坑点：
 * 1. 结果映射必须为每个输入角色都返回显式布尔值，不能只返回命中的角色，否则上层容易漏判。
 * 2. 输入里重复或非法角色 ID 必须被收敛掉，避免批量 SQL 参数污染与重复计算。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import * as database from '../../config/database.js';
import {
  applyMonthCardFuyuanBonus,
  getMonthCardActiveMapByCharacterIds,
  getMonthCardBenefitValues,
} from '../shared/monthCardBenefits.js';

test('批量月卡激活态映射应返回完整布尔结果', async (t) => {
  const queryMock = t.mock.method(
    database.pool,
    'query',
    async (_sql: string, params?: readonly unknown[]) => {
      assert.deepEqual(params?.[0], [101, 102, 103]);
      return {
        rows: [{ character_id: 102 }],
      };
    },
  );

  const result = await getMonthCardActiveMapByCharacterIds([101, 102, 103, 102, 0, -1]);

  assert.equal(result.get(101), false);
  assert.equal(result.get(102), true);
  assert.equal(result.get(103), false);
  assert.equal(queryMock.mock.callCount(), 1);
});

test('空角色列表不应访问数据库', async (t) => {
  const queryMock = t.mock.method(database.pool, 'query', async () => ({ rows: [] }));

  const result = await getMonthCardActiveMapByCharacterIds([]);

  assert.equal(result.size, 0);
  assert.equal(queryMock.mock.callCount(), 0);
});

test('月卡权益配置应统一提供冷却缩减、体力恢复速度与福源加成', () => {
  const benefits = getMonthCardBenefitValues();

  assert.deepEqual(benefits, {
    cooldownReductionRate: 0.1,
    staminaRecoveryRate: 0.1,
    fuyuanBonus: 20,
    idleMaxDurationHours: 12,
  });
});

test('激活月卡时应对福源应用共享加成', () => {
  assert.equal(applyMonthCardFuyuanBonus(88, 20), 108);
});
