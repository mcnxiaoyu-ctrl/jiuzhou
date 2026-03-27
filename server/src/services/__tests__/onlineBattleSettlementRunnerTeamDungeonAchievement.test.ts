/**
 * 在线战斗延迟结算组队秘境成就回归测试
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：锁定“组队秘境通关成就”的人数口径必须来自实际参战名单，而不是可领奖名单。
 * 2. 做什么：覆盖“2 人组队通关，但只有 1 人进入领奖链”时，仍应给该领奖玩家记为组队通关。
 * 3. 不做什么：不验证具体掉落入包、不覆盖秘境奖励随机逻辑，也不触达真实数据库事务。
 *
 * 输入/输出：
 * - 输入：一条秘境胜利延迟结算任务，`participants` 为 2 人，`rewardParticipants` 为 1 人。
 * - 输出：`recordDungeonClearEvent` 应收到 `participantCount=2`，从而推进组队秘境成就。
 *
 * 数据流/状态流：
 * pending task -> flushOnlineBattleSettlementTasks -> settleDungeonClearInDb
 * -> recordDungeonClearEvent -> 使用实际参战人数判定是否为组队通关。
 *
 * 复用设计说明：
 * - 直接复用真实的 runner flush 入口，只 mock 事务与落库依赖，避免在测试里复制一套结算编排逻辑。
 * - 这个场景会同时约束“奖励链路人数”和“成就链路人数”的职责边界，后续其他秘境参与资格变更也能复用这条回归保障。
 *
 * 关键边界条件与坑点：
 * 1. `rewardParticipants` 少于 `participants` 是合法场景，不能把它误当成单人通关。
 * 2. runner 是单例，测试必须让 pending 任务在 flush 后清空，避免串到下一条用例。
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import * as database from '../../config/database.js';
import * as gameServerModule from '../../game/gameServer.js';
import { flushOnlineBattleSettlementTasks } from '../onlineBattleSettlementRunner.js';
import type { DeferredSettlementTask } from '../onlineBattleProjectionService.js';
import * as onlineBattleProjectionService from '../onlineBattleProjectionService.js';
import * as characterRewardSettlement from '../shared/characterRewardSettlement.js';
import * as characterRewardTargetLock from '../shared/characterRewardTargetLock.js';
import * as taskService from '../taskService.js';

test('flushOnlineBattleSettlementTasks: 组队秘境成就应使用实际参战人数而不是可领奖人数', async (t) => {
  const task: DeferredSettlementTask = {
    taskId: 'task-team-dungeon-achievement',
    battleId: 'dungeon-battle-team-dungeon-achievement',
    status: 'pending',
    attempts: 0,
    maxAttempts: 5,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    errorMessage: null,
    payload: {
      battleId: 'dungeon-battle-team-dungeon-achievement',
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
        {
          userId: 102,
          characterId: 1002,
          nickname: '乙',
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
        instanceId: 'dungeon-instance-team-dungeon-achievement',
        dungeonId: 'dungeon-test-team-achievement',
        difficultyId: 'difficulty-test-team-achievement',
      },
      dungeonStartConsumption: null,
      dungeonSettlement: {
        instanceId: 'dungeon-instance-team-dungeon-achievement',
        dungeonId: 'dungeon-test-team-achievement',
        difficultyId: 'difficulty-test-team-achievement',
        timeSpentSec: 120,
        totalDamage: 3456,
        deathCount: 0,
      },
      session: null,
    },
  };

  let pendingTasks: DeferredSettlementTask[] = [task];
  const dungeonClearCalls: Array<Parameters<typeof taskService.recordDungeonClearEvent>> = [];

  t.mock.method(database, 'withTransaction', async <T>(callback: () => Promise<T>) => callback());
  t.mock.method(database, 'query', async (sql: string) => {
    if (sql.includes('FROM dungeon_record')) {
      return { rows: [] };
    }
    if (sql.includes('FROM characters')) {
      return {
        rows: [
          {
            id: 1001,
            auto_disassemble_enabled: false,
            auto_disassemble_rules: null,
          },
        ],
      };
    }
    if (sql.includes('INSERT INTO dungeon_record')) {
      return { rows: [] };
    }
    return { rows: [] };
  });
  t.mock.method(characterRewardTargetLock, 'lockCharacterRewardSettlementTargets', async () => [1001]);
  t.mock.method(characterRewardSettlement, 'applyCharacterRewardDeltas', async () => undefined);
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
        attempts: current.attempts + 1,
        updatedAt: Date.now(),
        errorMessage: params.errorMessage ?? current.errorMessage,
      };
      pendingTasks = pendingTasks.map((entry) => (entry.taskId === params.taskId ? nextTask : entry));
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
  t.mock.method(taskService, 'recordKillMonsterEvents', async () => undefined);
  t.mock.method(taskService, 'recordDungeonClearEvent', async (
    ...args: Parameters<typeof taskService.recordDungeonClearEvent>
  ) => {
    dungeonClearCalls.push(args);
  });
  t.mock.method(gameServerModule, 'getGameServer', () => ({
    pushCharacterUpdate: async () => undefined,
  }) as never);

  await flushOnlineBattleSettlementTasks();

  assert.equal(dungeonClearCalls.length, 1);
  assert.deepEqual(dungeonClearCalls[0], [
    1001,
    'dungeon-test-team-achievement',
    1,
    2,
    'difficulty-test-team-achievement',
  ]);
  assert.equal(pendingTasks.length, 0);
});
