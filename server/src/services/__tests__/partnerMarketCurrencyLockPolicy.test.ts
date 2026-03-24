/**
 * 伙伴坊市货币锁策略回归测试
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：锁定伙伴坊市上架、下架、购买链路必须复用共享 `bigint` 货币入口，而不是继续手写 `UPDATE characters`。
 * 2. 做什么：锁定购买链路的角色行锁必须延后到真正转账前，并统一复用按角色 ID 升序的共享行锁入口。
 * 3. 不做什么：不执行真实伙伴交易，不校验伙伴快照、成交记录或缓存刷新。
 *
 * 输入/输出：
 * - 输入：伙伴坊市服务源码文本。
 * - 输出：共享入口引用与禁用旧实现片段的断言结果。
 *
 * 数据流/状态流：
 * 读取源码 -> 检查 `consumeCharacterCurrenciesExact` / `addCharacterCurrenciesExact`
 * -> 检查 `lockCharacterRowsInOrder`
 * -> 断言旧的 `loadCharacterWallet(..., true)` 与手写角色货币 SQL 已消失。
 *
 * 关键边界条件与坑点：
 * 1. 必须同时校验“共享入口存在”和“旧实现消失”，否则局部替换后仍可能残留长事务热点。
 * 2. 这里只锁定角色货币与角色行锁协议，不约束伙伴实例 `FOR UPDATE` 与挂单状态流转，避免测试绑死无关细节。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const readSource = (relativePath: string): string => {
  return readFileSync(new URL(relativePath, import.meta.url), 'utf8');
};

test('partnerMarketService 应复用共享货币与角色行锁入口', () => {
  const source = readSource('../partnerMarketService.ts');

  assert.match(source, /consumeCharacterCurrenciesExact\(params\.characterId,\s*\{/u);
  assert.match(source, /addCharacterCurrenciesExact\(params\.characterId,\s*\{/u);
  assert.match(source, /consumeCharacterCurrenciesExact\(params\.buyerCharacterId,\s*\{/u);
  assert.match(source, /addCharacterCurrenciesExact\(sellerCharacterId,\s*\{/u);
  assert.match(source, /await lockCharacterRowsInOrder\(\[params\.buyerCharacterId,\s*sellerCharacterId\]\)/u);

  assert.doesNotMatch(source, /loadCharacterWallet\(params\.characterId,\s*true\)/u);
  assert.doesNotMatch(source, /loadCharacterWallet\(buyerLockId,\s*true\)/u);
  assert.doesNotMatch(source, /loadCharacterWallet\(sellerLockId,\s*true\)/u);
  assert.doesNotMatch(
    source,
    /UPDATE characters[\s\S]*silver = silver - \$1[\s\S]*WHERE id = \$2/u,
  );
  assert.doesNotMatch(
    source,
    /UPDATE characters[\s\S]*silver = silver \+ \$1[\s\S]*WHERE id = \$2/u,
  );
  assert.doesNotMatch(
    source,
    /UPDATE characters[\s\S]*spirit_stones = spirit_stones - \$1[\s\S]*WHERE id = \$2/u,
  );
  assert.doesNotMatch(
    source,
    /UPDATE characters[\s\S]*spirit_stones = spirit_stones \+ \$1[\s\S]*WHERE id = \$2/u,
  );
});
