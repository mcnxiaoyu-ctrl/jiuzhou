import test from 'node:test';
import assert from 'node:assert/strict';
import {
  GLOBAL_BUFF_KEY_FUYUAN_FLAT,
  applyCharacterGlobalBuffValuesToStats,
  buildCharacterGlobalBuffSignaturePart,
} from '../shared/characterGlobalBuff.js';
import { getSectBlessingFuyuanBonusByLevel } from '../sect/blessing.js';

test('全局 Buff 签名应稳定包含已接入计算链的键', () => {
  const signature = buildCharacterGlobalBuffSignaturePart({
    [GLOBAL_BUFF_KEY_FUYUAN_FLAT]: 3.5,
  });

  assert.equal(signature, 'fuyuan_flat:3.5');
});

test('全局 Buff 应按统一入口叠加到角色属性', () => {
  const stats = { fuyuan: 21 };

  applyCharacterGlobalBuffValuesToStats(stats, {
    [GLOBAL_BUFF_KEY_FUYUAN_FLAT]: 4.5,
  });

  assert.equal(stats.fuyuan, 25.5);
});

test('祈福殿福源加成应按等级每级 0.5 点递增并在 50 级封顶', () => {
  assert.equal(getSectBlessingFuyuanBonusByLevel(0), 0);
  assert.equal(getSectBlessingFuyuanBonusByLevel(1), 0.5);
  assert.equal(getSectBlessingFuyuanBonusByLevel(25), 12.5);
  assert.equal(getSectBlessingFuyuanBonusByLevel(50), 25);
  assert.equal(getSectBlessingFuyuanBonusByLevel(99), 25);
});
