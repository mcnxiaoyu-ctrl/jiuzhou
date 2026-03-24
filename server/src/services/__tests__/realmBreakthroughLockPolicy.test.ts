/**
 * 境界突破锁时机回归测试
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：锁定突破链路必须先做无锁预检，再进入 `characters FOR UPDATE` 的最终提交阶段。
 * 2. 做什么：防止实现回退成“一进事务就锁角色行，再跑整套条件计算”的长锁模式。
 * 3. 不做什么：不连接真实数据库，不验证突破数值本身。
 *
 * 输入/输出：
 * - 输入：境界服务源码文本。
 * - 输出：无锁预检与延后加锁顺序的断言结果。
 *
 * 数据流/状态流：
 * 读取源码 -> 检查突破方法先调用无锁角色快照 -> 先执行 requirements 预检
 * -> 再进入 `FOR UPDATE` 角色锁阶段。
 *
 * 关键边界条件与坑点：
 * 1. 必须同时断言“无锁预检存在”和“加锁发生在预检之后”，否则局部抽 helper 但锁顺序未变，热点依旧存在。
 * 2. 这里只锁定锁时机，不约束具体提示文案，避免把业务文案改动误判为锁协议回退。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const readSource = (relativePath: string): string => {
  return readFileSync(new URL(relativePath, import.meta.url), 'utf8');
};

test('突破链路应先做无锁预检，再获取角色行锁', () => {
  const source = readSource('../realmService.ts');

  assert.match(source, /loadBreakthroughCharacterRow\(userId,\s*false\)/u);
  assert.match(source, /loadBreakthroughCharacterRow\(userId,\s*true\)/u);
  assert.match(
    source,
    /async breakthroughToNextRealm[\s\S]*?loadBreakthroughCharacterRow\(userId,\s*false\)[\s\S]*?evaluateRequirements\(/u,
  );
  assert.match(
    source,
    /async breakthroughToNextRealm[\s\S]*?evaluateRequirements\([\s\S]*?loadBreakthroughCharacterRow\(userId,\s*true\)/u,
  );
});
