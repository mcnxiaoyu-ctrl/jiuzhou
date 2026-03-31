import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildWanderAiUserPayload,
  buildWanderAiPromptRuleSet,
  buildWanderAiSystemMessage,
} from '../wander/ai.js';

test('buildWanderAiPromptRuleSet: 应显式包含 storyTheme 的长度与主题短词约束', () => {
  const ruleSet = buildWanderAiPromptRuleSet('must_continue');

  assert.equal(ruleSet.outputRules.storyThemeLengthRange, '2-24');
  assert.match(
    ruleSet.outputRules.storyThemeStyleRule,
    /必须是 24 字内主题短词/u,
  );
  assert.match(
    ruleSet.outputRules.storyThemeStyleRule,
    /禁止把剧情摘要直接写进 storyTheme/u,
  );
  assert.ok(ruleSet.outputRules.storyThemeExample.length >= 2);
  assert.ok(ruleSet.outputRules.storyThemeExample.length <= 24);
});

test('buildWanderAiPromptRuleSet: 应显式包含 episodeTitle 的长度与短标题约束', () => {
  const ruleSet = buildWanderAiPromptRuleSet('must_continue');

  assert.equal(ruleSet.outputRules.episodeTitleLengthRange, '2-24');
  assert.match(
    ruleSet.outputRules.episodeTitleStyleRule,
    /24字内中文短标题/u,
  );
  assert.match(
    ruleSet.outputRules.episodeTitleStyleRule,
    /禁止句子式长标题/u,
  );
});

test('buildWanderAiPromptRuleSet: 应显式包含 optionTexts 的固定数量与非空短句约束', () => {
  const ruleSet = buildWanderAiPromptRuleSet('must_continue');

  assert.equal(ruleSet.outputRules.optionCount, 3);
  assert.equal(ruleSet.outputRules.optionExample.length, 3);
  assert.match(
    ruleSet.outputRules.optionStyleRule,
    /必须是长度恰好为 3 的字符串数组/u,
  );
  assert.match(
    ruleSet.outputRules.optionStyleRule,
    /每个元素都必须是非空短句/u,
  );
  assert.match(
    ruleSet.outputRules.optionStyleRule,
    /禁止返回空字符串、null、对象/u,
  );
  for (const optionText of ruleSet.outputRules.optionExample) {
    assert.equal(typeof optionText, 'string');
    assert.ok(optionText.length > 0);
  }
});

test('buildWanderAiPromptRuleSet: 应显式包含 opening 的长度与正文风格约束', () => {
  const ruleSet = buildWanderAiPromptRuleSet('must_continue');

  assert.equal(ruleSet.outputRules.openingLengthRange, '80-420');
  assert.match(
    ruleSet.outputRules.openingStyleRule,
    /必须是一段 80 到 420 字的完整正文/u,
  );
  assert.match(
    ruleSet.outputRules.openingStyleRule,
    /禁止只写一句过短摘要/u,
  );
  assert.ok(ruleSet.outputRules.openingExample.length >= 80);
  assert.ok(ruleSet.outputRules.openingExample.length <= 420);
});

test('buildWanderAiSystemMessage: 应在系统提示里强调短标题硬约束', () => {
  const systemMessage = buildWanderAiSystemMessage('must_continue');

  assert.match(systemMessage, /storyTheme 必须是 24 字内主题短词/u);
  assert.match(systemMessage, /storyTheme 示例/u);
  assert.match(systemMessage, /episodeTitle 必须是 24字内中文短标题/u);
  assert.match(systemMessage, /禁止句子式长标题/u);
  assert.match(systemMessage, /optionTexts 必须是长度恰好为 3 的字符串数组/u);
  assert.match(systemMessage, /禁止返回空字符串、null、对象/u);
  assert.match(systemMessage, /optionTexts 示例/u);
  assert.match(systemMessage, /opening 必须是一段 80 到 420 字的完整正文/u);
  assert.match(systemMessage, /opening 示例/u);
});

test('buildWanderAiUserPayload: 不应再把 mainQuestName 透传给模型', () => {
  const payload = buildWanderAiUserPayload({
    nickname: '测试角色',
    realm: '炼气期',
    mapName: '林中空地',
    hasTeam: false,
    activeTheme: null,
    activePremise: null,
    storySummary: null,
    nextEpisodeIndex: 1,
    maxEpisodeIndex: 15,
    canEndThisEpisode: false,
    previousEpisodes: [],
  }, 123456);

  assert.equal(payload.player.nickname, '测试角色');
  assert.equal(payload.player.mapName, '林中空地');
  assert.equal('mainQuestName' in payload.player, false);
});
