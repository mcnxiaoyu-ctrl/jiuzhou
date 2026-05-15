import test from 'node:test';
import assert from 'node:assert/strict';
import {
  appendAutoDisassembleRewardBatchEntry,
  createAutoDisassembleRewardBatch,
  finalizeAutoDisassembleRewardBatch,
} from '../autoDisassembleRewardBatch.js';

test('应按 itemDefId 聚合数量并保留首次出现顺序', () => {
  const batch = createAutoDisassembleRewardBatch();

  appendAutoDisassembleRewardBatchEntry(batch, {
    fallbackIndex: 2,
    rewards: [
      { itemDefId: 'material-a', qty: 1 },
      { itemDefId: 'material-b', qty: 3 },
    ],
  });
  appendAutoDisassembleRewardBatchEntry(batch, {
    fallbackIndex: 5,
    rewards: [
      { itemDefId: 'material-a', qty: 4 },
      { itemDefId: 'material-c', qty: 2 },
    ],
  });

  assert.deepEqual(finalizeAutoDisassembleRewardBatch(batch), [
    { itemDefId: 'material-a', qty: 5, fallbackIndexes: [2, 5] },
    { itemDefId: 'material-b', qty: 3, fallbackIndexes: [2] },
    { itemDefId: 'material-c', qty: 2, fallbackIndexes: [5] },
  ]);
});

test('应过滤空 itemDefId 和非正数量', () => {
  const batch = createAutoDisassembleRewardBatch();

  appendAutoDisassembleRewardBatchEntry(batch, {
    fallbackIndex: 1,
    rewards: [
      { itemDefId: '', qty: 9 },
      { itemDefId: '   ', qty: 8 },
      { itemDefId: 'material-a', qty: 0 },
      { itemDefId: 'material-b', qty: -2 },
      { itemDefId: 'material-c', qty: 2 },
    ],
  });

  assert.deepEqual(finalizeAutoDisassembleRewardBatch(batch), [
    { itemDefId: 'material-c', qty: 2, fallbackIndexes: [1] },
  ]);
});

test('同一聚合项内 fallbackIndexes 应去重并保留首次顺序', () => {
  const batch = createAutoDisassembleRewardBatch();

  appendAutoDisassembleRewardBatchEntry(batch, {
    fallbackIndex: 4,
    rewards: [
      { itemDefId: 'material-a', qty: 1 },
      { itemDefId: 'material-a', qty: 2 },
    ],
  });
  appendAutoDisassembleRewardBatchEntry(batch, {
    fallbackIndex: 3,
    rewards: [{ itemDefId: 'material-a', qty: 5 }],
  });
  appendAutoDisassembleRewardBatchEntry(batch, {
    fallbackIndex: 4,
    rewards: [{ itemDefId: 'material-a', qty: 7 }],
  });

  assert.deepEqual(finalizeAutoDisassembleRewardBatch(batch), [
    { itemDefId: 'material-a', qty: 15, fallbackIndexes: [4, 3] },
  ]);
});
