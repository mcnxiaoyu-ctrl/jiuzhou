/**
 * 战令奖励原子占位协议回归测试
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：锁定战令奖励领取必须通过唯一键原子插入领取记录占位，避免“先查已领，再末尾插入”的重复发奖窗口回归。
 * 2. 做什么：锁定占位后物品奖励失败会走统一业务失败抛错，从而回滚领取记录，不会留下“已占位但没发奖”的脏状态。
 * 3. 不做什么：不执行真实战令奖励领取，不校验赛季配置或奖励内容。
 *
 * 输入/输出：
 * - 输入：battlePassService 源码文本。
 * - 输出：原子占位 SQL、统一失败断言入口与禁用旧查询的断言结果。
 *
 * 数据流/状态流：
 * 读取源码 -> 检查 `reserveBattlePassRewardClaimTx` 的 `INSERT ... ON CONFLICT DO NOTHING`
 * -> 检查物品奖励失败会走 `assertServiceSuccess`
 * -> 断言旧的“先查 claim_record 再插入”实现已移除。
 *
 * 关键边界条件与坑点：
 * 1. 这里只锁定领取占位协议，不约束进度行锁与等级判定逻辑，避免把测试绑到无关细节。
 * 2. 必须同时约束“原子占位”和“失败回滚入口”，否则只改一半仍会留下重复发奖或脏占位风险。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

test('battlePassService 应复用原子领取占位并移除已领预查', () => {
  const source = readFileSync(new URL('../battlePassService.ts', import.meta.url), 'utf8');

  assert.match(source, /const reserveBattlePassRewardClaimTx = async/u);
  assert.match(source, /INSERT INTO battle_pass_claim_record \(character_id, season_id, level, track, claimed_at\)/u);
  assert.match(source, /ON CONFLICT \(character_id, season_id, level, track\) DO NOTHING/u);
  assert.match(source, /const claimed = await reserveBattlePassRewardClaimTx\(characterId,\s*seasonId,\s*level,\s*track\)/u);
  assert.match(source, /assertServiceSuccess\(\{\s*success:\s*addResult\.success,/u);

  assert.doesNotMatch(
    source,
    /SELECT 1 FROM battle_pass_claim_record WHERE character_id = \$1 AND season_id = \$2 AND level = \$3 AND track = \$4/u,
  );
});
