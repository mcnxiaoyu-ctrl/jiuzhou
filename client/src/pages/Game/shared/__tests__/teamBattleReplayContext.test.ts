import assert from 'node:assert/strict';
import test from 'node:test';

import { shouldResetTeamBattleReplayContext } from '../teamBattleReplayContext';

test('shouldResetTeamBattleReplayContext: 初次建立队伍快照时不应误清空回放', () => {
  assert.equal(shouldResetTeamBattleReplayContext({
    battleId: 'battle-finished-1',
    previous: null,
    current: {
      teamId: 'team-1',
      leaderId: 1001,
      role: 'member',
    },
  }), false);
});

test('shouldResetTeamBattleReplayContext: 队长变化后应清空旧队友回放', () => {
  assert.equal(shouldResetTeamBattleReplayContext({
    battleId: 'battle-finished-1',
    previous: {
      teamId: 'team-1',
      leaderId: 1001,
      role: 'member',
    },
    current: {
      teamId: 'team-1',
      leaderId: 1002,
      role: 'member',
    },
  }), true);
});

test('shouldResetTeamBattleReplayContext: 自己升为队长后应清空旧队友回放', () => {
  assert.equal(shouldResetTeamBattleReplayContext({
    battleId: 'battle-finished-1',
    previous: {
      teamId: 'team-1',
      leaderId: 1001,
      role: 'member',
    },
    current: {
      teamId: 'team-1',
      leaderId: 1002,
      role: 'leader',
    },
  }), true);
});

test('shouldResetTeamBattleReplayContext: 同队且队长未变时保留回放', () => {
  assert.equal(shouldResetTeamBattleReplayContext({
    battleId: 'battle-finished-1',
    previous: {
      teamId: 'team-1',
      leaderId: 1001,
      role: 'member',
    },
    current: {
      teamId: 'team-1',
      leaderId: 1001,
      role: 'member',
    },
  }), false);
});
