/**
 * 普通任务提交原子流转回归测试
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：锁定 `submitTask` 必须复用原子 `markTaskClaimableTx`，避免回退成读快照后直接无条件 `UPDATE`。
 * 2. 做什么：锁定“转可领取”逻辑通过单条条件更新完成，并保留并发下已 claimable / 已 claimed 的稳定返回语义。
 * 3. 不做什么：不执行真实任务提交，不校验目标匹配或进度计算结果。
 *
 * 输入/输出：
 * - 输入：taskService 源码文本。
 * - 输出：原子 helper、入口复用与禁用旧 SQL 的断言结果。
 *
 * 数据流/状态流：
 * 读取源码 -> 检查 `markTaskClaimableTx` 的 CTE + 条件更新
 * -> 检查 `submitTask` 复用该 helper
 * -> 断言旧的手写 `UPDATE character_task_progress SET status = 'claimable'` 已消失。
 *
 * 关键边界条件与坑点：
 * 1. 这里只约束最终状态流转，不约束前面的目标完成判定；完成判定仍依赖前置快照计算。
 * 2. 必须同时锁定 helper 复用和旧 SQL 消失，否则有人可能新增 helper 却继续保留旧更新语句。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

test('submitTask 应复用原子 claimable 流转 helper', () => {
  const source = readFileSync(new URL('../taskService.ts', import.meta.url), 'utf8');

  assert.match(source, /const markTaskClaimableTx = async/u);
  assert.match(source, /WITH current_progress AS \(/u);
  assert.match(source, /UPDATE character_task_progress[\s\S]*status = 'claimable'/u);
  assert.match(source, /AND status NOT IN \('claimable', 'claimed'\)/u);
  assert.match(source, /const submitTransition = await markTaskClaimableTx\(cid,\s*tid\)/u);

  assert.doesNotMatch(
    source,
    /UPDATE character_task_progress\s+SET status = 'claimable',[\s\S]*WHERE character_id = \$1 AND task_id = \$2/u,
  );
});
