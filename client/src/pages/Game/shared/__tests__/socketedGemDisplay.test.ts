import { describe, expect, it } from 'vitest';
import { buildSocketedGemDisplayGroups, parseSocketedGems } from '../socketedGemDisplay';

describe('socketedGemDisplay', () => {
  it('能从原始 socketed_gems 构建稳定排序的宝石展示分组', () => {
    const groups = buildSocketedGemDisplayGroups(
      [
        {
          slot: 1,
          itemDefId: 'gem-def-1',
          gemType: 'defense',
          name: '玄甲石',
          effects: [{ attrKey: 'wufang', value: 18, applyType: 'flat' }],
        },
        {
          slot: 0,
          itemDefId: 'gem-atk-1',
          gemType: 'attack',
          name: '赤炎石',
          effects: [
            { attrKey: 'wugong', value: 36, applyType: 'flat' },
            { attrKey: 'baoji', value: 0.12, applyType: 'percent' },
          ],
        },
      ],
      {
        labelResolver: (attrKey) => ({
          wugong: '物攻',
          wufang: '物防',
          baoji: '暴击',
        }[attrKey] ?? attrKey),
        formatSignedNumber: (value) => (value > 0 ? `+${value}` : `${value}`),
        formatSignedPercent: (value) => `${value > 0 ? '+' : ''}${(value * 100).toFixed(0)}%`,
      },
    );

    expect(groups).toStrictEqual([
      {
        slot: 0,
        slotText: '宝石[1]',
        gemName: '赤炎石',
        effects: [
          { label: '物攻', valueText: '+36', text: '物攻 +36' },
          { label: '暴击', valueText: '+12%', text: '暴击 +12%' },
        ],
      },
      {
        slot: 1,
        slotText: '宝石[2]',
        gemName: '玄甲石',
        effects: [{ label: '物防', valueText: '+18', text: '物防 +18' }],
      },
    ]);
  });

  it('会过滤无效宝石结构，避免 tooltip 渲染脏数据', () => {
    const gems = parseSocketedGems(
      JSON.stringify([
        null,
        { slot: -1, itemDefId: 'bad', effects: [{ attrKey: 'wugong', value: 1, applyType: 'flat' }] },
        { slot: 2, itemDefId: 'bad-2', effects: [] },
        {
          slot: 1,
          itemDefId: 'gem-survival-1',
          effects: [{ attrKey: 'max_qixue', value: 120, applyType: 'flat' }],
          name: '生息石',
        },
      ]),
    );

    expect(gems).toStrictEqual([
      {
        slot: 1,
        itemDefId: 'gem-survival-1',
        gemType: 'all',
        effects: [{ attrKey: 'max_qixue', value: 120, applyType: 'flat' }],
        name: '生息石',
        icon: undefined,
      },
    ]);
  });
});
