/**
 * waiting_transition 逃离战斗回归测试
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：覆盖“战斗已结算但仍处于冷却中间态时，队长点击逃离战斗”这条链路。
 * 2. 做什么：验证 owner 能终止 waiting_transition，会话会被删除，且队员会同步收到 `battle_abandoned`。
 * 3. 不做什么：不覆盖 active battle 中的普通逃跑逻辑，那个行为由 battle/action 原路径负责。
 *
 * 输入/输出：
 * - 输入：waiting_transition 状态的 BattleSession、battleId、队长 userId。
 * - 输出：`abandonBattle` 返回成功，session/runtime 索引被清理，socket 广播覆盖所有参与者。
 *
 * 数据流/状态流：
 * - 测试用例 -> abandonBattle -> battleSession waiting_transition 收尾 -> 广播 battle_abandoned。
 *
 * 关键边界条件与坑点：
 * 1. activeBattles 已清理后不能再直接返回“战斗不存在”，否则队长和队员会进入分叉状态。
 * 2. 广播名单必须在 session 删除前拍下，否则队员收不到统一退出事件。
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import * as gameServerModule from '../../game/gameServer.js';
import { abandonBattle } from '../battle/action.js';
import { finishedBattleResults } from '../battle/runtime/state.js';
import {
  battleSessionById,
  battleSessionIdByBattleId,
  createBattleSessionRecord,
} from '../battleSession/runtime.js';

test('abandonBattle: waiting_transition 中队长逃离应广播队员并清理会话', async (t) => {
  const battleId = 'battle-waiting-transition-abandon-test';
  const sessionId = 'battle-waiting-transition-abandon-session';
  const emitted: Array<{ userId: number; event: string; payload: { kind?: string } }> = [];
  const pushedUsers: number[] = [];

  createBattleSessionRecord({
    sessionId,
    type: 'pve',
    ownerUserId: 1,
    participantUserIds: [1, 2],
    currentBattleId: battleId,
    status: 'waiting_transition',
    nextAction: 'advance',
    canAdvance: true,
    lastResult: 'attacker_win',
    context: { monsterIds: ['monster-1'] },
  });
  finishedBattleResults.set(battleId, {
    result: {
      success: true,
      message: '战斗胜利',
      data: {
        nextBattleAvailableAt: Date.now() + 3_000,
      },
    },
    at: Date.now(),
  });

  t.after(() => {
    battleSessionById.delete(sessionId);
    battleSessionIdByBattleId.delete(battleId);
    finishedBattleResults.delete(battleId);
  });

  t.mock.method(gameServerModule, 'getGameServer', () => ({
    emitToUser: (userId: number, event: string, payload: { kind?: string }) => {
      emitted.push({ userId, event, payload });
    },
    pushCharacterUpdate: (userId: number) => {
      pushedUsers.push(userId);
      return Promise.resolve();
    },
  }) as never);

  const result = await abandonBattle(1, battleId);

  assert.equal(result.success, true);
  assert.equal(result.message, '已退出战斗');
  assert.equal(battleSessionById.has(sessionId), false);
  assert.equal(battleSessionIdByBattleId.has(battleId), false);
  assert.deepEqual(emitted.map((entry) => entry.userId), [1, 2]);
  assert.deepEqual(pushedUsers, [1, 2]);

  for (const entry of emitted) {
    assert.equal(entry.event, 'battle:update');
    assert.equal(entry.payload.kind, 'battle_abandoned');
  }
});
