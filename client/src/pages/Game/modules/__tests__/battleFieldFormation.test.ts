/**
 * BattleArea 阵型配对排布测试
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：锁定“伙伴应站在对应主人前面”的列配对规则，避免阵型层再次把伙伴与主人拆成两组后各自居中。
 * 2. 做什么：同时覆盖下方我方与上方敌方两种朝向，保证前后排方向变化时仍保留同列关系。
 * 3. 不做什么：不测试卡片样式、不测试缩放尺寸，也不覆盖 socket 状态同步。
 *
 * 输入/输出：
 * - 输入：按战斗快照顺序排列的 BattleUnit 列表。
 * - 输出：`resolveBattleFieldFormation` 生成的 `renderCells`。
 *
 * 数据流/状态流：
 * - battle state units -> battleFieldFormation -> BattleTeamPanel 网格渲染。
 *
 * 关键边界条件与坑点：
 * 1. 只有按顺序相邻的“伙伴 + 主人”才能合并成同一列，不能把不同主人之间的伙伴错配。
 * 2. 单独没有伙伴的角色仍应独占一列，不能因为前面存在伙伴配对就被挤进别人的列。
 */

import { describe, expect, it } from 'vitest';

import { resolveBattleFieldFormation } from '../BattleArea/battleFieldFormation';
import type { BattleUnit } from '../BattleArea/types';

const createUnit = (
  id: string,
  unitType: BattleUnit['unitType'],
  name: string,
  formationOrder?: number,
  ownerUnitId?: string,
): BattleUnit => ({
  id,
  name,
  unitType,
  formationOrder,
  ownerUnitId,
  hp: 100,
  maxHp: 100,
  qi: 50,
  maxQi: 50,
});

describe('resolveBattleFieldFormation', () => {
  it('我方阵型中伙伴应站在对应主人的前排同列', () => {
    const formation = resolveBattleFieldFormation('ally', [
      createUnit('partner-1', 'partner', '青木小鸥', 0, 'player-1'),
      createUnit('player-1', 'player', '主人甲'),
      createUnit('player-2', 'player', '主人乙'),
      createUnit('player-3', 'player', '主人丙'),
    ]);

    expect(formation.renderCells.map((unit) => unit?.id ?? null)).toEqual([
      'partner-1',
      null,
      null,
      'player-1',
      'player-2',
      'player-3',
    ]);
  });

  it('敌方阵型中伙伴应站在对应主人的前排同列', () => {
    const formation = resolveBattleFieldFormation('enemy', [
      createUnit('partner-1', 'partner', '青木小鸥', 0, 'player-1'),
      createUnit('player-1', 'player', '主人甲'),
      createUnit('player-2', 'player', '主人乙'),
    ]);

    expect(formation.renderCells.map((unit) => unit?.id ?? null)).toEqual([
      'player-1',
      'player-2',
      'partner-1',
      null,
    ]);
  });

  it('战斗内数组被速度重排后，仍应按稳定展示顺序把伙伴与主人配成同列', () => {
    const formation = resolveBattleFieldFormation('ally', [
      createUnit('partner-2', 'partner', '缚翎后', 2, 'player-2'),
      createUnit('partner-1', 'partner', '青木小偶', 0, 'player-1'),
      createUnit('player-1', 'player', 'AS', 1),
      createUnit('player-3', 'player', 'aaaa', 4),
      createUnit('player-4', 'player', 'tttttt', 5),
      createUnit('player-5', 'player', 'ttgggg', 6),
      createUnit('player-2', 'player', 'A222', 3),
    ]);

    expect(formation.renderCells.map((unit) => unit?.id ?? null)).toEqual([
      'partner-1',
      'partner-2',
      null,
      null,
      null,
      'player-1',
      'player-2',
      'player-3',
      'player-4',
      'player-5',
    ]);
  });
});
