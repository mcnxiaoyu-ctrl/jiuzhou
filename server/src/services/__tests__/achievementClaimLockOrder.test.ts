/**
 * 成就领奖锁顺序回归测试
 *
 * 作用（做什么 / 不做什么）：
 * - 做什么：验证成就领取与成就点数奖励领取都会先走统一的奖励目标加锁入口，再去执行成就状态原子流转 SQL。
 * - 做什么：把“先背包互斥锁，再锁 characters，再锁成就记录”的协议集中回归，避免同类锁顺序在多个领取入口各写一遍。
 * - 不做什么：不连接真实数据库，不校验奖励内容展示，也不覆盖背包发奖的完整落库流程。
 *
 * 输入/输出：
 * - 输入：对 `withTransaction`、`query`、静态配置加载器与奖励目标锁工具的 mock。
 * - 输出：领取结果，以及关键调用顺序日志。
 *
 * 数据流/状态流：
 * - 测试先把事务包装器改成直通；
 * - 再记录奖励目标锁与成就状态流转 SQL 的先后顺序；
 * - 最后断言领取成功，且统一锁入口始终先执行。
 *
 * 关键边界条件与坑点：
 * 1) 这里故意把奖励配置收敛为“空奖励”，只验证锁顺序根因，避免把无关的物品/货币发放实现耦合进来。
 * 2) `@Transactional` 装饰器会走 `withTransaction`，若不先 mock 成直通，测试会误触真实连接池。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import * as database from '../../config/database.js';
import * as staticConfigLoader from '../staticConfigLoader.js';
import { claimAchievement, claimAchievementPointsReward } from '../achievement/claim.js';
import * as rewardTargetLock from '../shared/characterRewardTargetLock.js';

test('成就奖励领取应先锁奖励目标再执行成就状态流转', async (t) => {
  const events: string[] = [];

  t.mock.method(database, 'withTransaction', async <T>(callback: () => Promise<T>) => {
    return await callback();
  });
  const rewardLockMock = t.mock.method(
    rewardTargetLock,
    'lockCharacterRewardSettlementTargets',
    async (characterIds: number[]) => {
      events.push(`reward-lock:${characterIds.join(',')}`);
      return characterIds;
    },
  );
  t.mock.method(staticConfigLoader, 'getAchievementDefinitions', () => [
    {
      id: 'ach-lock-order',
      enabled: true,
      rewards: [],
      title_id: null,
    },
  ]);
  t.mock.method(database, 'query', async (sql: string) => {
    if (sql.includes('WITH current_achievement AS')) {
      events.push('achievement-claim-transition');
      return { rows: [{ previous_status: 'completed', claimed_achievement_id: 'ach-lock-order' }] };
    }
    return { rows: [] };
  });

  const result = await claimAchievement(1001, 2712, 'ach-lock-order');

  assert.equal(result.success, true);
  assert.equal(rewardLockMock.mock.callCount(), 1);
  assert.deepEqual(rewardLockMock.mock.calls[0]?.arguments, [[2712]]);
  assert.ok(events.indexOf('reward-lock:2712') >= 0);
  assert.ok(events.indexOf('achievement-claim-transition') >= 0);
  assert.ok(
    events.indexOf('reward-lock:2712') < events.indexOf('achievement-claim-transition'),
    `奖励目标锁应先于成就状态流转执行，实际顺序: ${events.join(' -> ')}`,
  );
});

test('成就点数奖励领取应先锁奖励目标再执行点数状态流转', async (t) => {
  const events: string[] = [];

  t.mock.method(database, 'withTransaction', async <T>(callback: () => Promise<T>) => {
    return await callback();
  });
  const rewardLockMock = t.mock.method(
    rewardTargetLock,
    'lockCharacterRewardSettlementTargets',
    async (characterIds: number[]) => {
      events.push(`reward-lock:${characterIds.join(',')}`);
      return characterIds;
    },
  );
  t.mock.method(staticConfigLoader, 'getAchievementPointsRewardDefinitions', () => [
    {
      id: 'apr-lock-order',
      enabled: true,
      points_threshold: 300,
      rewards: [],
      title_id: null,
    },
  ]);
  t.mock.method(database, 'query', async (sql: string) => {
    if (sql.includes('INSERT INTO character_achievement_points')) {
      events.push('achievement-points-ensure');
      return { rows: [] };
    }
    if (sql.includes('WITH current_points AS')) {
      events.push('achievement-points-claim-transition');
      return { rows: [{ total_points: 300, claimed_thresholds: [], claimed_threshold: 300 }] };
    }
    return { rows: [] };
  });

  const result = await claimAchievementPointsReward(1001, 2712, 300);

  assert.equal(result.success, true);
  assert.equal(rewardLockMock.mock.callCount(), 1);
  assert.deepEqual(rewardLockMock.mock.calls[0]?.arguments, [[2712]]);
  assert.ok(events.indexOf('reward-lock:2712') >= 0);
  assert.ok(events.indexOf('achievement-points-claim-transition') >= 0);
  assert.ok(
    events.indexOf('reward-lock:2712') < events.indexOf('achievement-points-claim-transition'),
    `奖励目标锁应先于点数状态流转执行，实际顺序: ${events.join(' -> ')}`,
  );
});
