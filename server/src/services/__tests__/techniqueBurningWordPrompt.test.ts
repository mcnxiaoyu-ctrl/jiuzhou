/**
 * 洞府研修焚诀校验测试
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：验证焚诀会统一走规范化、格式校验、敏感词校验与 prompt 语境构造。
 * 2. 做什么：锁定“留空视为未填写、仅 2 个中文字符合法、敏感词必须拦截”的共享口径。
 * 3. 不做什么：不覆盖研修任务建单、worker 执行或前端输入交互。
 *
 * 输入/输出：
 * - 输入：玩家输入的焚诀原始文本。
 * - 输出：规范化结果、校验结果与 prompt extraContext。
 *
 * 数据流/状态流：
 * 原始输入 -> techniqueBurningWordPrompt 共享模块 -> 路由 / service / prompt 构造复用。
 *
 * 关键边界条件与坑点：
 * 1. 留空必须返回 null，不能把“未填写”当成非法输入，否则会平白改变原有随机研修流程。
 * 2. 敏感词检测必须复用现有共享服务，否则焚诀会和角色名、功法命名形成不同词库口径。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  TECHNIQUE_BURNING_WORD_PROMPT_SENSITIVE_MESSAGE,
  TECHNIQUE_BURNING_WORD_PROMPT_SCOPE_RULES,
  buildTechniqueBurningWordPromptContext,
  guardTechniqueBurningWordPrompt,
  normalizeTechniqueBurningWordPrompt,
  validateTechniqueBurningWordPrompt,
} from '../shared/techniqueBurningWordPrompt.js';

test('normalizeTechniqueBurningWordPrompt: 空白输入应视为未填写', () => {
  assert.equal(normalizeTechniqueBurningWordPrompt('   '), null);
});

test('validateTechniqueBurningWordPrompt: 合法 2 个中文字符应通过', () => {
  assert.deepEqual(validateTechniqueBurningWordPrompt(' 焰心 '), {
    success: true,
    value: '焰心',
  });
});

test('validateTechniqueBurningWordPrompt: 超过 2 个中文字符应被拦截', () => {
  const result = validateTechniqueBurningWordPrompt('焚心诀');

  assert.equal(result.success, false);
  if (result.success) return;
  assert.equal(result.message, '焚诀最多 2 个中文字符');
});

test('validateTechniqueBurningWordPrompt: 非中文字符应被拦截', () => {
  const result = validateTechniqueBurningWordPrompt('A');

  assert.equal(result.success, false);
  if (result.success) return;
  assert.equal(result.message, '焚诀只能包含中文字符');
});

test('guardTechniqueBurningWordPrompt: 敏感词应被拦截', async () => {
  const originalEnabled = process.env.SENSITIVE_WORD_SERVICE_ENABLED;
  const originalBaseUrl = process.env.SENSITIVE_WORD_SERVICE_BASE_URL;
  const originalFetch = globalThis.fetch;
  try {
    process.env.SENSITIVE_WORD_SERVICE_ENABLED = 'true';
    process.env.SENSITIVE_WORD_SERVICE_BASE_URL = 'https://example.com';
    globalThis.fetch = async () => {
      return new Response(JSON.stringify({
        code: '0',
        msg: 'ok',
        return_str: '焰',
        word_list: [
          {
            keyword: '焰',
            category: '远端词库',
            position: '0',
            level: '高',
          },
        ],
      }), {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
        },
      });
    };

    const result = await guardTechniqueBurningWordPrompt('焰');

    assert.equal(result.success, false);
    if (result.success) return;
    assert.equal(result.message, TECHNIQUE_BURNING_WORD_PROMPT_SENSITIVE_MESSAGE);
  } finally {
    process.env.SENSITIVE_WORD_SERVICE_ENABLED = originalEnabled;
    process.env.SENSITIVE_WORD_SERVICE_BASE_URL = originalBaseUrl;
    globalThis.fetch = originalFetch;
  }
});

test('buildTechniqueBurningWordPromptContext: 合法焚诀应生成稳定 extraContext', () => {
  assert.deepEqual(buildTechniqueBurningWordPromptContext('炎心'), {
    techniqueBurningWordPrompt: '炎心',
    techniqueBurningWordPromptScopeRules: [...TECHNIQUE_BURNING_WORD_PROMPT_SCOPE_RULES],
  });
  assert.equal(buildTechniqueBurningWordPromptContext('   '), undefined);
});
