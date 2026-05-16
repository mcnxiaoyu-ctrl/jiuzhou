/**
 * 邮件已读窄查询策略测试
 *
 * 作用：锁定 readMail 不再读取附件 JSON 宽字段。
 * 输入/输出：输入为 mailService.ts 源码文本，输出为策略断言。
 * 数据流：readMail -> target_mail 窄字段 -> marked_mail 原子更新 -> unread counter delta。
 * 复用设计说明：已读只影响 unread counter，不复用领取附件的宽行状态读取。
 * 关键边界条件与坑点：
 * 1. readMail 不需要 attach_items / attach_rewards / attach_instance_ids，否则会放大单封已读延迟。
 * 2. 已读成功但原本已读的邮件不能重复扣减 unread counter。
 */
import { readFileSync } from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';

const source = readFileSync(new URL('../mailService.ts', import.meta.url), 'utf8');
const readMailMatch = source.match(/async readMail\([\s\S]*?return \{ success: true, message: '已读' \};/u);
assert.ok(readMailMatch);
const readMailSource = readMailMatch[0];

test('readMail 的 target_mail 不应读取附件宽字段', () => {
  assert.doesNotMatch(readMailSource, /attach_items/u);
  assert.doesNotMatch(readMailSource, /attach_rewards/u);
  assert.doesNotMatch(readMailSource, /attach_instance_ids/u);
  assert.match(readMailSource, /marked_read/u);
});
