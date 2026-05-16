/**
 * 物品使用静态索引策略测试
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：用源码级断言锁定随机宝石与功法定义查询必须走共享静态索引入口。
 * 2. 做什么：锁定 useItem 慢日志拆分，避免后续把上下文加载重新合并成不可定位的单段耗时。
 * 3. 不做什么：不执行真实物品使用、不读取数据库，也不校验随机掉落概率。
 *
 * 输入 / 输出：
 * - 输入：itemService 与 itemUse/staticUseIndex 源码文本。
 * - 输出：关键导入、旧扫描消除、缓存失效条件和慢日志 mark 的静态断言结果。
 *
 * 数据流 / 状态流：
 * 读取源码 -> 检查 itemService 是否复用静态索引与功法读模型
 * -> 检查 staticUseIndex 是否按物品定义数组引用失效并缓存随机宝石候选。
 *
 * 复用设计说明：
 * - 该测试把随机宝石候选筛选和可见功法查询固定到单一入口，避免 useItem、后续礼包或掉落扩展再次复制扫描逻辑。
 * - 与 shared/gemItemSemantics 和 technique/definitionReadModel 形成调用点约束，业务规则变化时只改共享模块。
 *
 * 关键边界条件与坑点：
 * 1. 只检查源码策略，不验证运行期配置内容；配置完整性由数据完整性测试覆盖。
 * 2. 慢日志 mark 名称是观测面契约，重命名会影响线上耗时定位，需要测试明确拦截。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const readSource = (relativePath: string): string => {
  return readFileSync(new URL(relativePath, import.meta.url), 'utf8');
};

test('itemService 随机宝石应复用静态候选索引且不再全量扫描物品定义', () => {
  const source = readSource('../itemService.ts');

  assert.match(source, /getRandomGemItemDefinitionIds/u);
  assert.match(source, /getRandomGemItemDefinitionIds\(\{/u);
  assert.doesNotMatch(source, /getItemDefinitions\(\)\s*\.filter/u);
});

test('itemService 功法学习应复用可见功法读模型且不再扫描功法定义', () => {
  const source = readSource('../itemService.ts');

  assert.match(source, /getVisibleTechniqueDefinitionById/u);
  assert.match(source, /const techniqueDef = getVisibleTechniqueDefinitionById\(techniqueId\);/u);
  assert.match(source, /const techniqueDef = getVisibleTechniqueDefinitionById\(generatedTechniqueId\);/u);
  assert.doesNotMatch(source, /getTechniqueDefinitions\(\)\.find/u);
});

test('随机宝石静态索引应按物品定义数组引用失效并缓存分 scope 候选', () => {
  const source = readSource('../itemUse/staticUseIndex.ts');

  assert.match(source, /source !== itemDefinitions/u);
  assert.match(source, /randomGemIdsByScope/u);
  assert.match(source, /Object\.freeze/u);
});

test('随机宝石 scope key 应使用结构化序列化避免分隔符碰撞', () => {
  const source = readSource('../itemUse/staticUseIndex.ts');

  assert.match(
    source,
    /return JSON\.stringify\(\[subCategories,\s*minLevel,\s*maxLevel\]\);/u,
  );
  assert.doesNotMatch(source, /subCategories\.join\('\|'\)/u);
});

test('useItem 上下文慢日志应拆分到关键阶段', () => {
  const source = readSource('../itemService.ts');

  assert.match(source, /slowLogger\.mark\('loadRealmSnapshot'/u);
  assert.match(source, /slowLogger\.mark\('loadComputedBefore'/u);
  assert.match(source, /slowLogger\.mark\('lockInventoryMutex'/u);
  assert.doesNotMatch(source, /slowLogger\.mark\('loadUseContext'\)/u);
});
