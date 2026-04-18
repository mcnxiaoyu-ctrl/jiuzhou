/**
 * 普通任务接取原子占位协议回归测试
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：锁定 `acceptTaskFromNpc` 必须复用原子 `acceptTaskProgressTx`，避免回退成先查进度状态、再插入/更新的两段式写法。
 * 2. 做什么：锁定首次接取只走单条条件插入，不再通过 `ON CONFLICT DO UPDATE` 重写已有进度行。
 * 3. 不做什么：不执行真实 NPC 接任务流程，不校验前置任务、境界解锁或 recurring reset。
 *
 * 输入/输出：
 * - 输入：taskService 源码文本。
 * - 输出：原子 helper、入口复用与禁用旧 SQL 的断言结果。
 *
 * 数据流/状态流：
 * 读取源码 -> 检查 `acceptTaskProgressTx` 的 `current_progress + accepted_progress` 结构
 * -> 检查 `acceptTaskFromNpc` 复用该 helper
 * -> 断言旧的状态预读与 upsert 重写已移除。
 *
 * 复用设计说明：
 * 1. “任务是否已接取”是任务入口的高频变化点，抽成 helper 后，后续如果还有批量接取或直连接取入口，可以复用同一协议。
 * 2. 把判定与占位合并成单条 SQL，避免业务方法里重复维护“已接取/已完成”并发分支。
 *
 * 关键边界条件与坑点：
 * 1. helper 这里只负责首次接取占位，不负责 recurring reset；日常/周常重置仍必须在入口前完成。
 * 2. 必须同时锁定 helper 复用和旧 SQL 消失，否则后续有人可能保留 helper 又把预读查询加回来。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

test('acceptTaskFromNpc 应复用原子接取 helper 并移除状态预读 upsert', () => {
  const source = readFileSync(new URL('../taskService.ts', import.meta.url), 'utf8');

  assert.match(source, /const acceptTaskProgressTx = async/u);
  assert.match(source, /WITH current_progress AS \(/u);
  assert.match(source, /accepted_progress AS \([\s\S]*INSERT INTO character_task_progress/u);
  assert.match(source, /WHERE NOT EXISTS \(SELECT 1 FROM current_progress\)/u);
  assert.match(source, /const acceptTransition = await acceptTaskProgressTx\(cid,\s*tid\)/u);

  assert.doesNotMatch(
    source,
    /SELECT status FROM character_task_progress WHERE character_id = \$1 AND task_id = \$2 LIMIT 1/u,
  );
  assert.doesNotMatch(
    source,
    /INSERT INTO character_task_progress[\s\S]*ON CONFLICT \(character_id, task_id\) DO UPDATE SET/u,
  );
});
