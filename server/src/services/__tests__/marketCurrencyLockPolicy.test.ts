/**
 * 坊市货币锁策略回归测试
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：锁定坊市上架、下架、购买链路必须复用共享货币入口，而不是在背包锁内继续 `FOR UPDATE characters`。
 * 2. 做什么：锁定坊市金额仍通过 `bigint` 精确传递，避免后续重构时回退成手写 SQL 或粗暴转 `number`。
 * 3. 不做什么：不执行真实坊市交易，不校验挂单状态流转与邮件发放。
 *
 * 输入/输出：
 * - 输入：marketService 与共享货币模块源码文本。
 * - 输出：共享入口引用与禁用旧 SQL 片段的断言结果。
 *
 * 数据流/状态流：
 * 读取源码 -> 检查坊市服务是否调用 `consumeCharacterCurrenciesExact` / `addCharacterCurrenciesExact`
 * -> 断言旧的 `SELECT ... FOR UPDATE` 与手写 `UPDATE characters SET ...` 已消失。
 *
 * 关键边界条件与坑点：
 * 1. 必须同时锁定“共享入口复用”和“旧 SQL 消失”，否则局部替换后仍可能残留角色行锁热点。
 * 2. 这里只约束角色货币流，不约束物品实例行锁与成交邮件逻辑，避免把测试绑在无关实现细节上。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const readSource = (relativePath: string): string => {
  return readFileSync(new URL(relativePath, import.meta.url), 'utf8');
};

test('marketService 应复用 bigint 版共享货币入口并移除 characters FOR UPDATE', () => {
  const marketSource = readSource('../marketService.ts');
  const consumeSource = readSource('../inventory/shared/consume.ts');

  assert.match(marketSource, /consumeCharacterCurrenciesExact\(params\.characterId,\s*\{/u);
  assert.match(marketSource, /consumeCharacterCurrenciesExact\(params\.buyerCharacterId,\s*\{/u);
  assert.match(marketSource, /addCharacterCurrenciesExact\(params\.characterId,\s*\{/u);
  assert.match(marketSource, /addCharacterCurrenciesExact\(sellerCharacterId,\s*\{/u);
  assert.match(consumeSource, /export const consumeCharacterCurrenciesExact = async/u);
  assert.match(consumeSource, /export const addCharacterCurrenciesExact = async/u);

  assert.doesNotMatch(marketSource, /SELECT silver FROM characters WHERE id = \$1 FOR UPDATE/u);
  assert.doesNotMatch(marketSource, /SELECT spirit_stones FROM characters WHERE id = \$1 FOR UPDATE/u);
  assert.doesNotMatch(
    marketSource,
    /UPDATE characters SET silver = silver - \$1,\s*updated_at = NOW\(\) WHERE id = \$2/u,
  );
  assert.doesNotMatch(
    marketSource,
    /UPDATE characters SET silver = silver \+ \$1,\s*updated_at = NOW\(\) WHERE id = \$2/u,
  );
  assert.doesNotMatch(
    marketSource,
    /UPDATE characters SET spirit_stones = spirit_stones - \$1,\s*updated_at = NOW\(\) WHERE id = \$2/u,
  );
  assert.doesNotMatch(
    marketSource,
    /UPDATE characters SET spirit_stones = spirit_stones \+ \$1,\s*updated_at = NOW\(\) WHERE id = \$2/u,
  );
});
