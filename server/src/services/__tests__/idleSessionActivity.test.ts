/**
 * IdleSessionActivity — stopping 孤儿会话判定测试
 *
 * 作用：
 *   验证 stopping 会话的孤儿识别规则，确保没有执行循环承接时不会继续被视为活跃。
 *   只依赖纯函数，不引入数据库、Redis 或执行器副作用。
 *
 * 输入/输出：
 *   - 输入：最小会话快照数组 + hasExecutionLoop 探针
 *   - 输出：应被收敛的 stopping sessionId 列表
 *
 * 数据流：
 *   构造会话快照 → 调用 resolveOrphanStoppingSessionIds → 断言孤儿结果
 *
 * 关键边界条件与坑点：
 *   1. active 会话不应被当成 stopping 孤儿，哪怕当前没有执行循环承接。
 *   2. 已被执行循环承接的 stopping 会话仍处于正常收尾中，不应被过早收敛。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveOrphanStoppingSessionIds,
  type IdleSessionActivitySnapshot,
} from '../idle/idleSessionActivity.js';

test('stopping 会话无执行循环承接时应识别为孤儿', () => {
  const sessions: IdleSessionActivitySnapshot[] = [
    { id: 'session-stopping-orphan', characterId: 1, status: 'stopping' },
    { id: 'session-stopping-live', characterId: 1, status: 'stopping' },
    { id: 'session-active', characterId: 1, status: 'active' },
  ];

  const orphanIds = resolveOrphanStoppingSessionIds(
    sessions,
    (sessionId) => sessionId === 'session-stopping-live',
  );

  assert.deepEqual(
    orphanIds,
    ['session-stopping-orphan'],
    '只有没有执行循环承接的 stopping 会话应被识别为孤儿',
  );
});

test('active 会话即使没有执行循环也不能被误判为 stopping 孤儿', () => {
  const sessions: IdleSessionActivitySnapshot[] = [
    { id: 'session-active', characterId: 99, status: 'active' },
  ];

  const orphanIds = resolveOrphanStoppingSessionIds(sessions, () => false);

  assert.deepEqual(orphanIds, [], '只有 stopping 状态才参与 stopping 孤儿收敛');
});
