/**
 * 宝石合成/转换货币扣减锁策略回归测试
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：锁定 gem 执行链路必须复用公共货币扣减入口，而不是在背包锁内继续 `FOR UPDATE characters`。
 * 2. 做什么：防止实现回退成“读取钱包后整包覆盖写回”的旧协议，避免角色行锁持续到整条合成事务结束。
 * 3. 不做什么：不执行真实宝石合成/转换流程，不校验随机产出、材料扣减与配置解析。
 *
 * 输入/输出：
 * - 输入：宝石服务源码文本。
 * - 输出：共享扣减入口引用与禁用旧实现片段的断言结果。
 *
 * 数据流/状态流：
 * 读取源码 -> 检查 gem 链路中的公共货币扣减调用
 * -> 断言 `getCharacterWalletTx(characterId, true)` 与 `updateCharacterWalletTx` 已消失。
 *
 * 关键边界条件与坑点：
 * 1. 必须同时断言“新入口存在”和“旧入口消失”，否则局部替换后仍可能残留隐藏锁热点。
 * 2. 这里只锁定钱包扣减协议，不约束材料扣减与产物发放顺序，避免把测试绑在无关细节上。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const readSource = (relativePath: string): string => {
  return readFileSync(new URL(relativePath, import.meta.url), 'utf8');
};

test('宝石执行链路应复用公共货币扣减入口并移除角色钱包行锁', () => {
  const source = readSource('../gemSynthesisService.ts');

  assert.match(source, /consumeCharacterCurrencies\(characterId,\s*\{/u);
  assert.doesNotMatch(source, /getCharacterWalletTx\(characterId,\s*true\)/u);
  assert.doesNotMatch(source, /const updateCharacterWalletTx = async/u);
});
