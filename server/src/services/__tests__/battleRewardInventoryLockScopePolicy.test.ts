/**
 * 战斗奖励库存锁范围策略回归测试
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：锁定多角色战斗奖励结算时，库存锁、自动分解配置读取只覆盖真实掉落接收者。
 * 2. 做什么：防止纯经验/银两奖励继续按全部参与者加库存锁，避免无物品变更时扩大锁范围。
 * 3. 不做什么：不执行真实战斗结算、不连接数据库，也不校验掉落概率和物品创建细节。
 *
 * 输入 / 输出：
 * - 输入：battleDropService 源码文本。
 * - 输出：库存目标解析、库存锁调用、自动分解查询和慢日志字段的静态断言结果。
 *
 * 数据流 / 状态流：
 * plan.drops -> resolveBattleDropInventoryTargetIds -> inventoryTargetCharacterIds
 * -> lockCharacterRewardInventoryTargets / 自动分解配置查询；plan.perPlayerRewards 仍只用于奖励 delta 聚合。
 *
 * 复用设计说明：
 * - 测试约束单一库存目标解析入口，避免锁目标、查询目标在结算流程内各自重复拼装。
 * - 该入口被库存锁和自动分解配置查询共同复用，掉落接收者规则变化时只维护一处。
 *
 * 关键边界条件与坑点：
 * 1. `requiresInventoryMutation` 必须由真实库存目标数量决定，不能由参与者数量决定。
 * 2. 经验/银两 delta 仍来自 `perPlayerRewards`，不能因为库存锁范围收窄而漏发非物品奖励。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const readSource = (relativePath: string): string => {
  return readFileSync(new URL(relativePath, import.meta.url), 'utf8');
};

const getRequiredMatch = (source: string, pattern: RegExp, message: string): RegExpMatchArray => {
  const match = source.match(pattern);
  assert.ok(match, message);
  return match;
};

test('战斗奖励库存锁目标应只来自实际掉落接收者', () => {
  const source = readSource('../battleDropService.ts');

  assert.match(source, /const resolveBattleDropInventoryTargetIds = \(\s*plan: BattleRewardSettlementPlan,\s*\): number\[\] => \{/u);
  assert.match(
    source,
    /return normalizeCharacterRewardTargetIds\(\s*plan\.drops\.map\(\(drop\) => Number\(drop\.receiverCharacterId\)\),\s*\);/u,
  );
  assert.match(source, /const inventoryTargetCharacterIds = resolveBattleDropInventoryTargetIds\(plan\);/u);
  assert.match(source, /const requiresInventoryMutation = inventoryTargetCharacterIds\.length > 0;/u);
  assert.match(source, /await lockCharacterRewardInventoryTargets\(inventoryTargetCharacterIds\);/u);

  const mutationScope = getRequiredMatch(
    source,
    /const inventoryTargetCharacterIds = resolveBattleDropInventoryTargetIds\(plan\);[\s\S]*?const slowLogger = createSlowOperationLogger/u,
    '缺少库存目标解析到慢日志初始化之间的结算片段',
  )[0];
  assert.doesNotMatch(mutationScope, /plan\.perPlayerRewards\.map\(\(reward\) => Number\(reward\.characterId\)\)/u);
});

test('战斗奖励库存锁等待应独立慢日志并输出库存目标数量', () => {
  const source = readSource('../battleDropService.ts');

  assert.match(
    source,
    /slowLogger\.mark\('lockRewardInventoryTargets', \{\s*inventoryTargetCount: inventoryTargetCharacterIds\.length,\s*\}\);/u,
  );
});

test('自动分解设置只查询真实掉落接收者', () => {
  const source = readSource('../battleDropService.ts');

  const settingsBlock = getRequiredMatch(
    source,
    /if \(requiresInventoryMutation\) \{[\s\S]*?const settingResult = await query\([\s\S]*?\[inventoryTargetCharacterIds\],[\s\S]*?slowLogger\.mark\('loadAutoDisassembleSettings'/u,
    '自动分解设置查询未使用库存目标角色集合',
  )[0];
  assert.doesNotMatch(settingsBlock, /\[participantCharacterIds\]/u);
  assert.doesNotMatch(settingsBlock, /plan\.perPlayerRewards\.map\(\(reward\) => Number\(reward\.characterId\)\)/u);
});
