/**
 * 邮件领取库存 preflight 事务边界回归测试
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：锁定单封邮件领取必须在事务外完成库存实体态 preflight，避免把 grant flush、实例 mutation flush、背包锁和 outbox 批处理拖进邮件事务。
 * 2. 做什么：锁定真正持有 mail 行锁的 `claimAttachmentsTx` 不再直接调用 `prepareInventoryInteractionForMailClaim`，防止回退成“邮件锁 + 背包锁 + outbox 查询”同事务串行。
 * 3. 不做什么：不连接真实数据库、不执行真实邮件领取，也不覆盖前端交互。
 *
 * 输入 / 输出：
 * - 输入：`mailService.ts` 源码文本。
 * - 输出：围绕单封邮件领取编排顺序的静态断言结果。
 *
 * 数据流 / 状态流：
 * 读取源码 -> 断言 `claimAttachments` 先做事务外 preflight 再委托 `claimAttachmentsTx`
 * -> 断言 `claimAttachmentsTx` 内不再出现库存 preflight 调用。
 *
 * 复用设计说明：
 * - 这里锁定的是事务边界而不是实现细节，后续即使重构邮件领取细节，只要继续保持“preflight 在事务外”就能复用这条回归约束。
 * - 单封领取和一键领取都依赖同一库存 preflight 语义，这条测试能防止未来只修一条链而另一条回流。
 *
 * 关键边界条件与坑点：
 * 1. 静态测试无法证明运行期一定无锁等待，只能确保最危险的调用顺序不会在源码层回流。
 * 2. 正则需要尽量约束在函数片段内，避免命中类里其他辅助方法的同名调用。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync(new URL('../mailService.ts', import.meta.url), 'utf8');

test('claimAttachments 应在事务外完成库存 preflight', () => {
  assert.match(
    source,
    /async claimAttachments\([\s\S]*?shouldPrepareInventoryInteractionForMailClaim\(userId,\s*characterId,\s*mailId\)[\s\S]*?await this\.prepareInventoryInteractionForMailClaim\(characterId\);[\s\S]*?return this\.claimAttachmentsTx\(/u,
  );
});

test('claimAttachmentsTx 不应在邮件事务内再次执行库存 preflight', () => {
  assert.match(
    source,
    /@Transactional[\s\S]*?private async claimAttachmentsTx\(/u,
  );
  assert.doesNotMatch(
    source,
    /private async claimAttachmentsTx\([\s\S]*?prepareInventoryInteractionForMailClaim\(characterId\)/u,
  );
});
