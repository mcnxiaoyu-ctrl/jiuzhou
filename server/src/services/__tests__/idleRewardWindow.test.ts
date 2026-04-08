import test from 'node:test';
import assert from 'node:assert/strict';
import {
  appendIdleRewardWindowBatch,
  createIdleRewardWindowState,
  getIdleRewardWindowFlushPayload,
  resetIdleRewardWindowDelta,
  shouldFlushIdleRewardWindow,
} from '../idle/idleRewardWindow.js';

test('idleRewardWindow: 应合并窗口内多场战斗的奖励计划与预览物品', () => {
  const state = createIdleRewardWindowState();

  appendIdleRewardWindowBatch(state, {
    result: 'attacker_win',
    roundCount: 3,
    expGained: 10,
    silverGained: 5,
    previewItems: [{ itemDefId: 'mat-a', itemName: '灵草', quantity: 1 }],
    dropPlans: [{ itemDefId: 'mat-a', quantity: 1, bindType: 'none' }],
  });
  appendIdleRewardWindowBatch(state, {
    result: 'attacker_win',
    roundCount: 4,
    expGained: 12,
    silverGained: 7,
    previewItems: [{ itemDefId: 'mat-a', itemName: '灵草', quantity: 2 }],
    dropPlans: [{ itemDefId: 'mat-a', quantity: 2, bindType: 'none' }],
  });

  const payload = getIdleRewardWindowFlushPayload(state);

  assert.equal(payload.batches.length, 2);
  assert.equal(payload.windowRewardPlan.expGained, 22);
  assert.equal(payload.windowRewardPlan.silverGained, 12);
  assert.deepEqual(payload.windowRewardPlan.previewItems, [
    { itemDefId: 'mat-a', itemName: '灵草', quantity: 3 },
  ]);
  assert.equal(payload.windowRewardPlan.dropPlans.length, 1);
  assert.equal(payload.windowRewardPlan.dropPlans[0]?.quantity, 3);
});

test('idleRewardWindow: 30 秒后应触发 flush', () => {
  const shouldFlush = shouldFlushIdleRewardWindow({
    pendingBatchCount: 1,
    lastFlushAt: 1_000,
    now: 31_001,
    flushIntervalMs: 30_000,
  });

  assert.equal(shouldFlush, true);
});

test('idleRewardWindow: flush 成功后只清空窗口增量，不丢失最近 flush 时间', () => {
  const state = createIdleRewardWindowState();

  appendIdleRewardWindowBatch(state, {
    result: 'attacker_win',
    roundCount: 3,
    expGained: 10,
    silverGained: 5,
    previewItems: [{ itemDefId: 'mat-a', itemName: '灵草', quantity: 1 }],
    dropPlans: [{ itemDefId: 'mat-a', quantity: 1, bindType: 'none' }],
  });

  resetIdleRewardWindowDelta(state, 9_999);

  const payload = getIdleRewardWindowFlushPayload(state);
  assert.equal(payload.batches.length, 0);
  assert.equal(state.lastFlushAt, 9_999);
});
