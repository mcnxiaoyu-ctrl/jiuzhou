/**
 * 宗门货币锁策略回归测试
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：锁定宗门创建与宗门捐献必须复用共享货币扣减入口，避免再次回退成 `FOR UPDATE characters`。
 * 2. 做什么：防止宗门模块继续手写角色灵石扣减 SQL，把同类协议重新散回业务文件。
 * 3. 不做什么：不执行真实宗门创建/捐献流程，不校验成员、日志和资金计算。
 *
 * 输入/输出：
 * - 输入：宗门核心服务与宗门经济服务源码文本。
 * - 输出：共享入口引用与禁用旧 SQL 片段的断言结果。
 *
 * 数据流/状态流：
 * 读取源码 -> 检查 `consumeCharacterCurrencies` 调用
 * -> 断言旧的 `SELECT spirit_stones ... FOR UPDATE` 和手写扣减 SQL 已消失。
 *
 * 关键边界条件与坑点：
 * 1. 必须同时断言“共享入口存在”和“旧实现消失”，否则局部替换后仍可能残留角色行锁热点。
 * 2. 这里只约束角色货币协议，不约束宗门表与成员表写入顺序，避免把无关实现细节绑进测试。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const readSource = (relativePath: string): string => {
  return readFileSync(new URL(relativePath, import.meta.url), 'utf8');
};

test('宗门创建与捐献应复用共享货币扣减入口并移除 characters FOR UPDATE', () => {
  const coreSource = readSource('../sect/core.ts');
  const economySource = readSource('../sect/economy.ts');

  assert.match(coreSource, /consumeCharacterCurrencies\(characterId,\s*\{/u);
  assert.match(economySource, /consumeCharacterCurrencies\(characterId,\s*\{/u);

  assert.doesNotMatch(coreSource, /SELECT spirit_stones FROM characters WHERE id = \$1 FOR UPDATE/u);
  assert.doesNotMatch(economySource, /SELECT spirit_stones FROM characters WHERE id = \$1 FOR UPDATE/u);
  assert.doesNotMatch(
    coreSource,
    /UPDATE characters SET spirit_stones = spirit_stones - \$1,\s*updated_at = NOW\(\) WHERE id = \$2/u,
  );
  assert.doesNotMatch(
    economySource,
    /UPDATE characters SET spirit_stones = spirit_stones - \$2,\s*updated_at = NOW\(\) WHERE id = \$1/u,
  );
});
