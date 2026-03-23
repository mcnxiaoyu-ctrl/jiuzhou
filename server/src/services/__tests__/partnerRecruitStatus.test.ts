/**
 * 伙伴招募状态视图测试
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：验证伙伴招募状态构建器在“未开放 / 已开放”两种口径下返回一致且可展示的数据结构。
 * 2. 做什么：把“未开放不应再走错误分支，而应返回锁定态 DTO”收敛为纯函数测试，避免页面初始化再次把锁定提示当异常 toast。
 * 3. 不做什么：不覆盖数据库查询、不验证路由层发送逻辑，也不测试前端渲染细节。
 *
 * 输入/输出：
 * - 输入：伙伴招募开放态、静态配置（featureCode / 消耗）、以及当前任务与冷却等动态状态。
 * - 输出：前端可直接消费的伙伴招募状态 DTO。
 *
 * 数据流/状态流：
 * service.getRecruitStatus -> buildPartnerRecruitStatusDto -> route 响应 -> PartnerModal / partnerRecruitShared。
 *
 * 关键边界条件与坑点：
 * 1. 未开放时必须清空任务、红点与冷却动态态；否则页面虽然不报错，仍会展示出与锁定状态矛盾的旧信息。
 * 2. 已开放时必须原样保留动态状态；否则会把真实的 pending / draft / failed 结果误抹平。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { buildPartnerRecruitStatusDto } from '../shared/partnerRecruitStatus.js';

const EXPECTED_QUALITY_RATES = [
  { quality: '黄', weight: 4, rate: 40 },
  { quality: '玄', weight: 3, rate: 30 },
  { quality: '地', weight: 2, rate: 20 },
  { quality: '天', weight: 1, rate: 10 },
] as const;

test('buildPartnerRecruitStatusDto: 未开放时应返回锁定态 DTO 并清空动态状态', () => {
  const status = buildPartnerRecruitStatusDto({
    featureCode: 'partner',
    unlockState: {
      unlockRealm: '炼神返虚·养神期',
      unlocked: false,
    },
    spiritStoneCost: 300,
    cooldownHours: 12,
    cooldownUntil: '2026-03-11T10:00:00.000Z',
    cooldownRemainingSeconds: 1800,
    customBaseModelBypassesCooldown: true,
    customBaseModelMaxLength: 12,
    customBaseModelTokenCost: 1,
    customBaseModelTokenItemName: '高级招募令',
    customBaseModelTokenAvailableQty: 2,
    currentJob: {
      generationId: 'job-1',
      status: 'pending',
      startedAt: '2026-03-11T09:00:00.000Z',
      finishedAt: null,
      previewExpireAt: null,
      requestedBaseModel: '雪狐',
      preview: null,
      errorMessage: null,
    },
    hasUnreadResult: true,
    resultStatus: 'failed',
    qualityRates: [...EXPECTED_QUALITY_RATES],
    remainingUntilGuaranteedHeaven: 7,
  });

  assert.equal(status.featureCode, 'partner');
  assert.equal(status.unlockRealm, '炼神返虚·养神期');
  assert.equal(status.unlocked, false);
  assert.equal(status.spiritStoneCost, 300);
  assert.equal(status.cooldownHours, 12);
  assert.equal(status.cooldownUntil, null);
  assert.equal(status.cooldownRemainingSeconds, 0);
  assert.equal(status.customBaseModelBypassesCooldown, true);
  assert.equal(status.customBaseModelMaxLength, 12);
  assert.equal(status.customBaseModelTokenCost, 1);
  assert.equal(status.customBaseModelTokenItemName, '高级招募令');
  assert.equal(status.customBaseModelTokenAvailableQty, 2);
  assert.equal(status.currentJob, null);
  assert.equal(status.hasUnreadResult, false);
  assert.equal(status.resultStatus, null);
  assert.deepEqual(status.qualityRates, EXPECTED_QUALITY_RATES);
  assert.equal(status.remainingUntilGuaranteedHeaven, 7);
});

test('buildPartnerRecruitStatusDto: 已开放时应保留真实动态状态', () => {
  const currentJob = {
    generationId: 'job-2',
    status: 'generated_draft' as const,
    startedAt: '2026-03-11T09:00:00.000Z',
    finishedAt: '2026-03-11T09:05:00.000Z',
    previewExpireAt: '2026-03-12T09:05:00.000Z',
    requestedBaseModel: '雪狐',
    preview: null,
    errorMessage: null,
  };

  const status = buildPartnerRecruitStatusDto({
    featureCode: 'partner',
    unlockState: {
      unlockRealm: '炼神返虚·养神期',
      unlocked: true,
    },
    spiritStoneCost: 300,
    cooldownHours: 12,
    cooldownUntil: '2026-03-11T10:00:00.000Z',
    cooldownRemainingSeconds: 1800,
    customBaseModelBypassesCooldown: true,
    customBaseModelMaxLength: 12,
    customBaseModelTokenCost: 1,
    customBaseModelTokenItemName: '高级招募令',
    customBaseModelTokenAvailableQty: 2,
    currentJob,
    hasUnreadResult: true,
    resultStatus: 'generated_draft',
    qualityRates: [...EXPECTED_QUALITY_RATES],
    remainingUntilGuaranteedHeaven: 1,
  });

  assert.equal(status.unlocked, true);
  assert.equal(status.unlockRealm, '炼神返虚·养神期');
  assert.equal(status.cooldownUntil, '2026-03-11T10:00:00.000Z');
  assert.equal(status.cooldownRemainingSeconds, 1800);
  assert.equal(status.customBaseModelBypassesCooldown, true);
  assert.equal(status.customBaseModelMaxLength, 12);
  assert.equal(status.customBaseModelTokenCost, 1);
  assert.equal(status.customBaseModelTokenItemName, '高级招募令');
  assert.equal(status.customBaseModelTokenAvailableQty, 2);
  assert.deepEqual(status.currentJob, currentJob);
  assert.equal(status.hasUnreadResult, true);
  assert.equal(status.resultStatus, 'generated_draft');
  assert.deepEqual(status.qualityRates, EXPECTED_QUALITY_RATES);
  assert.equal(status.remainingUntilGuaranteedHeaven, 1);
});
