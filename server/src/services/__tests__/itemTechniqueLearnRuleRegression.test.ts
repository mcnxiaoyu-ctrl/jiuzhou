/**
 * itemService 功法学习境界规则回归测试
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：锁定 `itemService.useItem` 的普通功法书与洞府研修功法书都必须复用共享学习境界规则入口。
 * 2. 做什么：防止 `learn_generated_technique` 分支再次绕开 `shouldValidateTechniqueLearnRealm`，导致 AI 生成功法重新出现境界门槛。
 * 3. 不做什么：不执行真实物品使用事务、不连接数据库，也不覆盖掉落与冷却逻辑。
 *
 * 输入/输出：
 * - 输入：`itemService.ts` 源码文本。
 * - 输出：源码片段是否按预期复用共享规则的断言结果。
 *
 * 数据流/状态流：
 * 读取源码 -> 匹配 `learn_technique` / `learn_generated_technique` 两条分支
 * -> 断言两者都通过 `shouldValidateTechniqueLearnRealm` 决定是否执行学习境界拦截。
 *
 * 复用设计说明：
 * - 继续沿用仓库里已有的“源码回归测试”模式，只锁定这次 bug 对应的实现约束，避免为单个判定引入高成本集成夹具。
 * - 该测试和 `techniqueLearnRule.test.ts` 互补：前者验证调用点是否复用共享规则，后者验证共享规则本身的业务语义。
 *
 * 关键边界条件与坑点：
 * 1. 必须同时约束普通功法分支和生成功法分支，否则只修其中一条仍可能出现规则漂移。
 * 2. 这里只检查源码结构，不验证运行期 SQL 与背包扣减流程；运行期正确性由共享规则和隐藏用例继续兜底。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const readSource = (relativePath: string): string => {
  return readFileSync(new URL(relativePath, import.meta.url), 'utf8');
};

test('useItem 的普通功法书与生成功法书都应复用共享学习境界规则', () => {
  const source = readSource('../itemService.ts');

  assert.match(
    source,
    /if \(effectType === 'learn_technique'\) \{[\s\S]*shouldValidateTechniqueLearnRealm\(\{ effectType: 'learn_technique', itemDefId \}\)[\s\S]*境界不足，需要达到\$\{requiredRealm\}/u,
  );
  assert.match(
    source,
    /if \(effectType === 'learn_generated_technique'\) \{[\s\S]*shouldValidateTechniqueLearnRealm\(\{ effectType: 'learn_generated_technique', itemDefId \}\)[\s\S]*境界不足，需要达到\$\{requiredRealm\}/u,
  );
  assert.doesNotMatch(
    source,
    /if \(effectType === 'learn_generated_technique'\) \{[\s\S]*const requiredRealm = String\(techniqueDef\.required_realm \|\| ''\)\.trim\(\);\s*if \(!isRealmSufficient/u,
  );
});