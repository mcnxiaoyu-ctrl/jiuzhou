/**
 * 在线战斗延迟结算秘境陈旧任务丢弃回归测试
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：锁定“秘境通关结算时实例行已不存在”会被 runner 直接删除任务，不再标记 failed 并无限重试。
 * 2. 做什么：覆盖真实 `flushOnlineBattleSettlementTasks` 到 runner 单任务生命周期的完整路径，确保调度层和结算层的职责边界稳定。
 * 3. 不做什么：不验证真实发奖内容、不连接真实 Redis/数据库，也不覆盖 dungeon-start 落库成功路径。
 *
 * 输入/输出：
 * - 输入：一条 `dungeon-clear` 延迟结算任务，以及返回空实例行锁结果的数据库 mock。
 * - 输出：flush 完成后任务应被删除，且不会写回 failed 状态。
 *
 * 数据流/状态流：
 * pending dungeon-clear -> flushOnlineBattleSettlementTasks
 * -> runner 标记 running -> 秘境实例锁查询未命中
 * -> runner 删除陈旧任务并结束，不再进入失败重试队列。
 *
 * 复用设计说明：
 * 1. 直接复用真实 runner flush 入口，只 mock 事务、投影和 socket 依赖，避免测试里复制一套任务生命周期状态机。
 * 2. “实例不存在”通过 `SELECT ... FOR UPDATE` 返回空行模拟，和线上真正触发问题的判定点保持一致。
 *
 * 关键边界条件与坑点：
 * 1. 必须断言不会写回 `failed`，否则任务虽然删除了，状态流约束仍然可能在未来回归时被破坏。
 * 2. 丢弃的是陈旧任务而不是成功发奖，测试不能错误断言角色刷新仍会发生。
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import * as database from '../../config/database.js';
import * as gameServerModule from '../../game/gameServer.js';
import { flushOnlineBattleSettlementTasks } from '../onlineBattleSettlementRunner.js';
import type { DeferredSettlementTask } from '../onlineBattleProjectionService.js';
import * as onlineBattleProjectionService from '../onlineBattleProjectionService.js';

test('flushOnlineBattleSettlementTasks: 秘境实例已不存在时应直接丢弃陈旧通关任务', async (t) => {
  const task: DeferredSettlementTask = {
    taskId: 'dungeon-clear:discarded-instance',
    battleId: 'battle-discarded-instance',
    status: 'pending',
    attempts: 0,
    maxAttempts: 5,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    errorMessage: null,
    payload: {
      battleId: 'battle-discarded-instance',
      battleType: 'pve',
      result: 'attacker_win',
      participants: [
        {
          userId: 101,
          characterId: 1001,
          nickname: '甲',
          realm: '炼气期',
          fuyuan: 1,
        },
      ],
      rewardParticipants: [
        {
          userId: 101,
          characterId: 1001,
          nickname: '甲',
          realm: '炼气期',
          fuyuan: 1,
        },
      ],
      isDungeonBattle: true,
      isTowerBattle: false,
      rewardsPreview: null,
      battleRewardPlan: null,
      monsters: [],
      arenaDelta: null,
      dungeonContext: {
        instanceId: 'discarded-instance',
        dungeonId: 'dungeon-discard-test',
        difficultyId: 'difficulty-discard-test',
      },
      dungeonStartConsumption: null,
      dungeonSettlement: {
        instanceId: 'discarded-instance',
        dungeonId: 'dungeon-discard-test',
        difficultyId: 'difficulty-discard-test',
        timeSpentSec: 90,
        totalDamage: 1234,
        deathCount: 0,
      },
      session: null,
    },
  };

  let pendingTasks: DeferredSettlementTask[] = [task];
  const statusTransitions: Array<{ taskId: string; status: string; errorMessage: string | null }> = [];
  const pushedUserIds: number[] = [];

  t.mock.method(database, 'withTransaction', async <T>(callback: () => Promise<T>) => callback());
  t.mock.method(database, 'query', async (sql: string) => {
    if (sql.includes('FROM dungeon_instance') && sql.includes('FOR UPDATE')) {
      return { rows: [] };
    }
    return { rows: [] };
  });
  t.mock.method(
    onlineBattleProjectionService,
    'listPendingDeferredSettlementTasks',
    () => pendingTasks,
  );
  t.mock.method(
    onlineBattleProjectionService,
    'getDeferredSettlementTask',
    async (taskId: string) => pendingTasks.find((entry) => entry.taskId === taskId) ?? null,
  );
  t.mock.method(
    onlineBattleProjectionService,
    'updateDeferredSettlementTaskStatus',
    async (
      params: Parameters<typeof onlineBattleProjectionService.updateDeferredSettlementTaskStatus>[0],
    ) => {
      const current = pendingTasks.find((entry) => entry.taskId === params.taskId) ?? null;
      if (!current) return null;
      const nextTask: DeferredSettlementTask = {
        ...current,
        status: params.status,
        attempts: params.incrementAttempt ? current.attempts + 1 : current.attempts,
        updatedAt: Date.now(),
        errorMessage: params.errorMessage ?? null,
      };
      statusTransitions.push({
        taskId: params.taskId,
        status: params.status,
        errorMessage: params.errorMessage ?? null,
      });
      pendingTasks = pendingTasks.map((entry) => (
        entry.taskId === params.taskId ? nextTask : entry
      ));
      return nextTask;
    },
  );
  t.mock.method(
    onlineBattleProjectionService,
    'deleteDeferredSettlementTask',
    async (taskId: string) => {
      pendingTasks = pendingTasks.filter((entry) => entry.taskId !== taskId);
    },
  );
  t.mock.method(gameServerModule, 'getGameServer', () => ({
    pushCharacterUpdate: async (userId: number) => {
      pushedUserIds.push(userId);
    },
  }) as never);

  await flushOnlineBattleSettlementTasks();

  assert.deepEqual(statusTransitions, [
    {
      taskId: 'dungeon-clear:discarded-instance',
      status: 'running',
      errorMessage: null,
    },
  ]);
  assert.equal(pendingTasks.length, 0);
  assert.deepEqual(pushedUserIds, []);
});
