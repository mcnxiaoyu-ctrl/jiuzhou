/**
 * 悬赏材料提交原子完成流转回归测试
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：锁定悬赏材料提交在扣完物品后必须复用共享 helper，一次性完成任务转 `claimable` 与 `bounty_claim` 转 `completed`。
 * 2. 做什么：锁定 `character_task_progress` 不再使用 `FOR UPDATE` 预读，避免回退成“锁任务行 -> 扣物品 -> 双 UPDATE”的两段式链路。
 * 3. 不做什么：不执行真实物品扣除，不校验掉落预览或库存排序。
 *
 * 输入/输出：
 * - 输入：bountyService 源码文本。
 * - 输出：共享 helper、CTE 流转 SQL 与禁用旧锁查询/旧双写的断言结果。
 *
 * 数据流/状态流：
 * 读取源码 -> 检查 `completeBountySubmitProgressTx` 的双更新 CTE
 * -> 检查 `_submitBountyMaterialsInner` 复用该 helper
 * -> 断言旧的 `character_task_progress FOR UPDATE` 与尾部双 UPDATE 已消失。
 *
 * 关键边界条件与坑点：
 * 1. 这里只约束提交完成后的状态流转，不约束前面的 `bounty_claim FOR UPDATE`，因为领取记录仍负责串行化同一悬赏提交。
 * 2. 必须同时约束 helper 复用和旧双写消失，否则后续重构可能一边保留 helper，一边又补回旧 SQL。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

test('bounty submit 应复用原子完成流转 helper 并移除任务进度 FOR UPDATE', () => {
  const source = readFileSync(new URL('../bountyService.ts', import.meta.url), 'utf8');

  assert.match(source, /const completeBountySubmitProgressTx = async/u);
  assert.match(source, /WITH current_task AS \(/u);
  assert.match(source, /UPDATE character_task_progress[\s\S]*status = 'claimable'/u);
  assert.match(source, /UPDATE bounty_claim[\s\S]*status = 'completed'/u);
  assert.match(source, /const submitTransition = await completeBountySubmitProgressTx\(cid,\s*tid,\s*nextProgress,\s*claimId\)/u);

  assert.doesNotMatch(
    source,
    /SELECT progress, status FROM character_task_progress WHERE character_id = \$1 AND task_id = \$2 FOR UPDATE/u,
  );
  assert.doesNotMatch(
    source,
    /UPDATE bounty_claim SET status = 'completed', updated_at = NOW\(\) WHERE id = \$1/u,
  );
});
