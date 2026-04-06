import assert from 'node:assert/strict';
import test from 'node:test';

import {
  prepareFixedTeamBattleParticipants,
  type FixedBattleParticipant,
} from '../battle/shared/preparation.js';
import type { OnlineBattleCharacterSnapshot } from '../onlineBattleProjectionService.js';
import type { CharacterComputedRow } from '../characterComputedService.js';
import type { CharacterBattleLoadout } from '../battle/shared/profileCache.js';
import type { PartnerBattleMember } from '../shared/partnerBattleMember.js';

const createComputedRow = (
  characterId: number,
  userId: number,
  nickname: string,
): CharacterComputedRow => ({
  id: characterId,
  user_id: userId,
  nickname,
  title: '',
  gender: 'male',
  avatar: null,
  auto_cast_skills: true,
  auto_disassemble_enabled: false,
  auto_disassemble_rules: null,
  dungeon_no_stamina_cost: false,
  spirit_stones: 0,
  silver: 0,
  stamina: 100,
  stamina_max: 100,
  realm: '炼气期',
  sub_realm: null,
  exp: 0,
  attribute_points: 0,
  jing: 10,
  qi: 10,
  shen: 10,
  attribute_type: 'balanced',
  attribute_element: 'metal',
  current_map_id: 'map-1',
  current_room_id: 'room-1',
  max_qixue: 100,
  max_lingqi: 100,
  wugong: 10,
  fagong: 10,
  wufang: 10,
  fafang: 10,
  mingzhong: 1,
  shanbi: 0,
  zhaojia: 0,
  baoji: 0,
  baoshang: 0,
  jianbaoshang: 0,
  jianfantan: 0,
  kangbao: 0,
  zengshang: 0,
  zhiliao: 0,
  jianliao: 0,
  xixue: 0,
  lengque: 0,
  kongzhi_kangxing: 0,
  jin_kangxing: 0,
  mu_kangxing: 0,
  shui_kangxing: 0,
  huo_kangxing: 0,
  tu_kangxing: 0,
  qixue_huifu: 0,
  lingqi_huifu: 0,
  sudu: 10,
  fuyuan: 1,
  qixue: 100,
  lingqi: 100,
});

const createBattleLoadout = (): CharacterBattleLoadout => ({
  setBonusEffects: [],
  skills: [],
});

const createPartnerBattleMember = (
  partnerId: number,
  userId: number,
  nickname: string,
): PartnerBattleMember => ({
  data: {
    ...createComputedRow(partnerId, userId, nickname),
    nickname,
    realm: '',
    sub_realm: null,
  },
  skills: [],
  skillPolicy: { slots: [] },
});

/**
 * 固定参战名单准备回归测试
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：锁定秘境/千层塔这类固定参战名单场景会直接按冻结名单组装队友，避免回退到实时队伍投影。
 * 2. 做什么：验证当前角色缺席时会立即失败，避免战斗启动时进入非法队伍状态。
 * 3. 不做什么：不创建真实 battle engine，也不验证挂机/冷却规则。
 *
 * 输入 / 输出：
 * - 输入：固定参与者列表、按 characterId 索引的在线战斗快照。
 * - 输出：标准 `TeamBattlePreparationResult`。
 *
 * 数据流 / 状态流：
 * 冻结 participants + snapshotMap -> prepareFixedTeamBattleParticipants
 * -> 返回队友列表与 participantUserIds。
 *
 * 关键边界条件与坑点：
 * 1. 队友顺序必须与冻结名单一致，不能因为 Map 遍历顺序变化而漂移。
 * 2. 当前角色若不在冻结名单中必须立即失败，不能偷偷回退到单人开战。
 */

const createSnapshot = (
  characterId: number,
  userId: number,
  nickname: string,
  activePartner: PartnerBattleMember | null = null,
): OnlineBattleCharacterSnapshot => ({
  characterId,
  userId,
  computed: createComputedRow(characterId, userId, nickname),
  loadout: createBattleLoadout(),
  activePartner,
  teamId: 'team-1',
  isTeamLeader: characterId === 1001,
});

