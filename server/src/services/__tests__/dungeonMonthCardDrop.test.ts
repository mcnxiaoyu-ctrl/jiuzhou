/**
 * 还虚天台月卡掉落配置测试
 *
 * 作用（做什么 / 不做什么）：
 * - 做什么：锁定还虚天台最后一波 BOSS「归墟领主」的掉落池配置，确保修行月卡只在这一处按千分之一概率掉落。
 * - 做什么：验证月卡仍然挂在怪物掉落池，而不是散落到秘境通关奖励或其他额外结算逻辑里。
 * - 不做什么：不执行真实战斗、不校验掉落分发流程，也不覆盖其他秘境 BOSS 掉落池。
 *
 * 输入/输出：
 * - 输入：还虚天台秘境种子、怪物种子、掉落池种子。
 * - 输出：归墟领主掉落池中的修行月卡条目断言。
 *
 * 数据流/状态流：
 * - 先从还虚天台种子读取最后一波 BOSS；
 * - 再从 monster_def.json 解析该 BOSS 的唯一掉落池；
 * - 最后在 drop_pool.json 中断言修行月卡条目与概率数值。
 *
 * 关键边界条件与坑点：
 * 1) 这次需求只限定“还虚天台最后一波 BOSS”，测试不能把其他秘境 BOSS 误纳入范围，否则后续数值调整会被误拦。
 * 2) 月卡条目必须直接存在于专属掉落池里，不能只依赖公共池继承，否则排查时很难从单一入口看清实际配置。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { asArray, asObject, asText, buildObjectMap, loadSeed } from './seedTestUtils.js';

const HUIXU_DUNGEON_FILE = 'dungeon_qi_cultivation_13.json';
const HUIXU_FINAL_BOSS_ID = 'monster-boss-huanxu-guixu-lord';
const HUIXU_FINAL_BOSS_DROP_POOL_ID = 'dp-huanxu-boss-guixu-lord';
const MONTH_CARD_ITEM_DEF_ID = 'cons-monthcard-001';
const MONTH_CARD_DROP_CHANCE = 0.001;

const toNumber = (value: unknown): number => {
  if (typeof value === 'number') return value;
  if (typeof value === 'string') return Number(value);
  return Number.NaN;
};

const collectHuixuFinalWaveBossIds = (): string[] => {
  const dungeonSeed = loadSeed(HUIXU_DUNGEON_FILE);
  const bossIds = new Set<string>();

  for (const dungeonEntry of asArray(dungeonSeed.dungeons)) {
    const dungeon = asObject(dungeonEntry);
    for (const difficultyEntry of asArray(dungeon?.difficulties)) {
      const difficulty = asObject(difficultyEntry);
      const stages = asArray(difficulty?.stages);
      const lastStage = stages.at(-1);
      const lastStageObject = asObject(lastStage);
      const waves = asArray(lastStageObject?.waves);
      const lastWave = asObject(waves.at(-1));
      for (const monsterEntry of asArray(lastWave?.monsters)) {
        const monster = asObject(monsterEntry);
        const monsterDefId = asText(monster?.monster_def_id);
        if (monsterDefId.startsWith('monster-boss-')) {
          bossIds.add(monsterDefId);
        }
      }
    }
  }

  return Array.from(bossIds).sort();
};

test('还虚天台最后一波 BOSS 掉落池应包含修行月卡', () => {
  const finalWaveBossIds = collectHuixuFinalWaveBossIds();
  assert.deepEqual(finalWaveBossIds, [HUIXU_FINAL_BOSS_ID]);

  const monsterSeed = loadSeed('monster_def.json');
  const dropPoolSeed = loadSeed('drop_pool.json');
  const monsterById = buildObjectMap(asArray(monsterSeed.monsters), 'id');
  const dropPoolById = buildObjectMap(asArray(dropPoolSeed.pools), 'id');

  const bossDef = monsterById.get(HUIXU_FINAL_BOSS_ID);
  assert.ok(bossDef, `monster_def.json 缺少怪物定义: ${HUIXU_FINAL_BOSS_ID}`);

  const dropPoolId = asText(bossDef?.drop_pool_id);
  assert.equal(dropPoolId, HUIXU_FINAL_BOSS_DROP_POOL_ID);

  const dropPool = dropPoolById.get(dropPoolId);
  assert.ok(dropPool, `drop_pool.json 缺少掉落池定义: ${dropPoolId}`);

  const monthCardEntry = asArray(dropPool?.entries).find((entry) => asText(asObject(entry)?.item_def_id) === MONTH_CARD_ITEM_DEF_ID);
  const monthCardEntryObject = asObject(monthCardEntry);
  assert.ok(monthCardEntryObject, `${dropPoolId} 缺少月卡掉落条目 ${MONTH_CARD_ITEM_DEF_ID}`);
  assert.equal(toNumber(monthCardEntryObject?.chance), MONTH_CARD_DROP_CHANCE);
  assert.equal(toNumber(monthCardEntryObject?.qty_min), 1);
  assert.equal(toNumber(monthCardEntryObject?.qty_max), 1);
});
