/**
 * 洞府研修创作方向提示词测试
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：锁定洞府研修专属创作方向 prompt context 的字段名与规则内容，避免后续重构时再次把这条规则并回共享功法生成约束。
 * 2. 不做什么：不请求真实模型，不验证 service 组装，也不覆盖伙伴天生功法链路。
 *
 * 输入/输出：
 * - 输入：无。
 * - 输出：稳定的洞府研修创作方向 extraContext。
 *
 * 数据流/状态流：
 * 测试 -> buildTechniqueResearchCreativeDirectionPromptContext -> 洞府研修 service 组装 promptContext 时复用。
 *
 * 关键边界条件与坑点：
 * 1. 这里的规则必须是洞府研修专属字段，不能复用伙伴链路已有字段名，否则隔离边界会再次被打穿。
 * 2. 返回数组需要复制，避免调用方误改共享常量后影响同进程后续请求。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  TECHNIQUE_RESEARCH_CREATIVE_DIRECTION_RULES,
  buildTechniqueResearchCreativeDirectionPromptContext,
} from '../shared/techniqueResearchCreativeDirectionPrompt.js';

test('buildTechniqueResearchCreativeDirectionPromptContext: 应返回稳定的洞府研修专属创作方向规则副本', () => {
  const context = buildTechniqueResearchCreativeDirectionPromptContext();

  assert.deepEqual(context.techniqueResearchCreativeDirectionRules, [
    ...TECHNIQUE_RESEARCH_CREATIVE_DIRECTION_RULES,
  ]);
  assert.notEqual(
    context.techniqueResearchCreativeDirectionRules,
    TECHNIQUE_RESEARCH_CREATIVE_DIRECTION_RULES,
  );
});
