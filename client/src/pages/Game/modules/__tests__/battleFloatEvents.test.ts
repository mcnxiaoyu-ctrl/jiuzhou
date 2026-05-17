/**
 * BattleArea 浮字事件聚合测试。
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：锁定多段命中、持续伤害和持续治疗在同一帧内按单位聚合，避免低端设备被大量短生命周期浮字拖慢。
 * 2. 做什么：验证伤害与治疗保留为两个方向的事件，不被净额抵消。
 * 3. 不做什么：不挂载 React 组件，不验证 CSS 动画，也不测试服务端日志生成。
 *
 * 输入 / 输出：
 * - 输入：前端收到的 BattleLogEntryDto 新增日志片段。
 * - 输出：collectBattleFloatEventsFromLogs 生成的 BattleFloatEvent 列表。
 *
 * 数据流 / 状态流：
 * - BattleArea.lastLogIndexRef 切出的新增日志 -> battleFloatEvents 聚合 -> BattleArea 批量写 floats state。
 *
 * 复用设计说明：
 * - 浮字解析从 BattleArea 主组件抽到纯函数后，本测试与组件共用同一入口，避免后续再把逐 hit setState 写回组件。
 * - 多段命中聚合是当前性能变化点，集中锁在本测试中能约束后续战斗效果扩展继续走批量策略。
 * - 战况文本仍由 logFormatterFast 测试覆盖，本测试只关注动画事件数量和正负方向。
 *
 * 关键边界条件与坑点：
 * 1. 同一单位同一批日志里的多个伤害来源必须合并成一条负数事件。
 * 2. 同一单位同时有伤害和治疗时必须输出两条事件，不能用净值抹掉展示方向。
 */

import { describe, expect, it } from 'vitest';

import type { BattleActionTargetHitDto, BattleLogEntryDto } from '../../../../services/api/combat-realm';
import { collectBattleFloatEventsFromLogs } from '../BattleArea/battleFloatEvents';

const createHit = (index: number, damage: number): BattleActionTargetHitDto => ({
  index,
  damage,
  isMiss: false,
  isCrit: false,
  isParry: false,
  isElementBonus: false,
  shieldAbsorbed: 0,
});

describe('collectBattleFloatEventsFromLogs', () => {
  it('同一批多段命中与持续伤害应按单位聚合为单个伤害浮字', () => {
    const logs: BattleLogEntryDto[] = [
      {
        type: 'action',
        round: 8,
        actorId: 'player-1',
        actorName: '主角',
        skillId: 'skill-combo',
        skillName: '连击',
        targets: [
          {
            targetId: 'monster-1',
            targetName: '塔妖',
            hits: [createHit(1, 12), createHit(2, 18)],
          },
        ],
      },
      {
        type: 'dot',
        round: 8,
        unitId: 'monster-1',
        unitName: '塔妖',
        buffName: '灼烧',
        damage: 7,
      },
    ];

    expect(collectBattleFloatEventsFromLogs(logs)).toEqual([
      { unitId: 'monster-1', value: -37 },
    ]);
  });

  it('同一单位同时受伤和治疗时，应保留两个方向的浮字事件', () => {
    const logs: BattleLogEntryDto[] = [
      {
        type: 'action',
        round: 9,
        actorId: 'monster-1',
        actorName: '塔妖',
        skillId: 'skill-drain',
        skillName: '血引',
        targets: [
          {
            targetId: 'player-1',
            targetName: '主角',
            hits: [createHit(1, 30)],
            heal: 11,
          },
        ],
      },
    ];

    expect(collectBattleFloatEventsFromLogs(logs)).toEqual([
      { unitId: 'player-1', value: -30 },
      { unitId: 'player-1', value: 11 },
    ]);
  });
});
