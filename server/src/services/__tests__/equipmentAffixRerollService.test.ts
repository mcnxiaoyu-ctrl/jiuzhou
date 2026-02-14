import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseGeneratedAffixesForReroll,
  rerollEquipmentAffixesWithLocks,
  type RerollAffixPool,
} from '../equipmentAffixRerollService.js';
import type { GeneratedAffix } from '../equipmentService.js';

test('special词条缺失attr_key时应在解析阶段保留并回填', () => {
  const parsed = parseGeneratedAffixesForReroll([
    {
      key: 'proc_lingchao',
      name: '灵潮',
      apply_type: 'special',
      tier: 6,
      value: 0.25,
      trigger: 'on_turn_start',
      target: 'self',
      effect_type: 'resource',
      params: {
        attr_key: 'lingqi_restore_percent',
      },
    },
    {
      key: 'proc_baonu',
      name: '暴怒',
      apply_type: 'special',
      tier: 5,
      value: 12,
      trigger: 'on_hit',
      target: 'enemy',
      effect_type: 'damage',
    },
  ]);

  assert.equal(parsed.length, 2);
  assert.equal(parsed[0]?.attr_key, 'lingqi_restore_percent');
  assert.equal(parsed[1]?.attr_key, 'proc_baonu');
});

test('洗炼生成special词条时应产出可稳定回写的attr_key', () => {
  const currentAffixes: GeneratedAffix[] = [
    {
      key: 'wugong_flat',
      name: '物攻+',
      attr_key: 'wugong',
      apply_type: 'flat',
      tier: 1,
      value: 5,
    },
  ];

  const pool: RerollAffixPool = {
    rules: {
      count_by_quality: {
        黄: { min: 1, max: 1 },
        玄: { min: 1, max: 1 },
        地: { min: 1, max: 1 },
        天: { min: 1, max: 1 },
      },
      allow_duplicate: false,
    },
    affixes: [
      {
        key: 'proc_test',
        name: '测试触发',
        attr_key: '',
        apply_type: 'special',
        group: 'trigger',
        weight: 100,
        trigger: 'on_hit',
        target: 'enemy',
        effect_type: 'damage',
        params: { damage_type: 'true' },
        tiers: [
          {
            tier: 5,
            min: 10,
            max: 10,
            realm_rank_min: 1,
          },
        ],
      },
    ],
  };

  const rerollResult = rerollEquipmentAffixesWithLocks({
    currentAffixes,
    lockIndexes: [],
    pool,
    quality: '黄',
    realmRank: 1,
    attrFactor: 1,
  });

  assert.equal(rerollResult.success, true);
  assert.ok(rerollResult.affixes);
  assert.equal(rerollResult.affixes?.length, 1);
  assert.equal(rerollResult.affixes?.[0]?.attr_key, 'proc_test');
});
