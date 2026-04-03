/**
 * 在线战斗延迟结算领奖目标串行化回归测试
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：锁定共享同一领奖角色的两条 PVE 发奖任务不能并发进入 `settleBattleRewardPlan`，避免在数据库里被动等待同一背包 advisory lock。
 * 2. 做什么：覆盖 runner 并发 drain 场景下的“领奖角色 claim”规则，防止后续改动重新放开同角色并发发奖。
 * 3. 不做什么：不验证具体掉落内容，不连接真实 Redis/数据库，也不覆盖邮件、竞技场或秘境实例串行规则。
 *
 * 输入/输出：
 * - 输入：两条共享 `rewardParticipants.characterId` 的 pending 发奖任务，以及 mocked 的发奖/投影/推送依赖。
 * - 输出：第一条任务未完成前，第二条 `settleBattleRewardPlan` 不能开始；flush 完成后两条任务都应被删除。
 *
 * 数据流/状态流：
 * pending task1 + task2 -> flushOnlineBattleSettlementTasks
 * -> runner 先 claim 任务资源键 -> task1 进入真实发奖
 * -> task1 完成释放领奖角色键 -> task2 才允许进入真实发奖。
 *
 * 复用设计说明：
 * 1. 直接复用真实 runner flush 入口，只 mock 发奖与投影依赖，避免测试里复制一套调度器逻辑。
 * 2. “第一条任务是否已经完成”通过手动控制 Promise 暂停，和线上锁等待场景的时序一致，能稳定覆盖串行化缺口。
 *
 * 关键边界条件与坑点：
 * 1. 两条任务必须共享同一个 `rewardParticipants.characterId`，否则不会命中奖励目标串行化路径。
 * 2. 这里故意让第一条发奖挂起一个事件循环以上；如果没有这段停顿，测试环境里可能看不出 runner 是否提前并发 dispatch。
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import * as gameServerModule from '../../game/gameServer.js';
import { battleDropService } from '../battleDropService.js';
import { flushOnlineBattleSettlementTasks } from '../onlineBattleSettlementRunner.js';
import type { DeferredSettlementTask } from '../onlineBattleProjectionService.js';
import * as onlineBattleProjectionService from '../onlineBattleProjectionService.js';
import * as taskService from '../taskService.js';

const createRewardSettlementTask = (taskId: string): DeferredSettlementTask => ({
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
    isDungeonBattle: false,
    isTowerBattle: false,
    rewardsPreview: null,
    battleRewardPlan: {
      totalExp: 120,
      totalSilver: 36,
      drops: [],
      perPlayerRewards: [
        {
          characterId: 1001,
          userId: 101,
          exp: 120,
          silver: 36,
          drops: [],
        },
      ],
    },
    monsters: [],
    arenaDelta: null,
    dungeonContext: null,
    dungeonStartConsumption: null,
    dungeonSettlement: null,
    session: null,
  },
});

test('flushOnlineBattleSettlementTasks: 共享领奖角色的发奖任务应串行执行', async (t) => {
  const firstTask = createRewardSettlementTask('battle-reward-serial-1');
  const secondTask = createRewardSettlementTask('battle-reward-serial-2');
  let pendingTasks: DeferredSettlementTask[] = [firstTask, secondTask];

  const executionOrder: string[] = [];
  let settleCallCount = 0;
  let releaseFirstTask!: () => void;
  const firstTaskSettled = new Promise<void>((resolve) => {
    releaseFirstTask = resolve;
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
  t.mock.method(
    battleDropService,
    'settleBattleRewardPlan',
    async () => {
      settleCallCount += 1;
      const currentTaskId = settleCallCount === 1 ? firstTask.taskId : secondTask.taskId;
      executionOrder.push(`start:${currentTaskId}`);
      if (currentTaskId === firstTask.taskId) {
        await firstTaskSettled;
      }
      executionOrder.push(`end:${currentTaskId}`);
    },
  );
  t.mock.method(taskService, 'recordKillMonsterEvents', async () => undefined);
  t.mock.method(taskService, 'recordDungeonClearEvent', async () => undefined);
  t.mock.method(gameServerModule, 'getGameServer', () => ({
    pushCharacterUpdate: async () => undefined,
  }) as never);

  const flushPromise = flushOnlineBattleSettlementTasks();
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.deepEqual(executionOrder, [`start:${firstTask.taskId}`]);

  releaseFirstTask();
  await flushPromise;

  assert.deepEqual(executionOrder, [
    `start:${firstTask.taskId}`,
    `end:${firstTask.taskId}`,
    `start:${secondTask.taskId}`,
    `end:${secondTask.taskId}`,
  ]);
  assert.equal(pendingTasks.length, 0);
});
