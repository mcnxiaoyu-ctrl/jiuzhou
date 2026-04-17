/**
 * 邮件已读原子流转回归测试
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：锁定 `readMail` 必须复用单条原子更新协议，避免回退成 `FOR UPDATE` 预读邮件再标记已读。
 * 2. 做什么：锁定未读计数扣减只在本次真正命中未读 -> 已读流转时发生，避免并发重复扣减。
 * 3. 不做什么：不执行真实邮件读取，不校验 socket 推送与缓存失效细节。
 *
 * 输入/输出：
 * - 输入：mailService 源码文本。
 * - 输出：原子 CTE 结构、`marked_read` 标记与禁用旧锁查询的断言结果。
 *
 * 数据流/状态流：
 * 读取源码 -> 检查 `readMail` 的 `target_mail + marked_mail` CTE
 * -> 检查计数扣减依赖 `marked_read === true`
 * -> 断言旧的 `FOR UPDATE` 已从 `readMail` 中消失。
 *
 * 关键边界条件与坑点：
 * 1. 这里只约束“已读状态位”流转，不约束附件领取链路；附件领取仍保留独立的 `FOR UPDATE NOWAIT` 协议。
 * 2. 必须同时锁定 `marked_read` 守卫和旧锁查询消失，否则后续有人可能改成无锁更新却忘了避免重复扣减。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

test('readMail 应复用原子已读流转并移除 FOR UPDATE', () => {
  const source = readFileSync(new URL('../mailService.ts', import.meta.url), 'utf8');

  assert.match(source, /async readMail\(/u);
  assert.match(source, /WITH target_mail AS \(/u);
  assert.match(source, /marked_mail AS \(/u);
  assert.match(source, /UPDATE mail[\s\S]*AND read_at IS NULL/u);
  assert.match(source, /EXISTS\(SELECT 1 FROM marked_mail\) AS marked_read/u);
  assert.match(source, /result\.rows\[0\]\?\.marked_read === true && readState/u);

  assert.doesNotMatch(
    source,
    /async readMail[\s\S]*?FOR UPDATE/u,
  );
});
