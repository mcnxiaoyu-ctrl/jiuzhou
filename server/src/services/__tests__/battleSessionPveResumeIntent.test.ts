/**
 * 普通 PVE 更新中断续战意图回归测试
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：锁定普通 PVE BattleSession 会把“更新后继续打同目标怪物”的最小恢复信息写入单一续战意图存储。
 * 2. 做什么：锁定失败回地图、主动逃跑、恢复重建等场景会按设计更新或删除续战意图，避免主动退出后又被自动拉回。
 * 3. 做什么：锁定组队场景恢复时按当前真实队伍状态重新计算参与者，而不是复用旧快照把离队成员补回。
 * 4. 不做什么：不覆盖前端视图切换，也不覆盖普通战斗具体伤害/掉落结算。
 *
 * 输入/输出：
 * - 输入：普通 PVE session、续战意图 Redis 存储、battle runtime 参与者映射，以及服务更新后查询当前会话的恢复入口。
 * - 输出：续战意图写入/删除结果，以及恢复后返回的 BattleSession 快照。
 *
 * 数据流/状态流：
 * - startPVEBattleSession -> upsert 续战意图
 * - markBattleSessionFinished/abandonBattle -> 删除或保留续战意图
 * - getCurrentBattleSessionDetail -> 无内存 session 时按续战意图懒恢复 running session
 *
 * 关键边界条件与坑点：
 * 1. 主动逃跑后若不删除续战意图，服务更新后会把玩家重新拉进战斗，直接破坏逃跑语义。
 * 2. 续战恢复不能信旧 `participantUserIds`，否则离队成员会在服务更新后被错误补回战斗。
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { BattleEngine } from '../../battle/battleEngine.js';
import { redis } from '../../config/redis.js';
import * as characterComputedService from '../characterComputedService.js';
import * as gameServerModule from '../../game/gameServer.js';
import { abandonBattle } from '../battle/action.js';
import * as battlePersistenceModule from '../battle/runtime/persistence.js';
import { activeBattles, battleParticipants, finishedBattleResults } from '../battle/runtime/state.js';
import * as battlePveModule from '../battle/pve.js';
import type { StartPVEBattleOptions } from '../battle/pve.js';
import {
  advanceBattleSession,
  getCurrentBattleSessionDetail,
  markBattleSessionFinished,
  startPVEBattleSession,
} from '../battleSession/service.js';
import {
  battleSessionById,
  battleSessionIdByBattleId,
  createBattleSessionRecord,
  getBattleSessionSnapshotByBattleId,
} from '../battleSession/runtime.js';
import { createCharacterData, createState, createUnit } from './battleTestUtils.js';

const RESUME_INTENT_KEY_PREFIX = 'battle:session:pve-resume:';

type StoredResumeIntent = {
  ownerUserId: number;
  sessionId: string;
  monsterIds: string[];
  participantUserIds: number[];
  battleId: string;
  updatedAt: number;
};

const buildResumeIntentKey = (userId: number): string => {
  return `${RESUME_INTENT_KEY_PREFIX}${userId}`;
};

const readStoredResumeIntent = (
  storage: Map<string, string>,
  userId: number,
): StoredResumeIntent | null => {
  const raw = storage.get(buildResumeIntentKey(userId));
  if (!raw) return null;
  return JSON.parse(raw) as StoredResumeIntent;
};

test('startPVEBattleSession: 应写入普通 PVE 续战意图', async (t) => {
  const storage = new Map<string, string>();
  const battleId = 'battle-pve-resume-intent-start';

  t.after(() => {
    battleParticipants.delete(battleId);
    for (const session of battleSessionById.values()) {
      battleSessionIdByBattleId.delete(session.currentBattleId ?? '');
    }
    battleSessionById.clear();
    battleSessionIdByBattleId.clear();
  });

  t.mock.method(redis, 'setex', async (key: string, ttlSeconds: number, value: string) => {
    assert.equal(key, buildResumeIntentKey(1));
    assert.equal(ttlSeconds > 0, true);
    storage.set(key, value);
    return 'OK';
  });
  t.mock.method(battlePveModule, 'startPVEBattle', async (
    userId: number,
    monsterIds: string[],
    options?: StartPVEBattleOptions,
  ) => {
    assert.equal(userId, 1);
    assert.deepEqual(monsterIds, ['monster-1']);
    battleParticipants.set(battleId, [1, 2]);
    options?.onBattleRegistered?.({
      battleId,
      participantUserIds: [1, 2],
    });
    return {
      success: true as const,
      data: {
        battleId,
        state: createState({
          attacker: [createUnit({ id: 'player-1', name: '主角' })],
          defender: [createUnit({ id: 'monster-1', name: '妖兽', type: 'monster' })],
        }),
      },
    };
  });

  const result = await startPVEBattleSession(1, ['monster-1']);

  assert.equal(result.success, true);
  if (!result.success) {
    assert.fail('普通 PVE 开战应成功');
  }
  const stored = readStoredResumeIntent(storage, 1);
  assert.ok(stored);
  assert.equal(stored.ownerUserId, 1);
  assert.deepEqual(stored.monsterIds, ['monster-1']);
  assert.deepEqual(stored.participantUserIds, [1, 2]);
  assert.equal(stored.battleId, battleId);
  assert.equal(stored.sessionId, result.data.session.sessionId);
});

test('markBattleSessionFinished: 普通 PVE 回地图终态应删除续战意图', async (t) => {
  const storage = new Map<string, string>();
  const battleId = 'battle-pve-resume-intent-return-map';
  const sessionId = 'battle-pve-resume-intent-return-map-session';

  createBattleSessionRecord({
    sessionId,
    type: 'pve',
    ownerUserId: 1,
    participantUserIds: [1],
    currentBattleId: battleId,
    status: 'running',
    nextAction: 'none',
    canAdvance: false,
    lastResult: null,
    context: { monsterIds: ['monster-1'] },
  });
  storage.set(buildResumeIntentKey(1), JSON.stringify({
    ownerUserId: 1,
    sessionId,
    monsterIds: ['monster-1'],
    participantUserIds: [1],
    battleId,
    updatedAt: Date.now(),
  } satisfies StoredResumeIntent));

  t.after(() => {
    battleSessionById.delete(sessionId);
    battleSessionIdByBattleId.delete(battleId);
  });

  t.mock.method(redis, 'del', async (...keys: string[]) => {
    for (const key of keys) {
      storage.delete(key);
    }
    return keys.length;
  });

  const snapshot = await markBattleSessionFinished(battleId, 'defender_win');

  assert.equal(snapshot?.status, 'waiting_transition');
  assert.equal(snapshot?.nextAction, 'return_to_map');
  assert.equal(readStoredResumeIntent(storage, 1), null);
});

test('getCurrentBattleSessionDetail: 应按当前真实队伍恢复普通 PVE，而不是复用旧成员快照', async (t) => {
  const storage = new Map<string, string>();
  const restoredBattleId = 'battle-pve-resume-intent-restored';

  storage.set(buildResumeIntentKey(1), JSON.stringify({
    ownerUserId: 1,
    sessionId: 'battle-pve-resume-intent-old-session',
    monsterIds: ['monster-1'],
    participantUserIds: [1, 2],
    battleId: 'battle-pve-resume-intent-old-battle',
    updatedAt: Date.now(),
  } satisfies StoredResumeIntent));

  t.after(() => {
    battleParticipants.delete(restoredBattleId);
    battleSessionById.clear();
    battleSessionIdByBattleId.clear();
  });

  t.mock.method(redis, 'get', async (key: string) => {
    return storage.get(key) ?? null;
  });
  t.mock.method(redis, 'setex', async (key: string, _ttlSeconds: number, value: string) => {
    storage.set(key, value);
    return 'OK';
  });
  t.mock.method(battlePveModule, 'startPVEBattle', async (
    userId: number,
    monsterIds: string[],
    options?: StartPVEBattleOptions,
  ) => {
    assert.equal(userId, 1);
    assert.deepEqual(monsterIds, ['monster-1']);
    battleParticipants.set(restoredBattleId, [1]);
    options?.onBattleRegistered?.({
      battleId: restoredBattleId,
      participantUserIds: [1],
    });
    return {
      success: true as const,
      data: {
        battleId: restoredBattleId,
        state: createState({
          attacker: [createUnit({ id: 'player-1', name: '队长' })],
          defender: [createUnit({ id: 'monster-1', name: '妖兽', type: 'monster' })],
        }),
      },
    };
  });

  const result = await getCurrentBattleSessionDetail(1);

  assert.equal(result.success, true);
  if (!result.success || !result.data.session) {
    assert.fail('普通 PVE 续战恢复应返回 running session');
  }
  assert.equal(result.data.session.type, 'pve');
  assert.equal(result.data.session.currentBattleId, restoredBattleId);
  assert.deepEqual(result.data.session.context, { monsterIds: ['monster-1'] });
  assert.deepEqual(result.data.session.participantUserIds, [1]);

  const stored = readStoredResumeIntent(storage, 1);
  assert.ok(stored);
  assert.deepEqual(stored.participantUserIds, [1]);
  assert.equal(stored.battleId, restoredBattleId);
});

test('advanceBattleSession: 普通 PVE 继续下一场时应在底层开战返回前先绑定新 battleId', async (t) => {
  const previousBattleId = 'battle-pve-advance-previous';
  const nextBattleId = 'battle-pve-advance-next';
  const sessionId = 'battle-pve-advance-session';

  createBattleSessionRecord({
    sessionId,
    type: 'pve',
    ownerUserId: 1,
    participantUserIds: [1],
    currentBattleId: previousBattleId,
    status: 'waiting_transition',
    nextAction: 'advance',
    canAdvance: true,
    lastResult: 'attacker_win',
    context: { monsterIds: ['monster-1'] },
  });

  t.after(() => {
    battleParticipants.delete(nextBattleId);
    battleSessionById.clear();
    battleSessionIdByBattleId.clear();
  });

  t.mock.method(battlePveModule, 'startPVEBattle', async (
    userId: number,
    monsterIds: string[],
    options?: StartPVEBattleOptions,
  ) => {
    assert.equal(userId, 1);
    assert.deepEqual(monsterIds, ['monster-1']);
    battleParticipants.set(nextBattleId, [1]);
    options?.onBattleRegistered?.({
      battleId: nextBattleId,
      participantUserIds: [1],
    });

    const nextSessionSnapshot = getBattleSessionSnapshotByBattleId(nextBattleId);
    assert.ok(nextSessionSnapshot);
    assert.equal(nextSessionSnapshot.sessionId, sessionId);
    assert.equal(nextSessionSnapshot.status, 'running');
    assert.equal(nextSessionSnapshot.canAdvance, false);

    return {
      success: true as const,
      data: {
        battleId: nextBattleId,
        state: (() => {
          const state = createState({
          attacker: [createUnit({ id: 'player-1', name: '主角' })],
          defender: [createUnit({ id: 'monster-1', name: '妖兽', type: 'monster' })],
          });
          state.battleId = nextBattleId;
          return state;
        })(),
      },
    };
  });

  const result = await advanceBattleSession(1, sessionId);

  assert.equal(result.success, true);
  if (!result.success) {
    assert.fail('普通 PVE 继续下一场应成功');
  }
  assert.equal(result.data.session.currentBattleId, nextBattleId);
  assert.equal(result.data.session.status, 'running');
  assert.equal(result.data.session.nextAction, 'none');
});

test('abandonBattle: 主动逃跑后应删除普通 PVE 续战意图', async (t) => {
  const storage = new Map<string, string>();
  const battleId = 'battle-pve-resume-intent-abandon';
  const sessionId = 'battle-pve-resume-intent-abandon-session';
  const leader = createUnit({ id: 'player-1', name: '主角' });
  const monster = createUnit({ id: 'monster-1', name: '妖兽', type: 'monster' });
  const state = createState({
    attacker: [leader],
    defender: [monster],
  });
  state.battleId = battleId;
  state.currentTeam = 'attacker';
  state.phase = 'action';
  state.currentUnitId = leader.id;

  createBattleSessionRecord({
    sessionId,
    type: 'pve',
    ownerUserId: 1,
    participantUserIds: [1],
    currentBattleId: battleId,
    status: 'running',
    nextAction: 'none',
    canAdvance: false,
    lastResult: null,
    context: { monsterIds: ['monster-1'] },
  });
  activeBattles.set(battleId, new BattleEngine(state));
  battleParticipants.set(battleId, [1]);
  storage.set(buildResumeIntentKey(1), JSON.stringify({
    ownerUserId: 1,
    sessionId,
    monsterIds: ['monster-1'],
    participantUserIds: [1],
    battleId,
    updatedAt: Date.now(),
  } satisfies StoredResumeIntent));

  t.after(() => {
    activeBattles.delete(battleId);
    battleParticipants.delete(battleId);
    finishedBattleResults.delete(battleId);
    battleSessionById.delete(sessionId);
    battleSessionIdByBattleId.delete(battleId);
  });

  t.mock.method(redis, 'del', async (...keys: string[]) => {
    for (const key of keys) {
      storage.delete(key);
    }
    return keys.length;
  });
  t.mock.method(gameServerModule, 'getGameServer', () => ({
    emitToUser: () => undefined,
    pushCharacterUpdate: () => Promise.resolve(),
  }) as never);
  t.mock.method(characterComputedService, 'getCharacterComputedByUserId', async (userId: number) => {
    return createCharacterData(userId);
  });
  t.mock.method(characterComputedService, 'applyCharacterResourceDeltaByCharacterId', async () => {
    return { success: true as const };
  });
  t.mock.method(battlePersistenceModule, 'removeBattleFromRedis', async () => {
    return;
  });

  const result = await abandonBattle(1, battleId);

  assert.equal(result.success, true);
  assert.equal(readStoredResumeIntent(storage, 1), null);
  assert.equal(battleSessionById.has(sessionId), false);
});
