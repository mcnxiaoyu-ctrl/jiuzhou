/**
 * itemService.useItem loot 聚合策略测试
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：锁定使用道具产生的 loot item 在 buffer 前按 itemDefId 聚合。
 * 2. 做什么：锁定 useItem 有慢日志阶段，能区分慢在锁、效果解析、奖励缓冲还是角色刷新。
 * 3. 不做什么：不连接数据库，不执行真实物品使用。
 *
 * 输入 / 输出：
 * - 输入：itemService.ts 源码文本。
 * - 输出：静态结构断言。
 *
 * 数据流 / 状态流：
 * effect_defs -> lootItemsToAdd -> aggregateItemUseLootItems -> bufferSimpleCharacterItemGrants。
 *
 * 复用设计说明：
 * - 聚合函数后续可给礼包、宝石袋、随机资源包共用，避免每个 effect 分支重复 Map 累加逻辑。
 *
 * 关键边界条件与坑点：
 * 1. 聚合只按 itemDefId 合并数量，不能改动货币和学习功法结果。
 * 2. 慢日志不能包住整个 HTTP 路由，只覆盖 useItem 服务内部阶段，避免和路由慢日志重复。
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync(new URL('../itemService.ts', import.meta.url), 'utf8');

test('useItem 应在 bufferSimpleCharacterItemGrants 前聚合 loot item', () => {
  assert.match(source, /const aggregateItemUseLootItems = \(/u);
  assert.match(source, /const aggregatedLootItemsToAdd = aggregateItemUseLootItems\(lootItemsToAdd\);/u);
  assert.match(source, /bufferSimpleCharacterItemGrants\(\s*characterId,\s*userId,\s*aggregatedLootItemsToAdd\.map/u);
});

test('useItem 应输出分段慢日志', () => {
  assert.match(source, /label: 'itemService\.useItem'/u);
  assert.match(source, /slowLogger\.mark\('lockInventoryMutex'/u);
  assert.match(source, /slowLogger\.mark\('aggregateLootItems'/u);
  assert.match(source, /slowLogger\.mark\('bufferLootItems'/u);
  assert.match(source, /slowLogger\.mark\('loadUpdatedCharacter'/u);
});
