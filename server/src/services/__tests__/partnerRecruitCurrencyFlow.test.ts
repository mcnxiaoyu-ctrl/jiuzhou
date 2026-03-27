/**
 * 伙伴招募扣费链路回归测试
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：锁定伙伴招募创建任务时必须复用共享货币扣减入口，且失败退款统一走邮件发放，避免再次手写 `UPDATE characters` 扣/退灵石。
 * 2. 做什么：验证该链路不再依赖 `loadCharacterSpiritStones(..., true)` 这类角色行锁读取。
 * 3. 不做什么：不连接数据库，不覆盖伙伴招募完整业务状态机。
 *
 * 输入/输出：
 * - 输入：伙伴招募服务源码文本。
 * - 输出：源码中关键调用与禁用 SQL 片段的断言结果。
 *
 * 数据流/状态流：
 * 读取源码 -> 检查 createRecruitJobTx 内的扣费写法 -> 防止后续重构回退到手写扣费。
 *
 * 关键边界条件与坑点：
 * 1. 这里锁的是“实现约束”而不是返回值，因为线上痛点来自锁顺序与事务长度，而不是接口响应字段。
 * 2. 断言必须同时检查“已复用共享模块”和“旧 SQL 已消失”，否则只命中其一仍可能回退。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

test('partnerRecruitService: 创建走共享扣费入口，退款统一走邮件发放，保底计数改为原子更新', () => {
  const source = readFileSync(
    new URL('../partnerRecruitService.ts', import.meta.url),
    'utf8',
  );

  assert.match(source, /consumeCharacterCurrencies\(characterId,\s*\{/u);
  assert.match(source, /mailService\.sendMail\(\{/u);
  assert.match(source, /attachSpiritStones:\s*spiritStonesCost/u);
  assert.match(source, /source:\s*'partner_recruit_refund'/u);
  assert.match(source, /SPIRIT_STONES_STATE_CHANGED/u);
  assert.match(
    source,
    /partner_recruit_generated_non_heaven_count = CASE[\s\S]*WHEN \$2 = '天' THEN 0[\s\S]*ELSE partner_recruit_generated_non_heaven_count \+ 1/iu,
  );
  assert.doesNotMatch(
    source,
    /UPDATE characters\s+SET spirit_stones = spirit_stones - \$2,\s+updated_at = NOW\(\)\s+WHERE id = \$1/us,
  );
  assert.doesNotMatch(
    source,
    /UPDATE characters\s+SET spirit_stones = spirit_stones \+ \$2,\s+updated_at = NOW\(\)\s+WHERE id = \$1/us,
  );
  assert.doesNotMatch(source, /loadCharacterSpiritStones\(characterId,\s*true\)/u);
  assert.doesNotMatch(source, /loadCharacterUserId\(characterId,\s*true\)/u);
});
