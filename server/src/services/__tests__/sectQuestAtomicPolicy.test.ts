/**
 * 宗门任务原子领取与进度返回协议回归测试
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：锁定宗门任务领奖必须复用原子 `claim` 入口，避免回退成 `FOR UPDATE` 预读再二次更新。
 * 2. 做什么：锁定提交流程的进度推进直接通过 `UPDATE ... RETURNING` 取回最新进度，避免更新后二次查询。
 * 3. 不做什么：不执行真实宗门任务提交流程，不校验宗门资金或贡献数值。
 *
 * 输入/输出：
 * - 输入：sect/quests 源码文本。
 * - 输出：原子 claim helper、进度推进返回值与禁用旧 SQL 的断言结果。
 *
 * 数据流/状态流：
 * 读取源码 -> 检查 `claimSectQuestProgressTx` 与 `applyQuestProgressDeltaTx` 的 SQL 结构
 * -> 检查 `claimSectQuest` / `submitSectQuest` 复用这两个 helper
 * -> 断言旧的领奖 `FOR UPDATE` 查询与提交后二次查询已移除。
 *
 * 关键边界条件与坑点：
 * 1. 提交流程这里只约束“更新后直接取回结果”，不约束物品扣减链路，因为扣物品仍依赖背包事务协议。
 * 2. 必须同时锁定 helper 复用和旧 SQL 消失，否则后续有人可能保留 helper 但重新加回二次查询。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

test('sectQuestService 应复用原子领奖与 UPDATE RETURNING 进度推进', () => {
  const source = readFileSync(new URL('../sect/quests.ts', import.meta.url), 'utf8');

  assert.match(source, /const claimSectQuestProgressTx = async/u);
  assert.match(source, /WITH current_progress AS \(/u);
  assert.match(source, /UPDATE sect_quest_progress[\s\S]*status = 'claimed'/u);
  assert.match(source, /const claimTransition = await claimSectQuestProgressTx\(characterId,\s*questId,\s*quest\.required\)/u);
  assert.doesNotMatch(source, /UPDATE sect_quest_progress[\s\S]*updated_at = NOW\(\)/u);

  assert.match(source, /const applyQuestProgressDeltaTx = async/u);
  assert.match(source, /UPDATE sect_quest_progress[\s\S]*RETURNING progress, status/u);
  assert.match(source, /const updatedSnapshot = await applyQuestProgressDeltaTx\(characterId,\s*questId,\s*consumeRes\.consumed\)/u);

  assert.doesNotMatch(
    source,
    /SELECT status FROM sect_quest_progress WHERE character_id = \$1 AND quest_id = \$2 FOR UPDATE/u,
  );
  assert.doesNotMatch(
    source,
    /SELECT progress, status FROM sect_quest_progress WHERE character_id = \$1 AND quest_id = \$2`/u,
  );
});