test('prepareFixedTeamBattleParticipants: 应按固定名单顺序构建队友与用户列表', () => {
  const participants: FixedBattleParticipant[] = [
    { userId: 101, characterId: 1001 },
    { userId: 102, characterId: 1002 },
    { userId: 103, characterId: 1003 },
  ];
  const snapshots = new Map<number, OnlineBattleCharacterSnapshot>([
    [1001, createSnapshot(1001, 101, '甲')],
    [1002, createSnapshot(1002, 102, '乙')],
    [1003, createSnapshot(1003, 103, '丙')],
  ]);

  const result = prepareFixedTeamBattleParticipants({
    selfCharacterId: 1001,
    participants,
    snapshotsByCharacterId: snapshots,
  });

  assert.equal(result.success, true);
  if (!result.success) {
    assert.fail('预期固定参战名单构建成功');
  }
  assert.deepEqual(result.participantUserIds, [101, 102, 103]);
  assert.deepEqual(
    result.validTeamMembers.map((member) => Number(member.data.id)),
    [1002, 1003],
  );
  assert.deepEqual(result.validTeamMembers.map((member) => member.skills), [[], []]);
});

test('prepareFixedTeamBattleParticipants: 队友应复用统一战前资源恢复规则', () => {
  const participants: FixedBattleParticipant[] = [
    { userId: 101, characterId: 1001 },
    { userId: 102, characterId: 1002 },
  ];
  const teammateSnapshot = createSnapshot(1002, 102, '乙');
  teammateSnapshot.computed.qixue = 17;
  teammateSnapshot.computed.lingqi = 10;
  const snapshots = new Map<number, OnlineBattleCharacterSnapshot>([
    [1001, createSnapshot(1001, 101, '甲')],
    [1002, teammateSnapshot],
  ]);

  const result = prepareFixedTeamBattleParticipants({
    selfCharacterId: 1001,
    participants,
    snapshotsByCharacterId: snapshots,
  });

  assert.equal(result.success, true);
  if (!result.success) {
    assert.fail('预期固定参战名单构建成功');
  }
  assert.equal(result.validTeamMembers[0]?.data.qixue, 100);
  assert.equal(result.validTeamMembers[0]?.data.lingqi, 50);
});

test('prepareFixedTeamBattleParticipants: 当前角色不在固定名单中时应直接失败', () => {
  const participants: FixedBattleParticipant[] = [
    { userId: 102, characterId: 1002 },
  ];
  const snapshots = new Map<number, OnlineBattleCharacterSnapshot>([
    [1002, createSnapshot(1002, 102, '乙')],
  ]);

  const result = prepareFixedTeamBattleParticipants({
    selfCharacterId: 1001,
    participants,
    snapshotsByCharacterId: snapshots,
  });

  assert.equal(result.success, false);
  if (result.success) {
    assert.fail('预期当前角色缺失时直接失败');
  }
  assert.equal(result.result.message, '当前角色不在秘境参战名单中');
});

test('prepareFixedTeamBattleParticipants: 固定名单中的每个队员都应保留自己的出战伙伴', () => {
  const participants: FixedBattleParticipant[] = [
    { userId: 101, characterId: 1001 },
    { userId: 102, characterId: 1002 },
    { userId: 103, characterId: 1003 },
  ];
  const snapshots = new Map<number, OnlineBattleCharacterSnapshot>([
    [1001, createSnapshot(1001, 101, '甲', createPartnerBattleMember(2001, 101, '甲伙伴'))],
    [1002, createSnapshot(1002, 102, '乙', createPartnerBattleMember(2002, 102, '乙伙伴'))],
    [1003, createSnapshot(1003, 103, '丙', null)],
  ]);

  const result = prepareFixedTeamBattleParticipants({
    selfCharacterId: 1001,
    participants,
    snapshotsByCharacterId: snapshots,
  });

  assert.equal(result.success, true);
  if (!result.success) {
    assert.fail('预期固定参战名单构建成功');
  }

  const teammatePartners = result.validTeamMembers.map((member) => {
    return (member as { partnerMember?: PartnerBattleMember | null }).partnerMember ?? null;
  });

  assert.deepEqual(
    teammatePartners.map((partner) => partner?.data.nickname ?? null),
    ['乙伙伴', null],
  );
});
