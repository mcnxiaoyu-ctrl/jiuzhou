/**
 * 战令任务完成原子流转回归测试
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：锁定 `completeBattlePassTask` 必须复用原子完成 helper，避免回退成 `FOR UPDATE` 预读任务进度。
 * 2. 做什么：锁定任务完成判定在 SQL 中直接表达“当前周期已完成 / 当前周期进度达标”的 guard 条件，避免再次拆成读后判断再写。
 * 3. 不做什么：不执行真实战令任务完成，不校验经验奖励数值。
 *
 * 输入/输出：
 * - 输入：battlePassService 源码文本。
 * - 输出：原子 helper、周期起点 helper 与禁用旧锁查询的断言结果。
 *
 * 数据流/状态流：
 * 读取源码 -> 检查 `completeBattlePassTaskProgressTx` 的 CTE + 条件 UPDATE
 * -> 检查 `completeBattlePassTask` 复用 `getBattlePassTaskCycleStart`
 * -> 断言旧的 `FOR UPDATE` 任务进度查询与末尾 upsert 已消失。
 *
 * 关键边界条件与坑点：
 * 1. 这里只约束任务完成状态流转，不约束后续 `battle_pass_progress` 加经验逻辑，因为那部分仍需要事务内串行提交。
 * 2. 必须同时锁定“helper 已接入”和“旧 SQL 消失”，否则后续有人可能新增 helper 却继续保留原来的锁查询。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

test('completeBattlePassTask 应复用原子完成 helper 并移除任务进度 FOR UPDATE', () => {
  const source = readFileSync(new URL('../battlePassService.ts', import.meta.url), 'utf8');

  assert.match(source, /const getBattlePassTaskCycleStart = \(taskType: BattlePassTaskType, now: Date\)/u);
  assert.match(source, /const completeBattlePassTaskProgressTx = async/u);
  assert.match(source, /WITH current_progress AS \(/u);
  assert.match(source, /UPDATE battle_pass_task_progress[\s\S]*completed = true/u);
  assert.match(source, /const cycleStart = getBattlePassTaskCycleStart\(taskType,\s*now\)/u);
  assert.match(source, /const completeTransition = await completeBattlePassTaskProgressTx\(/u);

  assert.doesNotMatch(
    source,
    /SELECT progress_value, completed, completed_at, updated_at[\s\S]*FOR UPDATE/u,
  );
  assert.doesNotMatch(
    source,
    /INSERT INTO battle_pass_task_progress \([\s\S]*ON CONFLICT \(character_id, season_id, task_id\)/u,
  );
});
