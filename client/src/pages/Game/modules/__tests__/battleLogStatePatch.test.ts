/**
 * BattleArea 日志气血补丁测试。
 *
 * 作用（做什么 / 不做什么）：
 * - 做什么：验证新增日志能把伙伴治疗量同步到 BattleStateDto.qixue，修复“治疗浮字有、血条不动”的显示断层。
 * - 做什么：验证服务端快照已包含治疗结果时不会双加。
 * - 不做什么：不测试日志文案、不测试 socket 合并，也不渲染战斗组件。
 *
 * 输入 / 输出：
 * - 输入：当前状态、即将渲染的状态、新增日志。
 * - 输出：applyBattleLogQixuePatch 返回的战斗状态。
 *
 * 数据流 / 状态流：
 * - BattleArea.lastLogIndexRef 切出的新日志 -> applyBattleLogQixuePatch
 * - 当前 UI qixue + 日志 delta -> 下一帧用于 BattleUnitCard 的 qixue。
 *
 * 复用设计说明：
 * - 所有日志驱动的气血修正共用 battleLogStatePatch，避免浮字和血条各自维护一套 action/dot/hot/aura 解析。
 * - 测试直接复用 BattleStateDto/BattleLogEntryDto 类型，保证补丁输入与真实 socket payload 一致。
 * - 伙伴治疗是当前高频问题点，单测锁住 partner 类型，后续玩家/怪物同样走同一 ID 索引逻辑。
 *
 * 关键边界条件与坑点：
 * 1. 补丁以 currentState 为基准，避免服务端 nextState 已更新时重复加治疗。
 * 2. 补丁必须按 max_qixue 截断，避免日志叠加把显示血量推过上限。
 */

import { describe, expect, it } from 'vitest';

import type { BattleLogEntryDto, BattleStateDto, BattleUnitDto } from '../../../../services/api/combat-realm';
import { applyBattleLogQixuePatch } from '../BattleArea/battleLogStatePatch';

const createUnit = (
  overrides: Pick<BattleUnitDto, 'id' | 'name' | 'type'> & Partial<BattleUnitDto>,
): BattleUnitDto => ({
  id: overrides.id,
  name: overrides.name,
  type: overrides.type,
  qixue: overrides.qixue ?? 100,
  lingqi: overrides.lingqi ?? 50,
  currentAttrs: overrides.currentAttrs ?? {
    max_qixue: 100,
    max_lingqi: 50,
  },
  isAlive: overrides.isAlive ?? true,
  buffs: overrides.buffs ?? [],
  formationOrder: overrides.formationOrder,
  ownerUnitId: overrides.ownerUnitId,
  monthCardActive: overrides.monthCardActive,
  avatar: overrides.avatar,
});

const createState = (
  attackerUnits: BattleUnitDto[],
  defenderUnits: BattleUnitDto[],
): BattleStateDto => ({
  battleId: 'battle-1',
  battleType: 'pve',
  teams: {
    attacker: {
      odwnerId: 1,
      totalSpeed: 100,
      units: attackerUnits,
    },
    defender: {
      odwnerId: 0,
      totalSpeed: 80,
      units: defenderUnits,
    },
  },
  roundCount: 1,
  currentTeam: 'attacker',
  currentUnitId: 'player-1',
  phase: 'action',
  firstMover: 'attacker',
});

const createHealLog = (targetId: string, targetName: string, heal: number): BattleLogEntryDto => ({
  type: 'action',
  round: 1,
  actorId: 'player-1',
  actorName: '主角',
  skillId: 'skill-huifu',
  skillName: '治愈术',
  targets: [
    {
      targetId,
      targetName,
      hits: [],
      heal,
    },
  ],
});

describe('applyBattleLogQixuePatch', () => {
  it('服务端快照滞后时，应按治疗日志修正伙伴气血', () => {
    const current = createState(
      [
        createUnit({ id: 'partner-7', name: '青木小鸥', type: 'partner', qixue: 40 }),
        createUnit({ id: 'player-1', name: '主角', type: 'player', qixue: 90 }),
      ],
      [createUnit({ id: 'monster-1', name: '山狼', type: 'monster' })],
    );
    const next = createState(
      [
        createUnit({ id: 'partner-7', name: '青木小鸥', type: 'partner', qixue: 40 }),
        createUnit({ id: 'player-1', name: '主角', type: 'player', qixue: 90 }),
      ],
      [createUnit({ id: 'monster-1', name: '山狼', type: 'monster' })],
    );

    const patched = applyBattleLogQixuePatch(next, current, [
      createHealLog('partner-7', '青木小鸥', 35),
    ]);

    expect(patched.teams.attacker.units[0]?.qixue).toBe(75);
  });

  it('服务端快照已包含治疗结果时，不应重复叠加治疗日志', () => {
    const current = createState(
      [
        createUnit({ id: 'partner-7', name: '青木小鸥', type: 'partner', qixue: 40 }),
        createUnit({ id: 'player-1', name: '主角', type: 'player', qixue: 90 }),
      ],
      [createUnit({ id: 'monster-1', name: '山狼', type: 'monster' })],
    );
    const next = createState(
      [
        createUnit({ id: 'partner-7', name: '青木小鸥', type: 'partner', qixue: 75 }),
        createUnit({ id: 'player-1', name: '主角', type: 'player', qixue: 90 }),
      ],
      [createUnit({ id: 'monster-1', name: '山狼', type: 'monster' })],
    );

    const patched = applyBattleLogQixuePatch(next, current, [
      createHealLog('partner-7', '青木小鸥', 35),
    ]);

    expect(patched.teams.attacker.units[0]?.qixue).toBe(75);
  });
});
