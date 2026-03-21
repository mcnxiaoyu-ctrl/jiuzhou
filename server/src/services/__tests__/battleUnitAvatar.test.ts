/**
 * battle unit 头像透传测试
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：锁定 battleFactory 在创建战斗单位时对 player / partner 头像字段的透传口径。
 * 2. 做什么：防止后续调整 battle unit 快照结构时把头像字段静默丢失，导致 BattleArea 背景图退化。
 * 3. 不做什么：不测试前端背景渲染，也不覆盖 websocket 推送链路。
 *
 * 输入/输出：
 * - 输入：最小合法的玩家、伙伴、怪物战斗数据。
 * - 输出：`createPVEBattle` 生成的 battle state 单位列表断言结果。
 *
 * 数据流/状态流：
 * - CharacterData / PartnerBattleMember / MonsterData -> createPVEBattle -> BattleState.units -> 断言 avatar。
 *
 * 关键边界条件与坑点：
 * 1. 只有 `player` 与 `partner` 应透传头像；怪物不能因为未来扩展字段而误带 avatar。
 * 2. 伙伴头像必须从伙伴战斗成员链路进入 battle unit，而不是前端自行猜测。
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { createPVEBattle } from '../../battle/battleFactory.js';
import { createCharacterData, createMonsterData } from './battleTestUtils.js';

test('createPVEBattle 应透传玩家与伙伴头像，并保持怪物无头像', () => {
  const state = createPVEBattle(
    'battle-avatar-test',
    createCharacterData(1001, {
      nickname: '青玄',
      avatar: '/uploads/avatars/player-1001.png',
    }),
    [],
    [createMonsterData('gray-wolf')],
    { 'gray-wolf': [] },
    {
      partnerMember: {
        data: createCharacterData(2001, {
          nickname: '灵狐',
          avatar: '/assets/partners/spirit-fox.png',
        }),
        skills: [],
        skillPolicy: { slots: [] },
      },
    },
  );

  const [playerUnit, partnerUnit] = state.teams.attacker.units;
  const [monsterUnit] = state.teams.defender.units;

  assert.equal(playerUnit.type, 'player');
  assert.equal(playerUnit.avatar, '/uploads/avatars/player-1001.png');
  assert.equal(partnerUnit.type, 'partner');
  assert.equal(partnerUnit.avatar, '/assets/partners/spirit-fox.png');
  assert.equal(monsterUnit.type, 'monster');
  assert.equal(monsterUnit.avatar, undefined);
});
