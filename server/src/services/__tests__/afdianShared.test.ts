/**
 * 爱发电共享规则测试
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：锁定 OpenAPI 签名、订单回查比对和私信失败重试时间表的纯函数规则，避免接入细节散落后悄悄漂移。
 * 2. 做什么：验证方案配置查询与月卡奖励载荷只有一个单一来源，后续改需求时能明确看到断言变化。
 * 3. 不做什么：不请求真实爱发电接口、不校验数据库写入，也不覆盖路由响应格式。
 *
 * 输入/输出：
 * - 输入：固定的爱发电订单样本、OpenAPI 参数样本和重试次数。
 * - 输出：共享纯函数的稳定返回值。
 *
 * 数据流/状态流：
 * 测试样本 -> afdian/shared 纯函数 -> 断言订单比对 / MD5 / 重试时间 / 奖励结构。
 *
 * 关键边界条件与坑点：
 * 1. webhook 只负责触发回查，关键订单字段比对必须稳定，否则可能把错误订单当成可信结果写入数据库。
 * 2. 重试时间表必须与私信投递服务共用，不能在测试里另写一套常量后各自漂移。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  AFDIAN_ADVANCED_RECRUIT_TOKEN_PRODUCT_PLAN_ID,
  AFDIAN_DUNWU_TOKEN_PRODUCT_PLAN_ID,
  AFDIAN_MONTH_CARD_PLAN_ID,
  AFDIAN_PLAN_CONFIGS,
  AFDIAN_SPIRIT_STONE_PRODUCT_PLAN_ID,
  assertAfdianOrderMatchesWebhook,
  buildAfdianLogContext,
  buildAfdianOrderRewardPayload,
  buildAfdianRedeemCodeMessage,
  buildAfdianOpenApiSign,
  computeAfdianMessageRetryAt,
  findAfdianOrderByOutTradeNo,
  getAfdianPlanConfig,
  type AfdianWebhookOrder,
} from '../afdian/shared.js';
import { PARTNER_RECRUIT_CUSTOM_BASE_MODEL_TOKEN_ITEM_DEF_ID } from '../shared/partnerRecruitBaseModel.js';
import { TECHNIQUE_RESEARCH_COOLDOWN_BYPASS_TOKEN_ITEM_DEF_ID } from '../shared/techniqueResearchCooldownBypass.js';

const SAMPLE_ORDER: AfdianWebhookOrder = {
  out_trade_no: '202603160001',
  user_id: 'afdian-user-001',
  plan_id: AFDIAN_MONTH_CARD_PLAN_ID,
  month: 1,
  total_amount: '18.00',
  status: 2,
  product_type: 1,
  sku_detail: [{ sku_id: 'sku-month-card-001', count: 1, name: '修行月卡', album_id: '', pic: '' }],
};

test('buildAfdianOpenApiSign: 应生成文档示例一致的 md5 签名', () => {
  assert.equal(
    buildAfdianOpenApiSign({
      token: '123',
      userId: 'abc',
      paramsText: '{"a":333}',
      ts: 1624339905,
    }),
    'a4acc28b81598b7e5d84ebdc3e91710c',
  );
});

test('computeAfdianMessageRetryAt: 应按预设退避节奏给出下次重试时间', () => {
  const base = new Date('2026-03-16T00:00:00.000Z');
  assert.equal(computeAfdianMessageRetryAt(1, base)?.toISOString(), '2026-03-16T00:01:00.000Z');
  assert.equal(computeAfdianMessageRetryAt(2, base)?.toISOString(), '2026-03-16T00:05:00.000Z');
  assert.equal(computeAfdianMessageRetryAt(3, base)?.toISOString(), '2026-03-16T00:30:00.000Z');
  assert.equal(computeAfdianMessageRetryAt(4, base)?.toISOString(), '2026-03-16T02:00:00.000Z');
  assert.equal(computeAfdianMessageRetryAt(5, base)?.toISOString(), '2026-03-17T00:00:00.000Z');
  assert.equal(computeAfdianMessageRetryAt(6, base), null);
});

test('爱发电方案配置应按 plan_id 返回对应奖励规则，并由统一纯函数生成最终奖励', () => {
  assert.deepEqual(Object.keys(AFDIAN_PLAN_CONFIGS), [
    AFDIAN_MONTH_CARD_PLAN_ID,
    AFDIAN_SPIRIT_STONE_PRODUCT_PLAN_ID,
    AFDIAN_ADVANCED_RECRUIT_TOKEN_PRODUCT_PLAN_ID,
    AFDIAN_DUNWU_TOKEN_PRODUCT_PLAN_ID,
  ]);

  const monthCardPlan = getAfdianPlanConfig(AFDIAN_MONTH_CARD_PLAN_ID);
  assert.ok(monthCardPlan);
  assert.deepEqual(buildAfdianOrderRewardPayload(monthCardPlan, SAMPLE_ORDER), {
    items: [{ itemDefId: 'cons-monthcard-001', quantity: 1 }],
  });

  assert.deepEqual(buildAfdianOrderRewardPayload(monthCardPlan, {
    ...SAMPLE_ORDER,
    sku_detail: [{ sku_id: 'sku-month-card-001', count: 3, name: '修行月卡', album_id: '', pic: '' }],
  }), {
    items: [{ itemDefId: 'cons-monthcard-001', quantity: 3 }],
  });

  const productPlan = getAfdianPlanConfig(AFDIAN_SPIRIT_STONE_PRODUCT_PLAN_ID);
  assert.ok(productPlan);
  assert.deepEqual(buildAfdianOrderRewardPayload(productPlan, {
    out_trade_no: '202603171821374999575330508',
    user_id: 'afdian-user-002',
    plan_id: AFDIAN_SPIRIT_STONE_PRODUCT_PLAN_ID,
    month: 1,
    total_amount: '3.00',
    status: 2,
    product_type: 1,
    sku_detail: [{ sku_id: 'sku-001', count: 3, name: 'AA', album_id: '', pic: '' }],
  }), {
    spiritStones: 90000,
  });

  const advancedRecruitTokenPlan = getAfdianPlanConfig(AFDIAN_ADVANCED_RECRUIT_TOKEN_PRODUCT_PLAN_ID);
  assert.ok(advancedRecruitTokenPlan);
  assert.deepEqual(buildAfdianOrderRewardPayload(advancedRecruitTokenPlan, {
    out_trade_no: '202603201200000000000000001',
    user_id: 'afdian-user-004',
    plan_id: AFDIAN_ADVANCED_RECRUIT_TOKEN_PRODUCT_PLAN_ID,
    month: 1,
    total_amount: '30.00',
    status: 2,
    product_type: 1,
    sku_detail: [{ sku_id: 'sku-advanced-001', count: 3, name: '高级招募令', album_id: '', pic: '' }],
  }), {
    items: [{ itemDefId: PARTNER_RECRUIT_CUSTOM_BASE_MODEL_TOKEN_ITEM_DEF_ID, quantity: 3 }],
  });

  const dunwuTokenPlan = getAfdianPlanConfig(AFDIAN_DUNWU_TOKEN_PRODUCT_PLAN_ID);
  assert.ok(dunwuTokenPlan);
  assert.deepEqual(buildAfdianOrderRewardPayload(dunwuTokenPlan, {
    out_trade_no: '202603210001000000000000001',
    user_id: 'afdian-user-005',
    plan_id: AFDIAN_DUNWU_TOKEN_PRODUCT_PLAN_ID,
    month: 1,
    total_amount: '30.00',
    status: 2,
    product_type: 1,
    sku_detail: [{ sku_id: 'sku-dunwu-001', count: 3, name: '顿悟符', album_id: '', pic: '' }],
  }), {
    items: [{ itemDefId: TECHNIQUE_RESEARCH_COOLDOWN_BYPASS_TOKEN_ITEM_DEF_ID, quantity: 3 }],
  });

  assert.equal(getAfdianPlanConfig('other-plan'), null);
});

test('爱发电商品方案缺少有效 sku_detail 时应抛出明确错误', () => {
  const productPlan = getAfdianPlanConfig(AFDIAN_SPIRIT_STONE_PRODUCT_PLAN_ID);
  assert.ok(productPlan);

  assert.throws(() => {
    buildAfdianOrderRewardPayload(productPlan, {
      out_trade_no: '202603171821374999575330509',
      user_id: 'afdian-user-003',
      plan_id: AFDIAN_SPIRIT_STONE_PRODUCT_PLAN_ID,
      month: 1,
      total_amount: '1.00',
      status: 2,
      product_type: 1,
      sku_detail: [],
    });
  }, /sku_detail/);
});

test('buildAfdianLogContext: 应输出稳定日志上下文并忽略空值', () => {
  assert.equal(
    buildAfdianLogContext({
      outTradeNo: '202603160001',
      planId: 'plan-001',
      month: 3,
      signed: true,
      emptyText: '',
      skipped: undefined,
      nil: null,
    }),
    'outTradeNo=202603160001 planId=plan-001 month=3 signed=true',
  );
});

test('爱发电订单回查工具应能按 out_trade_no 命中并校验关键字段', () => {
  const verifiedOrder = {
    ...SAMPLE_ORDER,
    out_trade_no: '202603160001',
  };
  assert.deepEqual(findAfdianOrderByOutTradeNo([verifiedOrder], SAMPLE_ORDER.out_trade_no), verifiedOrder);
  assert.equal(findAfdianOrderByOutTradeNo([verifiedOrder], 'missing-order'), null);
  assert.doesNotThrow(() => {
    assertAfdianOrderMatchesWebhook(SAMPLE_ORDER, verifiedOrder);
  });
  assert.throws(() => {
    assertAfdianOrderMatchesWebhook(SAMPLE_ORDER, {
      ...verifiedOrder,
      month: 3,
    });
  }, /month/);
});

test('爱发电兑换码私信文案应适用于赞助与商品订单', () => {
  const message = buildAfdianRedeemCodeMessage('JZABC');
  assert.ok(message.includes('这是为你生成的兑换码：'));
  assert.ok(message.includes('对应奖励'));
  assert.ok(!message.includes('赞助奖励'));
});
