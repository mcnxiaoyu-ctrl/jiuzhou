/**
 * 任务奖励原子领取协议回归测试
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：锁定任务奖励领取必须复用单条原子 `UPDATE ... RETURNING` claim 入口，而不是先 `FOR UPDATE` 读进度再改状态。
 * 2. 做什么：锁定悬赏奖励领取必须在同一事务里通过原子更新完成状态流转，避免“先锁 bounty_claim 再二次 UPDATE”的两段式热点回归。
 * 3. 不做什么：不执行真实任务奖励发放，不校验奖励数值和掉落内容。
 *
 * 输入/输出：
 * - 输入：taskService 源码文本。
 * - 输出：原子 claim 入口、共享断言入口与禁用旧锁查询的断言结果。
 *
 * 数据流/状态流：
 * 读取源码 -> 检查 `claimTaskRewardProgressTx` 与 `applyBountyRewardOnTaskClaim` 的 SQL 结构
 * -> 检查奖励发放失败会通过 `assertServiceSuccess` 回滚
 * -> 断言旧的 `FOR UPDATE` 预读与手写二次 UPDATE 已消失。
 *
 * 关键边界条件与坑点：
 * 1. 必须同时锁定“先 claim 再发奖励”和“失败抛错回滚”，否则有人可能只改 SQL，却把事务失败分支重新写成提交脏状态。
 * 2. 悬赏奖励这里约束的是状态流转协议，而不是奖励内容；测试不能绑死在具体字段或文案上。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

test('taskService 应复用原子任务 claim 与悬赏奖励状态更新', () => {
  const source = readFileSync(new URL('../taskService.ts', import.meta.url), 'utf8');

  assert.match(source, /const claimTransition = await claimTaskRewardProgressTx\(cid,\s*tid\)/u);
  assert.match(source, /WITH current_progress AS \(/u);
  assert.match(source, /UPDATE character_task_progress[\s\S]*status = 'claimed'/u);
  assert.match(source, /RETURNING task_id/u);
  assert.match(source, /assertServiceSuccess\(applyResult\)/u);

  assert.match(source, /WITH target_claim AS \(/u);
  assert.match(source, /UPDATE bounty_claim AS c[\s\S]*SET status = 'rewarded'/u);
  assert.match(source, /JOIN rewarded_claim r ON r\.claim_id = t\.claim_id/u);

  assert.doesNotMatch(
    source,
    /SELECT status FROM character_task_progress WHERE character_id = \$1 AND task_id = \$2 FOR UPDATE/u,
  );
  assert.doesNotMatch(
    source,
    /SELECT[\s\S]*FROM bounty_claim c[\s\S]*FOR UPDATE/u,
  );
  assert.doesNotMatch(
    source,
    /UPDATE bounty_claim SET status = 'rewarded', updated_at = NOW\(\) WHERE id = \$1/u,
  );
});
