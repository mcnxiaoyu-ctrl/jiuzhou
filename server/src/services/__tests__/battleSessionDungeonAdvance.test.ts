/**
 * 秘境 BattleSession 推进回归测试
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：锁定“秘境最后一波正常结算后，队长推进会话时，其余队员必须收到退出旧战斗页的 realtime 广播”。
 * 2. 做什么：验证会话进入终态后会被真正删除，队员刷新时不会继续拿到残留 session。
 * 3. 不做什么：不覆盖前端视图切换，也不覆盖秘境具体奖励结算。
 *
 * 输入/输出：
 * - 输入：waiting_transition 的 dungeon session、队长 userId、模拟的 dungeonService.nextDungeonInstance 结果。
 * - 输出：advanceBattleSession 返回 completed/failed，且其余参与者收到 `battle_abandoned`。
 *
 * 数据流/状态流：
 * - 测试用例 -> advanceBattleSession/服务端自动推进 -> finalizeBattleSession
 * -> notifyBattleSessionEndedUsers -> 客户端 realtime 退出旧战斗页。
 *
 * 关键边界条件与坑点：
 * 1. 广播只应发给“推进者以外”的参与者；推进者以自己的 HTTP 返回为准，不能双重驱动本地状态。
 * 2. 会话删除后 `/battle-session/current` 必须返回空，否则队员刷新后还会被旧 session 拉回秘境战斗。
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import * as database from '../../config/database.js';
import * as gameServerModule from '../../game/gameServer.js';
import { dungeonService } from '../dungeon/service.js';
import {
  advanceBattleSession,
  getCurrentBattleSessionDetail,
  markBattleSessionFinished,
} from '../battleSession/service.js';
import {
  battleSessionById,
  battleSessionIdByBattleId,
  createBattleSessionRecord,
} from '../battleSession/runtime.js';

test('advanceBattleSession: 秘境最终结算后应通知其余队员退出旧战斗页', async (t) => {
  const battleId = 'dungeon-battle-advance-finish-test';
  const sessionId = 'dungeon-battle-advance-finish-session';
  const instanceId = 'dungeon-instance-finish-test';
  const emitted: Array<{ userId: number; event: string; payload: { kind?: string; battleId?: string } }> = [];

  createBattleSessionRecord({
    sessionId,
    type: 'dungeon',
    ownerUserId: 1,
    participantUserIds: [1, 2, 3],
    currentBattleId: battleId,
    status: 'waiting_transition',
    nextAction: 'advance',
    canAdvance: true,
    lastResult: 'attacker_win',
    context: { instanceId },
  });

  t.after(() => {
    battleSessionById.delete(sessionId);
    battleSessionIdByBattleId.delete(battleId);
  });

  t.mock.method(dungeonService, 'nextDungeonInstance', async (userId: number, requestInstanceId: string) => {
    assert.equal(userId, 1);
    assert.equal(requestInstanceId, instanceId);
    return {
      success: true as const,
      data: {
        instanceId,
        status: 'cleared' as const,
        finished: true,
      },
    };
  });
  t.mock.method(gameServerModule, 'getGameServer', () => ({
    emitToUser: (userId: number, event: string, payload: { kind?: string; battleId?: string }) => {
      emitted.push({ userId, event, payload });
    },
    pushCharacterUpdate: () => Promise.resolve(),
  }) as never);

  const res = await advanceBattleSession(1, sessionId);
  assert.equal(res.success, true);
  if (!res.success) {
    assert.fail('秘境最终结算推进应成功');
  }
  assert.equal(res.data.session.status, 'completed');
  assert.equal(res.data.session.currentBattleId, null);
  assert.equal(res.data.finished, true);

  assert.equal(battleSessionById.has(sessionId), false);
  assert.equal(battleSessionIdByBattleId.has(battleId), false);
  assert.deepEqual(emitted.map((entry) => entry.userId), [2, 3]);
  for (const entry of emitted) {
    assert.equal(entry.event, 'battle:update');
    assert.equal(entry.payload.kind, 'battle_abandoned');
    assert.equal(entry.payload.battleId, battleId);
  }

  const memberSession = await getCurrentBattleSessionDetail(2);
  assert.equal(memberSession.success, true);
  if (!memberSession.success) {
    assert.fail('队员查询当前战斗会话应成功返回空结果');
  }
  assert.equal(memberSession.data.session ?? null, null);
});

test('markBattleSessionFinished: 秘境胜利后应由服务端自动推进下一波并广播新战斗快照', async (t) => {
  const battleId = 'dungeon-battle-auto-advance-prev';
  const nextBattleId = 'dungeon-battle-auto-advance-next';
  const sessionId = 'dungeon-battle-auto-advance-session';
  const instanceId = 'dungeon-instance-auto-advance';
  let inTransaction = false;
  let observedTransaction = false;
  const emitted: Array<{
    userId: number;
    event: string;
    payload: {
      kind?: string;
      battleId?: string;
      session?: { currentBattleId?: string | null; status?: string };
    };
  }> = [];
  let scheduledAdvance: (() => Promise<void>) | null = null;

  createBattleSessionRecord({
    sessionId,
    type: 'dungeon',
    ownerUserId: 1,
    participantUserIds: [1, 2],
    currentBattleId: battleId,
    status: 'running',
    nextAction: 'none',
    canAdvance: false,
    lastResult: null,
    context: { instanceId },
  });

  t.after(() => {
    battleSessionById.delete(sessionId);
    battleSessionIdByBattleId.delete(battleId);
    battleSessionIdByBattleId.delete(nextBattleId);
  });

  t.mock.method(globalThis, 'setTimeout', ((handler: Parameters<typeof setTimeout>[0]) => {
    if (typeof handler === 'function') {
      scheduledAdvance = async () => {
        await handler();
      };
    }
    return 1 as unknown as ReturnType<typeof setTimeout>;
  }) as typeof setTimeout);
  t.mock.method(globalThis, 'clearTimeout', (() => undefined) as typeof clearTimeout);
  t.mock.method(database, 'withTransactionAuto', async <T>(callback: () => Promise<T>) => {
    inTransaction = true;
    try {
      return await callback();
    } finally {
      inTransaction = false;
    }
  });
  t.mock.method(dungeonService, 'nextDungeonInstance', async (userId: number, requestInstanceId: string) => {
    assert.equal(userId, 1);
    assert.equal(requestInstanceId, instanceId);
    observedTransaction = inTransaction;
    assert.equal(inTransaction, true, '秘境自动推进进入结算前必须已经建立事务上下文');
    return {
      success: true as const,
      data: {
        instanceId,
        status: 'running' as const,
        battleId: nextBattleId,
        state: {
          battleId: nextBattleId,
          phase: 'action',
          roundCount: 1,
        },
      },
    };
  });
  t.mock.method(gameServerModule, 'getGameServer', () => ({
    emitToUser: (
      userId: number,
      event: string,
      payload: {
        kind?: string;
        battleId?: string;
        session?: { currentBattleId?: string | null; status?: string };
      },
    ) => {
      emitted.push({ userId, event, payload });
    },
    pushCharacterUpdate: () => Promise.resolve(),
  }) as never);

  const waitingSnapshot = await markBattleSessionFinished(battleId, 'attacker_win');
  assert.equal(waitingSnapshot?.status, 'waiting_transition');
  assert.equal(waitingSnapshot?.nextAction, 'advance');
  assert.ok(scheduledAdvance, '秘境胜利后应调度服务端自动推进');
  const runScheduledAdvance = scheduledAdvance as (() => Promise<void>) | null;
  if (!runScheduledAdvance) {
    assert.fail('秘境胜利后应调度服务端自动推进');
  }

  await runScheduledAdvance();

  const session = battleSessionById.get(sessionId);
  assert.ok(session);
  assert.equal(session?.status, 'running');
  assert.equal(session?.currentBattleId, nextBattleId);
  assert.equal(session?.nextAction, 'none');
  assert.equal(session?.canAdvance, false);
  assert.equal(observedTransaction, true);

  assert.deepEqual(emitted.map((entry) => entry.userId), [1, 2]);
  for (const entry of emitted) {
    assert.equal(entry.event, 'battle:update');
    assert.equal(entry.payload.kind, 'battle_started');
    assert.equal(entry.payload.battleId, nextBattleId);
    assert.equal(entry.payload.session?.currentBattleId, nextBattleId);
    assert.equal(entry.payload.session?.status, 'running');
  }
});

test('markBattleSessionFinished: 秘境最终自动结算后队长与队员都应收到退出旧战斗页广播', async (t) => {
  const battleId = 'dungeon-battle-auto-finish-prev';
  const sessionId = 'dungeon-battle-auto-finish-session';
  const instanceId = 'dungeon-instance-auto-finish';
  const emitted: Array<{ userId: number; event: string; payload: { kind?: string; battleId?: string } }> = [];
  let scheduledAdvance: (() => Promise<void>) | null = null;

  createBattleSessionRecord({
    sessionId,
    type: 'dungeon',
    ownerUserId: 1,
    participantUserIds: [1, 2],
    currentBattleId: battleId,
    status: 'running',
    nextAction: 'none',
    canAdvance: false,
    lastResult: null,
    context: { instanceId },
  });

  t.after(() => {
    battleSessionById.delete(sessionId);
    battleSessionIdByBattleId.delete(battleId);
  });

  t.mock.method(globalThis, 'setTimeout', ((handler: Parameters<typeof setTimeout>[0]) => {
    if (typeof handler === 'function') {
      scheduledAdvance = async () => {
        await handler();
      };
    }
    return 1 as unknown as ReturnType<typeof setTimeout>;
  }) as typeof setTimeout);
  t.mock.method(globalThis, 'clearTimeout', (() => undefined) as typeof clearTimeout);
  t.mock.method(database, 'withTransactionAuto', async <T>(callback: () => Promise<T>) => {
    return callback();
  });
  t.mock.method(dungeonService, 'nextDungeonInstance', async (userId: number, requestInstanceId: string) => {
    assert.equal(userId, 1);
    assert.equal(requestInstanceId, instanceId);
    return {
      success: true as const,
      data: {
        instanceId,
        status: 'cleared' as const,
        finished: true,
      },
    };
  });
  t.mock.method(gameServerModule, 'getGameServer', () => ({
    emitToUser: (userId: number, event: string, payload: { kind?: string; battleId?: string }) => {
      emitted.push({ userId, event, payload });
    },
    pushCharacterUpdate: () => Promise.resolve(),
  }) as never);

  const waitingSnapshot = await markBattleSessionFinished(battleId, 'attacker_win');
  assert.equal(waitingSnapshot?.status, 'waiting_transition');
  assert.equal(waitingSnapshot?.nextAction, 'advance');
  assert.ok(scheduledAdvance, '秘境最终结算也应沿用服务端自动推进');
  const runScheduledAdvance = scheduledAdvance as (() => Promise<void>) | null;
  if (!runScheduledAdvance) {
    assert.fail('秘境最终结算也应沿用服务端自动推进');
  }

  await runScheduledAdvance();

  assert.equal(battleSessionById.has(sessionId), false);
  assert.equal(battleSessionIdByBattleId.has(battleId), false);
  assert.deepEqual(emitted.map((entry) => entry.userId), [1, 2]);
  for (const entry of emitted) {
    assert.equal(entry.event, 'battle:update');
    assert.equal(entry.payload.kind, 'battle_abandoned');
    assert.equal(entry.payload.battleId, battleId);
  }

  const ownerSession = await getCurrentBattleSessionDetail(1);
  assert.equal(ownerSession.success, true);
  if (!ownerSession.success) {
    assert.fail('队长查询当前战斗会话应成功返回空结果');
  }
  assert.equal(ownerSession.data.session ?? null, null);

  const memberSession = await getCurrentBattleSessionDetail(2);
  assert.equal(memberSession.success, true);
  if (!memberSession.success) {
    assert.fail('队员查询当前战斗会话应成功返回空结果');
  }
  assert.equal(memberSession.data.session ?? null, null);
});
