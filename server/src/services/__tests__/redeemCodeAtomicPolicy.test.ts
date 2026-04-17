/**
 * 兑换码原子创建与兑换协议回归测试
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：锁定来源幂等创建必须走单条 `INSERT ... ON CONFLICT DO NOTHING` 原子入口，避免回退成 `FOR UPDATE` 预读来源行。
 * 2. 做什么：锁定兑换必须通过单条原子 `UPDATE ... RETURNING` 抢占资格，再发送奖励邮件，避免并发重复发送。
 * 3. 不做什么：不执行真实兑换、不连接数据库，也不校验邮件内容。
 *
 * 输入/输出：
 * - 输入：redeemCodeService 源码文本。
 * - 输出：原子创建/兑换 SQL 结构与禁用旧锁查询的断言结果。
 *
 * 数据流/状态流：
 * 读取源码 -> 检查 getOrCreate 的插入 SQL 与 redeem 的原子更新 SQL
 * -> 断言仍复用奖励邮件发送入口
 * -> 确认旧的 `FOR UPDATE` 预读和二次 UPDATE 已消失。
 *
 * 关键边界条件与坑点：
 * 1. 创建链路必须同时覆盖“来源已存在”和“随机 code 冲突”两类并发路径，因此要锁定 `ON CONFLICT DO NOTHING + UNION ALL` 结构。
 * 2. 兑换链路只约束并发协议，不约束路由层限频与推送逻辑，避免把测试绑到无关实现细节。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

test('redeemCodeService 应复用原子创建与兑换资格抢占 SQL', () => {
  const source = readFileSync(new URL('../redeemCodeService.ts', import.meta.url), 'utf8');

  assert.match(source, /const getOrCreateRedeemCodeRow = async/u);
  assert.match(source, /WITH attempted_insert AS \(/u);
  assert.match(source, /INSERT INTO redeem_code \(code, source_type, source_ref_id, reward_payload\)/u);
  assert.match(source, /ON CONFLICT DO NOTHING/u);
  assert.match(source, /SELECT id, code, FALSE AS created[\s\S]*FROM redeem_code/u);
  assert.match(source, /return getOrCreateRedeemCodeRow\(input\)/u);

  assert.match(source, /WITH existing_code AS \(/u);
  assert.match(source, /UPDATE redeem_code[\s\S]*SET status = 'redeemed'/u);
  assert.match(source, /RETURNING code, reward_payload/u);
  assert.match(source, /EXISTS\(SELECT 1 FROM redeemed_code\) AS redeemed/u);
  assert.match(source, /const mailResult = await mailService\.sendMail\(/u);

  assert.doesNotMatch(
    source,
    /WHERE source_type = \$1 AND source_ref_id = \$2[\s\S]*FOR UPDATE/u,
  );
  assert.doesNotMatch(
    source,
    /WHERE code = \$1[\s\S]*FOR UPDATE/u,
  );
  assert.doesNotMatch(
    source,
    /UPDATE redeem_code[\s\S]*WHERE id = \$1/u,
  );
});
