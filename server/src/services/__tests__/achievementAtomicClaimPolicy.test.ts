/**
 * 成就领奖原子流转协议回归测试
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：锁定成就奖励与成就点数奖励都必须复用原子 claim helper，避免回退成 `FOR UPDATE` 预读再二次更新。
 * 2. 做什么：锁定奖励目标锁顺序仍保留在 helper 之前，避免只优化状态位却破坏既有锁顺序协议。
 * 3. 不做什么：不执行真实奖励发放，不校验称号授予与掉落细节。
 *
 * 输入/输出：
 * - 输入：achievement/claim 源码文本。
 * - 输出：原子 helper、入口复用与禁用旧锁查询的断言结果。
 *
 * 数据流/状态流：
 * 读取源码 -> 检查 `claimAchievementStatusTx` 与 `claimAchievementPointsThresholdTx` 的 SQL 结构
 * -> 检查两个入口仍先调用 `lockClaimRewardTarget`
 * -> 断言旧的 `FOR UPDATE` 与尾部手写状态更新已消失。
 *
 * 关键边界条件与坑点：
 * 1. 这里只约束状态流转协议，不约束 `applyRewardsTx` 的具体奖励类型，避免把测试绑在无关实现细节上。
 * 2. 必须同时锁定“奖励目标锁先行”和“旧 SQL 消失”，否则后续可能只做了一半优化。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

test('achievement claim 应复用原子状态流转 helper 并移除 FOR UPDATE', () => {
  const source = readFileSync(new URL('../achievement/claim.ts', import.meta.url), 'utf8');

  assert.match(source, /const? claimAchievementStatusTx|private async claimAchievementStatusTx/u);
  assert.match(source, /WITH current_achievement AS \(/u);
  assert.match(source, /UPDATE character_achievement[\s\S]*status = 'claimed'/u);
  assert.match(source, /await this\.lockClaimRewardTarget\(cid\);[\s\S]*const claimTransition = await this\.claimAchievementStatusTx\(cid,\s*aid\)/u);

  assert.match(source, /const? claimAchievementPointsThresholdTx|private async claimAchievementPointsThresholdTx/u);
  assert.match(source, /WITH current_points AS \(/u);
  assert.match(source, /UPDATE character_achievement_points[\s\S]*claimed_thresholds/u);
  assert.match(source, /await this\.lockClaimRewardTarget\(cid\);[\s\S]*await ensureCharacterAchievementPoints\(cid\);[\s\S]*const claimTransition = await this\.claimAchievementPointsThresholdTx\(cid,\s*th\)/u);

  assert.doesNotMatch(
    source,
    /SELECT status[\s\S]*FROM character_achievement[\s\S]*FOR UPDATE/u,
  );
  assert.doesNotMatch(
    source,
    /SELECT total_points,\s*claimed_thresholds[\s\S]*FROM character_achievement_points[\s\S]*FOR UPDATE/u,
  );
});
