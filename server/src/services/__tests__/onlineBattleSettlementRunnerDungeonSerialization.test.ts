/**
 * 在线战斗延迟结算秘境实例串行化回归测试
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：锁定同一秘境实例的 `dungeon-start` 与 `dungeon-clear` 延迟任务必须串行执行，避免 clear 抢在实例落库前写 `dungeon_record`。
 * 2. 做什么：覆盖 runner 并发 drain 场景下的实例级 claim 规则，防止后续改动重新引入同实例并发。
 * 3. 不做什么：不验证真实发奖内容、不连接真实 Redis/数据库，也不覆盖竞技场/普通 PVE 的并发行为。
 *
 * 输入/输出：
 * - 输入：同一个 `instanceId` 的 start/clear 两条 pending 任务。
 * - 输出：flush 完成后 clear 的实例行锁查询只能发生在 start 落库之后，且两条任务都会被成功清理。
 *
 * 数据流/状态流：
 * pending start + clear -> flushOnlineBattleSettlementTasks
 * -> runner 按实例串行 claim -> start 先落 `dungeon_instance`
 * -> clear 再进入 `settleDungeonClearInDbInTransaction`。
 *
 * 复用设计说明：
 * 1. 直接复用真实 runner flush 入口，只 mock 事务/投影/奖励依赖，避免测试里复制一套调度器。
 * 2. “实例是否已落库”通过共享状态模拟，和线上 `dungeon_instance -> dungeon_record` 依赖关系保持一致。
 *
 * 关键边界条件与坑点：
 * 1. 这里必须人为放大 start 落库耗时，否则同实例并发问题在测试环境里可能稳定复现不出来。
 * 2. clear 校验点放在 `SELECT ... FOR UPDATE dungeon_instance`，比等到外键报错更早，能直接锁定 runner 顺序是否正确。
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
import * as staminaService from '../staminaService.js';
import * as taskService from '../taskService.js';

const createBaseTask = (
  taskId: string,
  instanceId: string,
): DeferredSettlementTask => ({
  taskId,
  battleId: `${taskId}-battle`,
  status: 'pending',
  attempts: 0,
  maxAttempts: 5,
  createdAt: Date.now(),
  updatedAt: Date.now(),
  errorMessage: null,
  payload: {
    battleId: `${taskId}-battle`,
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
      instanceId,
      dungeonId: 'dungeon-serial-test',
      difficultyId: 'difficulty-serial-test',
    },
    dungeonStartConsumption: null,
    dungeonSettlement: null,
    session: null,
  },
});

test('flushOnlineBattleSettlementTasks: 同一秘境实例的 start/clear 任务应串行执行', async (t) => {
  const instanceId = 'dungeon-instance-serial-test';
  const startTask: DeferredSettlementTask = {
    ...createBaseTask(`dungeon-start:${instanceId}`, instanceId),
    payload: {
      ...createBaseTask(`dungeon-start:${instanceId}`, instanceId).payload,
      dungeonStartConsumption: {
        instanceId,
        dungeonId: 'dungeon-serial-test',
        difficultyId: 'difficulty-serial-test',
        creatorCharacterId: 1001,
        teamId: null,
        currentStage: 1,
        currentWave: 1,
        participants: [{ userId: 101, characterId: 1001, role: 'leader' }],
        currentBattleId: 'battle-start-serial',
        rewardEligibleCharacterIds: [1001],
        startTime: '2026-03-31T01:30:00.000Z',
        entryCountSnapshots: [],
        staminaConsumptions: [],
      },
    },
  };
  const clearTask: DeferredSettlementTask = {
    ...createBaseTask(`dungeon-clear:${instanceId}`, instanceId),
    payload: {
      ...createBaseTask(`dungeon-clear:${instanceId}`, instanceId).payload,
      dungeonSettlement: {
        instanceId,
        dungeonId: 'dungeon-serial-test',
        difficultyId: 'difficulty-serial-test',
        timeSpentSec: 60,
        totalDamage: 999,
        deathCount: 0,
      },
    },
  };

  let pendingTasks: DeferredSettlementTask[] = [startTask, clearTask];
  let instancePersisted = false;
  let clearCheckedBeforeStartCommitted = false;
  const executionSteps: string[] = [];

  t.mock.method(database, 'withTransaction', async <T>(callback: () => Promise<T>) => callback());
  t.mock.method(database, 'query', async (sql: string) => {
    if (sql.includes('INSERT INTO dungeon_instance')) {
      executionSteps.push('start:insert');
      await new Promise((resolve) => setTimeout(resolve, 20));
      instancePersisted = true;
      return { rows: [] };
    }
    if (sql.includes('UPDATE dungeon_instance')) {
      executionSteps.push('start:update');
      return { rows: [{ id: instanceId }] };
    }
    if (sql.includes('FROM dungeon_instance') && sql.includes('FOR UPDATE')) {
      executionSteps.push('clear:lock-instance');
      if (!instancePersisted) {
        clearCheckedBeforeStartCommitted = true;
      }
      return instancePersisted ? { rows: [{ id: instanceId }] } : { rows: [] };
    }
    if (sql.includes('FROM dungeon_record')) {
      executionSteps.push('clear:load-clear-count');
      return { rows: [] };
    }
    if (sql.includes('FROM characters')) {
      executionSteps.push('clear:load-auto-disassemble');
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
      executionSteps.push('clear:insert-record');
      return { rows: [] };
    }
    return { rows: [] };
  });
  t.mock.method(characterRewardTargetLock, 'lockCharacterRewardSettlementTargets', async () => [1001]);
  t.mock.method(characterRewardSettlement, 'applyCharacterRewardDeltas', async () => undefined);
  t.mock.method(staminaService, 'applyStaminaDeltaByCharacterId', async () => undefined);
  t.mock.method(taskService, 'recordKillMonsterEvents', async () => undefined);
  t.mock.method(taskService, 'recordDungeonClearEvent', async () => undefined);
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
    pushCharacterUpdate: async () => undefined,
  }) as never);

  await flushOnlineBattleSettlementTasks();

  assert.equal(clearCheckedBeforeStartCommitted, false);
  assert.deepEqual(executionSteps, [
    'start:insert',
    'start:update',
    'clear:lock-instance',
    'clear:load-clear-count',
    'clear:load-auto-disassemble',
    'clear:insert-record',
  ]);
  assert.equal(pendingTasks.length, 0);
});

test('flushOnlineBattleSettlementTasks: 失效 teamId 不应阻塞 dungeon-start 落库', async (t) => {
  const instanceId = 'dungeon-instance-stale-team-id';
  const startTask: DeferredSettlementTask = {
    ...createBaseTask(`dungeon-start:${instanceId}`, instanceId),
    payload: {
      ...createBaseTask(`dungeon-start:${instanceId}`, instanceId).payload,
      dungeonStartConsumption: {
        instanceId,
        dungeonId: 'dungeon-stale-team-test',
        difficultyId: 'difficulty-stale-team-test',
        creatorCharacterId: 1001,
        teamId: 'team-stale',
        currentStage: 1,
        currentWave: 1,
        participants: [{ userId: 101, characterId: 1001, role: 'leader' }],
        currentBattleId: 'battle-start-stale-team',
        rewardEligibleCharacterIds: [1001],
        startTime: '2026-04-17T02:00:00.000Z',
        entryCountSnapshots: [],
        staminaConsumptions: [{ characterId: 1001, amount: 10 }],
      },
    },
  };

  let pendingTasks: DeferredSettlementTask[] = [startTask];
  let insertSql = '';
  let insertParams: unknown[] = [];

  t.mock.method(database, 'withTransaction', async <T>(callback: () => Promise<T>) => callback());
  t.mock.method(database, 'query', async (sql: string, params?: unknown[]) => {
    if (sql.includes('INSERT INTO dungeon_instance')) {
      insertSql = sql;
      insertParams = params ?? [];
      return { rows: [] };
    }
    if (sql.includes('UPDATE dungeon_instance')) {
      return { rows: [{ id: instanceId }] };
    }
    return { rows: [] };
  });
  t.mock.method(characterRewardSettlement, 'applyCharacterRewardDeltas', async () => undefined);
  t.mock.method(staminaService, 'applyStaminaDeltaByCharacterId', async () => ({
    characterId: 1001,
    stamina: 90,
    maxStamina: 100,
    recovered: 0,
    changed: true,
    staminaRecoverAt: new Date('2026-04-17T02:00:00.000Z'),
    recoverySpeedWindow: {
      startAtMs: null,
      expireAtMs: null,
    },
  }));
  t.mock.method(taskService, 'recordKillMonsterEvents', async () => undefined);
  t.mock.method(taskService, 'recordDungeonClearEvent', async () => undefined);
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
    pushCharacterUpdate: async () => undefined,
  }) as never);

  await flushOnlineBattleSettlementTasks();

  assert.match(insertSql, /\(SELECT t\.id FROM teams t WHERE t\.id = \$5\)/);
  assert.equal(insertParams[4], 'team-stale');
  assert.equal(pendingTasks.length, 0);
});
