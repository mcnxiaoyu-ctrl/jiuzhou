/**
 * 伙伴招募自定义底模校验测试
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：验证自定义底模会先走格式校验，再走共享敏感词检测，避免招募链路绕开现有词库。
 * 2. 做什么：锁定“留空视为未指定、合法中文可放行、敏感词必须拦截”的统一口径。
 * 3. 不做什么：不读取数据库，也不覆盖伙伴招募任务创建或 worker 执行。
 *
 * 输入/输出：
 * - 输入：玩家输入的自定义底模文本。
 * - 输出：底模校验结果 `success/value/message`。
 *
 * 数据流/状态流：
 * 原始输入 -> validatePartnerRecruitRequestedBaseModel / guardPartnerRecruitRequestedBaseModel -> 招募 service 消费。
 *
 * 关键边界条件与坑点：
 * 1. 留空必须回到“未指定底模”的语义，不能被误当成非法输入。
 * 2. 敏感词校验必须复用共享服务，否则角色名、功法名和自定义底模会出现三套词库口径。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  PARTNER_RECRUIT_CUSTOM_BASE_MODEL_BYPASSES_COOLDOWN,
  PARTNER_RECRUIT_CUSTOM_BASE_MODEL_SENSITIVE_MESSAGE,
  guardPartnerRecruitRequestedBaseModel,
  shouldPartnerRecruitBypassCooldownWithCustomBaseModel,
  shouldPartnerRecruitUseCustomBaseModelToken,
  validatePartnerRecruitRequestedBaseModelSelection,
  validatePartnerRecruitRequestedBaseModel,
} from '../shared/partnerRecruitBaseModel.js';

test('validatePartnerRecruitRequestedBaseModel: 留空应视为未指定底模', () => {
  assert.deepEqual(validatePartnerRecruitRequestedBaseModel('   '), {
    success: true,
    value: null,
  });
});

test('guardPartnerRecruitRequestedBaseModel: 合法中文底模应通过', async () => {
  const result = await guardPartnerRecruitRequestedBaseModel('雪狐');

  assert.deepEqual(result, {
    success: true,
    value: '雪狐',
  });
});

test('guardPartnerRecruitRequestedBaseModel: 敏感词应被拦截', async () => {
  const result = await guardPartnerRecruitRequestedBaseModel('管理员');

  assert.equal(result.success, false);
  if (result.success) return;
  assert.equal(result.message, PARTNER_RECRUIT_CUSTOM_BASE_MODEL_SENSITIVE_MESSAGE);
});

test('validatePartnerRecruitRequestedBaseModelSelection: 普通招募提交合法底模也应通过', async () => {
  const result = await validatePartnerRecruitRequestedBaseModelSelection('雪狐');

  assert.deepEqual(result, {
    success: true,
    value: '雪狐',
  });
});

test('validatePartnerRecruitRequestedBaseModelSelection: 留空应允许走随机底模', async () => {
  const result = await validatePartnerRecruitRequestedBaseModelSelection('   ');

  assert.deepEqual(result, {
    success: true,
    value: null,
  });
});

test('shouldPartnerRecruitBypassCooldownWithCustomBaseModel: 只要启用高级招募令模式就应绕过冷却', () => {
  assert.equal(PARTNER_RECRUIT_CUSTOM_BASE_MODEL_BYPASSES_COOLDOWN, true);
  assert.equal(shouldPartnerRecruitUseCustomBaseModelToken(true), true);
  assert.equal(shouldPartnerRecruitUseCustomBaseModelToken(false), false);
  assert.equal(shouldPartnerRecruitBypassCooldownWithCustomBaseModel(true), true);
  assert.equal(shouldPartnerRecruitBypassCooldownWithCustomBaseModel(false), false);
});
