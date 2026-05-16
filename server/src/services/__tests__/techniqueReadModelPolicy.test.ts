/**
 * 功法读模型索引策略回归测试
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：静态锁定 techniqueService 必须复用功法定义读模型，避免请求路径重新扫描功法、层级与技能静态数组。
 * 2. 做什么：锁定读模型必须按源数组引用失效，并暴露功法、层级、技能的索引入口。
 * 3. 不做什么：不加载真实静态配置，不校验具体业务数据排序结果，也不访问数据库。
 *
 * 输入/输出：
 * - 输入：techniqueService 与 technique/definitionReadModel 源码文本。
 * - 输出：源码结构与性能策略断言。
 *
 * 数据流/状态流：
 * 读取源码 -> 校验服务层导入读模型 -> 校验旧扫描模式被移除 -> 校验读模型快照字段与引用失效逻辑。
 *
 * 关键边界条件与坑点：
 * 1. 这是性能策略测试，重点锁请求热路径不得退回 `getXDefinitions().filter/find`，不绑定运行时 mock。
 * 2. 源数组引用是静态配置刷新后的唯一失效信号之一，字段名和比较逻辑都需要显式留在读模型中。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

test('功法服务应复用读模型索引并移除请求热路径静态数组扫描', () => {
  const techniqueServiceSource = readFileSync(
    new URL('../techniqueService.ts', import.meta.url),
    'utf8',
  );
  const definitionReadModelSource = readFileSync(
    new URL('../technique/definitionReadModel.ts', import.meta.url),
    'utf8',
  );

  assert.match(
    techniqueServiceSource,
    /from '\.\/technique\/definitionReadModel\.js'/u,
  );

  assert.doesNotMatch(
    techniqueServiceSource,
    /getTechniqueDefinitions\(\)\s*\.find/u,
  );
  assert.doesNotMatch(
    techniqueServiceSource,
    /getTechniqueLayerDefinitions\(\)[\s\S]*?\.filter/u,
  );
  assert.doesNotMatch(
    techniqueServiceSource,
    /getSkillDefinitions\(\)[\s\S]*?\.filter/u,
  );

  assert.match(definitionReadModelSource, /techniqueSource !== techniqueDefinitions/u);
  assert.match(definitionReadModelSource, /skillSource !== skillDefinitions/u);
  assert.match(definitionReadModelSource, /layerSource !== layerDefinitions/u);

  assert.match(definitionReadModelSource, /visibleTechniqueById/u);
  assert.match(definitionReadModelSource, /layersByTechniqueId/u);
  assert.match(definitionReadModelSource, /skillsByTechniqueId/u);

  assert.match(definitionReadModelSource, /const freezeReadonlyArray/u);
  assert.match(definitionReadModelSource, /Object\.freeze\(rows\)/u);
  assert.match(definitionReadModelSource, /visibleTechniqueList:\s*sortedVisibleTechniqueList/u);
  assert.match(definitionReadModelSource, /layersByTechniqueId:\s*frozenLayersByTechniqueId/u);
  assert.match(definitionReadModelSource, /skillsByTechniqueId:\s*frozenSkillsByTechniqueId/u);
});
