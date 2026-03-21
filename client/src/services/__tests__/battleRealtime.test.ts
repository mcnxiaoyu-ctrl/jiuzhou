/**
 * 战斗实时增量归一化测试
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：验证 `normalizeBattleRealtimePayload` 在 `unitsDelta` 场景下会按单位 ID 合并状态，避免静态字段被后续增量覆盖丢失。
 * 2. 做什么：锁定伙伴头像在战斗首帧存在、后续状态仅更新动态字段时仍然持续可用，避免 BattleArea 再次出现“伙伴头像不显示”的回归。
 * 3. 不做什么：不测试 BattleArea 样式，也不覆盖 socket 订阅流程。
 *
 * 输入/输出：
 * - 输入：battle_started 全量状态、battle_state 增量状态。
 * - 输出：归一化后的完整前端 realtime payload。
 *
 * 数据流/状态流：
 * - 服务端 battle:update 原始消息 -> normalizeBattleRealtimePayload -> 前端缓存完整战斗状态。
 *
 * 关键边界条件与坑点：
 * 1. 这里只验证同一 battleId 的 `unitsDelta` 合并，不能把跨战斗的状态错误拼接在一起。
 * 2. 增量包里的单位字段必须允许只覆盖动态值，静态字段要从上一帧继承，而不是在调用方组件里临时兜底。
 */

import { describe, expect, it } from 'vitest';

import type { BattleRealtimeStatePayload } from '../battleRealtime';
import { normalizeBattleRealtimePayload } from '../battleRealtime';

const createUnit = (overrides: {
  id: string;
  name: string;
  type: 'player' | 'monster' | 'npc' | 'summon' | 'partner';
  avatar?: string | null;
  qixue?: number;
  lingqi?: number;
}): BattleRealtimeStatePayload['state']['teams']['attacker']['units'][number] => ({
  id: overrides.id,
  name: overrides.name,
  type: overrides.type,
  monthCardActive: overrides.type === 'player',
  avatar: overrides.avatar ?? null,
  qixue: overrides.qixue ?? 100,
  lingqi: overrides.lingqi ?? 50,
  currentAttrs: {
    max_qixue: 100,
    max_lingqi: 50,
    realm: overrides.type === 'partner' ? undefined : '炼气境',
  },
  isAlive: true,
  buffs: [],
});

const createStatePayload = (): BattleRealtimeStatePayload => ({
  kind: 'battle_started',
  battleId: 'battle-1',
  state: {
    battleId: 'battle-1',
    battleType: 'pve',
    teams: {
      attacker: {
        odwnerId: 1,
        totalSpeed: 100,
        units: [
          createUnit({
            id: 'player-1',
            name: '主角',
            type: 'player',
            avatar: '/uploads/avatar/player-1.png',
          }),
          createUnit({
            id: 'partner-7',
            name: '青木小鸥',
            type: 'partner',
            avatar: '/assets/partner/partner-qingmu-xiaoou.webp',
          }),
        ],
      },
      defender: {
        odwnerId: 0,
        totalSpeed: 80,
        units: [
          createUnit({
            id: 'monster-1',
            name: '山狼',
            type: 'monster',
            avatar: null,
          }),
        ],
      },
    },
    roundCount: 1,
    currentTeam: 'attacker',
    currentUnitId: 'player-1',
    phase: 'action',
    firstMover: 'attacker',
  },
  logs: [],
  logStart: 0,
  logDelta: false,
});

describe('normalizeBattleRealtimePayload', () => {
  it('unitsDelta 增量应保留伙伴头像等静态字段', () => {
    const previous = createStatePayload();

    const normalized = normalizeBattleRealtimePayload(
      {
        kind: 'battle_state',
        battleId: 'battle-1',
        unitsDelta: true,
        state: {
          battleId: 'battle-1',
          battleType: 'pve',
          teams: {
            attacker: {
              odwnerId: 1,
              totalSpeed: 100,
              units: [
                {
                  id: 'player-1',
                  name: '主角',
                  type: 'player',
                  qixue: 90,
                  lingqi: 40,
                  currentAttrs: {
                    max_qixue: 100,
                    max_lingqi: 50,
                    realm: '炼气境',
                  },
                  isAlive: true,
                  buffs: [],
                },
                {
                  id: 'partner-7',
                  name: '青木小鸥',
                  type: 'partner',
                  qixue: 88,
                  lingqi: 35,
                  currentAttrs: {
                    max_qixue: 100,
                    max_lingqi: 50,
                  },
                  isAlive: true,
                  buffs: [],
                },
              ],
            },
            defender: {
              odwnerId: 0,
              totalSpeed: 80,
              units: [
                {
                  id: 'monster-1',
                  name: '山狼',
                  type: 'monster',
                  qixue: 75,
                  lingqi: 20,
                  currentAttrs: {
                    max_qixue: 100,
                    max_lingqi: 50,
                    realm: '妖兽',
                  },
                  isAlive: true,
                  buffs: [],
                },
              ],
            },
          },
          roundCount: 1,
          currentTeam: 'attacker',
          currentUnitId: 'partner-7',
          phase: 'action',
          firstMover: 'attacker',
        },
        logs: [],
        logStart: 0,
        logDelta: false,
      },
      previous,
    );

    expect(normalized?.kind).toBe('battle_state');
    if (!normalized || normalized.kind === 'battle_abandoned') {
      throw new Error('预期返回战斗状态 payload');
    }

    expect(normalized.state.teams.attacker.units[1]?.avatar).toBe(
      '/assets/partner/partner-qingmu-xiaoou.webp',
    );
    expect(normalized.state.teams.attacker.units[1]?.qixue).toBe(88);
    expect(normalized.state.currentUnitId).toBe('partner-7');
  });
});
