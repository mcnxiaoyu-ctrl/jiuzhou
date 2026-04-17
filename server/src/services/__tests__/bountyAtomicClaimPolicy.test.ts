/**
 * 悬赏接取原子任务占位协议回归测试
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：锁定悬赏接取必须复用原子 `character_task_progress` upsert 入口，避免回退成 `FOR UPDATE` 预读任务状态。
 * 2. 做什么：锁定同一事务里若 `bounty_claim` 插入失败会抛业务异常回滚，避免留下已重置任务进度但未真正接取悬赏的脏状态。
 * 3. 不做什么：不执行真实悬赏接取，不校验悬赏容量、奖励数值或路由层文案。
 *
 * 输入/输出：
 * - 输入：bountyService 源码文本。
 * - 输出：原子 upsert 入口、回滚式异常处理与禁用旧任务行锁查询的断言结果。
 *
 * 数据流/状态流：
 * 读取源码 -> 检查 `acceptBountyTaskProgressTx` 的 `INSERT ... ON CONFLICT ... WHERE status = 'claimed'`
 * -> 检查 `claimBounty` 复用该入口并在 `bounty_claim` 冲突时抛 `BusinessError`
 * -> 断言旧的 `character_task_progress FOR UPDATE` 查询已移除。
 *
 * 关键边界条件与坑点：
 * 1. 这里只约束任务进度占位协议，不约束 `bounty_instance FOR UPDATE`；实例容量仲裁仍需要共享行锁。
 * 2. 必须同时锁定“共享入口复用”和“冲突回滚”，否则只改一半仍会留下脏状态提交风险。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

test('bountyService 应复用原子任务 upsert 并移除任务进度 FOR UPDATE 预读', () => {
  const source = readFileSync(new URL('../bountyService.ts', import.meta.url), 'utf8');

  assert.match(source, /const acceptBountyTaskProgressTx = async/u);
  assert.match(source, /INSERT INTO character_task_progress \(/u);
  assert.match(source, /ON CONFLICT \(character_id, task_id\) DO UPDATE SET/u);
  assert.match(source, /WHERE character_task_progress\.status = 'claimed'/u);
  assert.match(source, /const taskAccepted = await acceptBountyTaskProgressTx\(cid,\s*taskId,\s*initialStatus\)/u);
  assert.match(source, /throw new BusinessError\('已接取该悬赏'\)/u);

  assert.doesNotMatch(
    source,
    /SELECT status FROM character_task_progress WHERE character_id = \$1 AND task_id = \$2 LIMIT 1 FOR UPDATE/u,
  );
});
