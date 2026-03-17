import { describe, expect, it, vi } from 'vitest';

import {
  buildAutoRerollTargetOptions,
  getAffordableAutoRerollTimes,
  hasMatchedAutoRerollTargets,
  runAutoRerollUntilMatch,
} from '../autoReroll';

describe('autoReroll', () => {
  it('应合并词条池与当前词条并去重输出目标选项', () => {
    expect(buildAutoRerollTargetOptions(
      [
        { key: 'crit', name: '暴击', group: 'atk', is_legendary: false, apply_type: 'flat', tiers: [], owned: false },
      ],
      [
        { key: 'crit', name: '暴击', apply_type: 'flat', tier: 1, value: 10 },
        { key: 'speed', name: '速度', apply_type: 'flat', tier: 1, value: 8 },
      ],
    )).toEqual([
      { key: 'crit', label: '暴击（crit）' },
      { key: 'speed', label: '速度（speed）' },
    ]);
  });

  it('命中判断应按去空去重后的目标 key 执行', () => {
    expect(hasMatchedAutoRerollTargets(
      [
        { key: 'crit', name: '暴击', apply_type: 'flat', tier: 1, value: 10 },
        { key: 'speed', name: '速度', apply_type: 'flat', tier: 1, value: 8 },
      ],
      ['crit', ' ', 'speed', 'crit'],
    )).toBe(true);
  });

  it('可执行次数应受最紧资源约束限制', () => {
    expect(getAffordableAutoRerollTimes({
      rerollScrollOwned: 10,
      rerollScrollCost: 2,
      spiritStoneOwned: 90,
      spiritStoneCost: 30,
      silverOwned: 1_000,
      silverCost: 100,
      maxAttempts: 8,
    })).toBe(3);
  });

  it('自动洗炼执行器应在命中目标后立即停止', async () => {
    const reroll = vi.fn()
      .mockResolvedValueOnce({
        success: true,
        message: 'ok',
        data: {
          affixes: [{ key: 'crit', name: '暴击', apply_type: 'flat', tier: 1, value: 10 }],
          lockIndexes: [0],
          costs: {
            silver: 100,
            spiritStones: 10,
            rerollScroll: { itemDefId: 'scroll-003', qty: 1 },
          },
          character: null,
        },
      })
      .mockResolvedValueOnce({
        success: true,
        message: 'ok',
        data: {
          affixes: [
            { key: 'crit', name: '暴击', apply_type: 'flat', tier: 1, value: 10 },
            { key: 'speed', name: '速度', apply_type: 'flat', tier: 1, value: 8 },
          ],
          lockIndexes: [0],
          costs: {
            silver: 100,
            spiritStones: 10,
            rerollScroll: { itemDefId: 'scroll-003', qty: 1 },
          },
          character: null,
        },
      });

    const result = await runAutoRerollUntilMatch({
      itemId: 1,
      lockIndexes: [0],
      initialAffixes: [{ key: 'crit', name: '暴击', apply_type: 'flat', tier: 1, value: 10 }],
      targetKeys: ['crit', 'speed'],
      maxAttempts: 5,
      reroll,
    });

    expect(result.stopReason).toBe('matched');
    expect(result.attempts).toBe(2);
    expect(reroll).toHaveBeenCalledTimes(2);
  });
});
