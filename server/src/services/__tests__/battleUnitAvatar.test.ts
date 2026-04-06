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

  const [partnerUnit, playerUnit] = state.teams.attacker.units;
  const [monsterUnit] = state.teams.defender.units;

  assert.equal(partnerUnit.type, 'partner');
  assert.equal(partnerUnit.avatar, '/assets/partners/spirit-fox.png');
  assert.equal(playerUnit.type, 'player');
  assert.equal(playerUnit.avatar, '/uploads/avatars/player-1001.png');
  assert.equal(monsterUnit.type, 'monster');
  assert.equal(monsterUnit.avatar, undefined);
});

test('createPVEBattle: 组队时应按玩家与各自伙伴的配对顺序装配攻击方单位', () => {
  const state = createPVEBattle(
    'battle-team-partner-order-test',
    createCharacterData(1001, {
      nickname: '主角',
      avatar: '/uploads/avatars/player-1001.png',
    }),
    [],
    [createMonsterData('gray-wolf')],
    { 'gray-wolf': [] },
    {
      partnerMember: {
        data: createCharacterData(2001, {
          nickname: '主角伙伴',
          avatar: '/assets/partners/partner-2001.png',
        }),
        skills: [],
        skillPolicy: { slots: [] },
      },
      teamMembers: [
        {
          data: createCharacterData(1002, {
            nickname: '队友甲',
            avatar: '/uploads/avatars/player-1002.png',
          }),
          skills: [],
          partnerMember: {
            data: createCharacterData(2002, {
              nickname: '队友甲伙伴',
              avatar: '/assets/partners/partner-2002.png',
            }),
            skills: [],
            skillPolicy: { slots: [] },
          },
        },
        {
          data: createCharacterData(1003, {
            nickname: '队友乙',
            avatar: '/uploads/avatars/player-1003.png',
          }),
          skills: [],
        },
      ] as Array<{
        data: ReturnType<typeof createCharacterData>;
        skills: [];
      }>,
    },
  );

  assert.deepEqual(
    state.teams.attacker.units.map((unit) => `${unit.type}:${unit.name}`),
    ['partner:主角伙伴', 'player:主角', 'partner:队友甲伙伴', 'player:队友甲', 'player:队友乙'],
  );
  assert.deepEqual(
    state.teams.attacker.units.map((unit) => unit.avatar ?? null),
    [
      '/assets/partners/partner-2001.png',
      '/uploads/avatars/player-1001.png',
      '/assets/partners/partner-2002.png',
      '/uploads/avatars/player-1002.png',
      '/uploads/avatars/player-1003.png',
    ],
  );
});
