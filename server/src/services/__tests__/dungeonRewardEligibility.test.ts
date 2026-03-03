/**
 * dungeonRewardEligibility 回归测试
 *
 * 作用（做什么 / 不做什么）：
 * - 做什么：验证秘境“可领奖名单”的生成与筛选规则，确保中途加入角色不会进入发奖名单。
 * - 不做什么：不触达数据库，不验证完整秘境流程（创建/开战/结算事务不在本测试范围）。
 *
 * 输入/输出：
 * - 输入：参与者数组 + instance_data 快照对象。
 * - 输出：可领奖角色ID数组 / 可领奖参与者数组。
 *
 * 数据流/状态流：
 * 1) 先由 buildDungeonRewardEligibleCharacterIds 固化开战名单。
 * 2) 再由 selectDungeonRewardEligibleParticipants 读取 instance_data 内名单，筛选结算参与者。
 *
 * 关键边界条件与坑点：
 * 1) instance_data 缺失名单字段时必须返回空列表，禁止回退到“全员可领奖”。
 * 2) 名单和参与者中出现重复/非法角色ID时，结果必须去重且仅保留有效角色。
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import type { DungeonInstanceParticipant } from '../dungeon/types.js';
import {
  DUNGEON_REWARD_ELIGIBLE_CHARACTER_IDS_FIELD,
  buildDungeonRewardEligibleCharacterIds,
  parseDungeonRewardEligibleCharacterIdSet,
  selectDungeonRewardEligibleParticipants,
} from '../dungeon/shared/rewardEligibility.js';

test('buildDungeonRewardEligibleCharacterIds 返回去重升序角色ID', () => {
  const participants: DungeonInstanceParticipant[] = [
    { userId: 1, characterId: 12, role: 'leader' },
    { userId: 2, characterId: 5, role: 'member' },
    { userId: 3, characterId: 12, role: 'member' },
    { userId: 4, characterId: 0, role: 'member' },
  ];

  const ids = buildDungeonRewardEligibleCharacterIds(participants);
  assert.deepEqual(ids, [5, 12]);
});

test('selectDungeonRewardEligibleParticipants 只返回名单内参与者', () => {
  const participants: DungeonInstanceParticipant[] = [
    { userId: 1, characterId: 101, role: 'leader' },
    { userId: 2, characterId: 102, role: 'member' },
    { userId: 3, characterId: 103, role: 'member' },
  ];
  const instanceData = {
    [DUNGEON_REWARD_ELIGIBLE_CHARACTER_IDS_FIELD]: [101, 103],
  };

  const selected = selectDungeonRewardEligibleParticipants(participants, instanceData);
  assert.deepEqual(
    selected.map((participant) => participant.characterId),
    [101, 103],
  );
});

test('selectDungeonRewardEligibleParticipants 在名单字段缺失时返回空列表', () => {
  const participants: DungeonInstanceParticipant[] = [
    { userId: 1, characterId: 101, role: 'leader' },
    { userId: 2, characterId: 102, role: 'member' },
  ];

  const selected = selectDungeonRewardEligibleParticipants(participants, {});
  assert.deepEqual(selected, []);
});

test('parseDungeonRewardEligibleCharacterIdSet 解析并去重有效角色ID', () => {
  const instanceData = {
    [DUNGEON_REWARD_ELIGIBLE_CHARACTER_IDS_FIELD]: [101, '101', 102, 0, -1, 'abc', 102],
  };
  const eligibleSet = parseDungeonRewardEligibleCharacterIdSet(instanceData);
  assert.deepEqual([...eligibleSet.values()].sort((a, b) => a - b), [101, 102]);
});
