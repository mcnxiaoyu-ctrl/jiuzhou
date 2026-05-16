/**
 * 战斗奖励计划热路径策略测试
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：静态锁定奖励计划构建只能复用既有怪物静态索引，避免缓存 miss 时扫描全量 monster_def。
 * 2. 做什么：约束掉落归属回填必须使用角色奖励 Map，避免掉落数乘参与人数的重复线性扫描。
 * 3. 不做什么：不执行随机掉落、不连接数据库，也不验证概率分布。
 *
 * 输入 / 输出：
 * - 输入：battleDropService 源码文本。
 * - 输出：静态索引复用、Map 回填和禁止重复扫描的断言结果。
 *
 * 数据流 / 状态流：
 * monsterIds -> resolveRewardMonsters -> getEnabledBattleMonsterDefinitionMap
 * -> planBattleRewards -> perPlayerRewardByCharacterId -> drops 回填到单个角色奖励。
 *
 * 复用设计说明：
 * - 怪物启用态规则由 battle/shared/staticDefinitionIndex 单一入口维护，奖励服务只消费索引。
 * - 角色奖励数组和角色奖励 Map 在同一轮参与者遍历中生成，避免后续掉落回填重新查找。
 *
 * 关键边界条件与坑点：
 * 1. resolveRewardMonsters 必须保留输入 monsterIds 的重复项，否则多只同种怪奖励会少算。
 * 2. 角色奖励 Map 只能用于回填 drops，最终返回仍保留数组结构，避免改变调用方协议。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync(
  new URL('../battleDropService.ts', import.meta.url),
  'utf8',
);

test('奖励怪物快照应复用既有启用怪物索引，禁止缓存 miss 时扫描全量定义', () => {
  assert.match(
    source,
    /import \{ getEnabledBattleMonsterDefinitionMap \} from '\.\/battle\/shared\/staticDefinitionIndex\.js';/u,
  );
  assert.match(source, /getEnabledBattleMonsterDefinitionMap\(\)\.get\(normalizedMonsterId\)/u);
  assert.doesNotMatch(source, /getMonsterDefinitions\(\)\.find/u);
});

test('奖励计划回填掉落时应使用角色奖励 Map，禁止按掉落重复 find', () => {
  assert.match(
    source,
    /const perPlayerRewardByCharacterId = new Map<number, PlannedBattlePlayerReward>\(\);/u,
  );
  assert.match(
    source,
    /perPlayerRewardByCharacterId\.set\(participant\.characterId, playerReward\);/u,
  );
  assert.match(
    source,
    /const playerReward = perPlayerRewardByCharacterId\.get\(drop\.receiverCharacterId\);/u,
  );
  assert.doesNotMatch(source, /perPlayerRewards\.find\(/u);
});
