/**
 * 功法被动属性共享池测试
 *
 * 作用（做什么 / 不做什么）：
 * 1) 做什么：验证功法被动 key 白名单与共享候选池保持一致，确保 AI 可在所有受支持 key 中自由搭配。
 * 2) 不做什么：不测试 AI 调用，不覆盖完整 prompt 文本，仅锁定共享约束常量。
 *
 * 输入/输出：
 * - 输入：功法被动白名单查询函数、全部支持 key 与按类型导出的共享被动池。
 * - 输出：布尔断言，确认支持集合与共享被动池没有漂移。
 *
 * 数据流/状态流：
 * - 被动语义字典 -> 支持 key 集合 -> 共享被动池 -> 各功法类型复用同一份 AI 候选集合。
 *
 * 关键边界条件与坑点：
 * 1) 只改 `TECHNIQUE_PASSIVE_KEY_MEANING_MAP` 而漏改共享被动池时，AI 候选集合会缺项，本测试会直接拦住。
 * 2) 若重新引入按类型裁剪而没有同步调整断言，会导致“自由搭配”约束退化，本测试同样会覆盖。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SUPPORTED_TECHNIQUE_PASSIVE_KEYS,
  TECHNIQUE_PASSIVE_KEY_POOL_BY_TYPE,
  isSupportedTechniquePassiveKey,
} from '../shared/techniqueGenerationConstraints.js';

test('暴伤减免应被识别为受支持的功法被动属性', () => {
  assert.equal(isSupportedTechniquePassiveKey('jianbaoshang'), true);
});

test('所有功法类型共享完整被动池，允许 AI 自由搭配', () => {
  const expectedKeys = [...SUPPORTED_TECHNIQUE_PASSIVE_KEYS];
  const techniqueTypes = Object.keys(TECHNIQUE_PASSIVE_KEY_POOL_BY_TYPE) as Array<keyof typeof TECHNIQUE_PASSIVE_KEY_POOL_BY_TYPE>;

  for (const techniqueType of techniqueTypes) {
    const actualKeys = TECHNIQUE_PASSIVE_KEY_POOL_BY_TYPE[techniqueType].map((entry) => entry.key);
    assert.deepEqual(actualKeys, expectedKeys);
  }
});
