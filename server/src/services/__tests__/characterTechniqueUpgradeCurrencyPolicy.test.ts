/**
 * 功法升级角色资源扣减策略回归测试
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：锁定功法升级必须使用条件 UPDATE 扣减角色经验/灵石，避免再次回退成先 `FOR UPDATE characters` 再扣减。
 * 2. 做什么：保证角色资源扣减和余额校验收敛在单条 SQL 里，缩短角色行锁持有时间。
 * 3. 不做什么：不连接真实数据库，不覆盖材料扣除或成就推进流程。
 *
 * 输入/输出：
 * - 输入：功法服务源码文本。
 * - 输出：条件更新 SQL 与禁用旧锁查询的断言结果。
 *
 * 数据流/状态流：
 * 读取源码 -> 检查条件 UPDATE 片段 -> 断言旧的 `SELECT ... FOR UPDATE` 资源预读已消失。
 *
 * 关键边界条件与坑点：
 * 1. 必须同时断言“新 SQL 存在”和“旧 SQL 消失”，否则后续重构可能只是新增一条辅助 SQL，却把旧热点保留下来。
 * 2. 这里只锁定角色资源扣减协议，不约束材料锁或功法层数锁，避免测试把无关实现细节绑死。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const readSource = (relativePath: string): string => {
  return readFileSync(new URL(relativePath, import.meta.url), 'utf8');
};

test('功法升级应使用条件 UPDATE 扣减角色经验与灵石', () => {
  const source = readSource('../characterTechniqueService.ts');

  assert.match(source, /UPDATE characters\s+SET spirit_stones = spirit_stones - \$1,\s*exp = exp - \$2/u);
  assert.match(source, /AND spirit_stones >= \$1/u);
  assert.match(source, /AND exp >= \$2/u);
  assert.doesNotMatch(source, /SELECT spirit_stones, exp FROM characters WHERE id = \$1 FOR UPDATE/u);
});
