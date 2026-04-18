/**
 * 月卡每日领取原子占位协议回归测试
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：锁定月卡每日领取必须复用原子 ownership 更新 helper，避免回退成 `FOR UPDATE month_card_ownership` 预读。
 * 2. 做什么：锁定领取记录插入与加钱都发生在占位成功之后，形成“先占位、再发奖”的单一路径。
 * 3. 不做什么：不执行真实月卡领取，不校验月卡激活或持续时间展示。
 *
 * 输入/输出：
 * - 输入：monthCardService 源码文本。
 * - 输出：原子 helper、入口复用与禁用旧锁查询的断言结果。
 *
 * 数据流/状态流：
 * 读取源码 -> 检查 `claimMonthCardOwnershipRewardTx` 的 CTE + 条件 UPDATE
 * -> 检查 `claimMonthCardReward` 复用 helper 后再插入 `month_card_claim_record`
 * -> 断言旧的 ownership `FOR UPDATE` 查询已消失。
 *
 * 关键边界条件与坑点：
 * 1. 这里只约束每日领取协议，不约束月卡激活/续期流程；激活入口仍可保留自己的 ownership 锁。
 * 2. 必须同时锁定 helper 复用和旧锁查询消失，否则后续有人可能新增 helper 却继续保留老查询。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

test('claimMonthCardReward 应复用原子领取占位 helper 并移除 ownership FOR UPDATE', () => {
  const source = readFileSync(new URL('../monthCardService.ts', import.meta.url), 'utf8');

  assert.match(source, /const claimMonthCardOwnershipRewardTx = async/u);
  assert.match(source, /WITH current_ownership AS \(/u);
  assert.match(source, /UPDATE month_card_ownership[\s\S]*last_claim_date = \$3::date/u);
  assert.match(source, /const claimTransition = await claimMonthCardOwnershipRewardTx\(characterId,\s*monthCardId,\s*todayKey\)/u);
  assert.match(source, /INSERT INTO month_card_claim_record \(character_id, month_card_id, claim_date, reward_spirit_stones\)/u);

  assert.doesNotMatch(
    source,
    /SELECT id, expire_at, last_claim_date[\s\S]*FROM month_card_ownership[\s\S]*FOR UPDATE/u,
  );
});
