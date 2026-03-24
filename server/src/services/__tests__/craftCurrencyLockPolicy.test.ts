/**
 * 炼制角色资源扣减策略回归测试
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：锁定炼制链路必须复用公共资源扣减入口，而不是在背包锁内继续 `FOR UPDATE characters`。
 * 2. 做什么：防止实现回退成“先锁角色行，再无条件 UPDATE 扣钱扣经验”的长锁模式。
 * 3. 不做什么：不执行真实炼制流程，不校验成功率或产物生成。
 *
 * 输入/输出：
 * - 输入：炼制服务源码文本。
 * - 输出：共享入口引用与禁用旧实现片段的断言结果。
 *
 * 数据流/状态流：
 * 读取源码 -> 检查 `consumeCharacterStoredResources` 调用
 * -> 断言 `getCharacterByUserId(user, true)` 与旧的无条件角色扣减 SQL 已消失。
 *
 * 关键边界条件与坑点：
 * 1. 必须同时断言“新入口存在”和“旧实现消失”，否则局部重构后仍可能保留隐性锁热点。
 * 2. 这里只锁定角色资源扣减协议，不约束材料扣减与产物发放逻辑，避免测试把无关细节绑死。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const readSource = (relativePath: string): string => {
  return readFileSync(new URL(relativePath, import.meta.url), 'utf8');
};

test('炼制链路应复用公共资源扣减入口并移除角色行锁预读', () => {
  const source = readSource('../craftService.ts');

  assert.match(source, /consumeCharacterStoredResources\(characterSnapshot\.id,\s*\{/u);
  assert.doesNotMatch(source, /getCharacterByUserId\(user,\s*true\)/u);
  assert.doesNotMatch(source, /UPDATE characters[\s\S]*silver = silver - \$2[\s\S]*exp = exp - \$4/u);
});
