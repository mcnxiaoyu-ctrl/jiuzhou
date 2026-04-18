/**
 * 月卡领取失败回滚协议回归测试
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：锁定月卡领取已改成 `withTransaction` 回滚式事务，而不是 `@Transactional + success:false` 的提交式失败路径。
 * 2. 做什么：锁定加钱失败会抛 `BusinessError`，确保占位与领取记录不会在失败时落库提交。
 * 3. 不做什么：不执行真实加钱流程，不校验剩余灵石展示。
 *
 * 输入/输出：
 * - 输入：monthCardService 源码文本。
 * - 输出：事务包装与异常回滚入口的断言结果。
 *
 * 数据流/状态流：
 * 读取源码 -> 检查 `claimMonthCardReward` 走 `withTransaction`
 * -> 检查 `addCharacterCurrenciesExact` 失败会 `throw new BusinessError`
 * -> 断言方法上不再存在 `@Transactional`。
 *
 * 关键边界条件与坑点：
 * 1. 这里只约束领取失败回滚，不约束激活入口；`useMonthCardItem` 仍可以继续走装饰器事务。
 * 2. 必须同时锁定“withTransaction”与“失败抛错”，否则后续可能又退回成提交式失败。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

test('claimMonthCardReward 应使用回滚式事务并在加钱失败时抛业务异常', () => {
  const source = readFileSync(new URL('../monthCardService.ts', import.meta.url), 'utf8');

  assert.match(source, /return await withTransaction\(async \(\) => \{/u);
  assert.match(source, /if \(!addResult\.success\) \{\s*throw new BusinessError\(addResult\.message\);/u);
  assert.doesNotMatch(
    source,
    /@Transactional[\s\S]*async claimMonthCardReward/u,
  );
});
