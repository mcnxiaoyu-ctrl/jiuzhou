/**
 * 爱发电接入共享模块
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：集中维护爱发电 webhook / OpenAPI 的常量、签名拼装、方案配置查询和私信重试节奏，避免路由、服务、定时器各写一套。
 * 2. 做什么：集中定义“爱发电订单 -> 本服兑换码消息”的固定文案与方案奖励配置，保证单一入口。
 * 3. 不做什么：不直接发 HTTP 请求、不写数据库，也不负责实际物品发放。
 *
 * 输入/输出：
 * - 输入：爱发电订单字段、OpenAPI 请求参数、当前重试次数。
 * - 输出：签名原文、OpenAPI 签名、兑换码私信正文、下次重试时间与固定奖励载荷。
 *
 * 数据流/状态流：
 * webhook 路由 / OpenAPI 服务 / 私信重试服务 -> 本模块纯函数 -> 上层决定落库、发消息或调度。
 *
 * 关键边界条件与坑点：
 * 1. webhook 现在以 OpenAPI 订单回查作为可信来源，回调体只负责携带 `out_trade_no` 等线索字段，避免把测试请求误当成完整订单。
 * 2. OpenAPI `params` 参与签名时必须使用最终发送的 JSON 字符串，不能先按对象签名再让运行时改写顺序。
 */
import { createHash } from 'node:crypto';
import type {
  GrantedRewardItemPayload as RedeemCodeRewardItem,
  GrantedRewardPayload as RedeemCodeRewardPayload,
} from '../shared/rewardPayload.js';
import { PARTNER_RECRUIT_CUSTOM_BASE_MODEL_TOKEN_ITEM_DEF_ID } from '../shared/partnerRecruitBaseModel.js';
import { TECHNIQUE_RESEARCH_COOLDOWN_BYPASS_TOKEN_ITEM_DEF_ID } from '../shared/techniqueResearchCooldownBypass.js';

export const AFDIAN_MONTH_CARD_PLAN_ID = 'a57feb58323011f1b48952540025c377';
export const AFDIAN_SPIRIT_STONE_PRODUCT_PLAN_ID = 'ac7064ea21ca11f1a2b15254001e7c00';
export const AFDIAN_ADVANCED_RECRUIT_TOKEN_PRODUCT_PLAN_ID = '5ca895ba23ad11f1984552540025c377';
export const AFDIAN_DUNWU_TOKEN_PRODUCT_PLAN_ID = 'f1a4b2d0250011f18c3b52540025c377';
export const AFDIAN_REDEEM_SOURCE_TYPE = 'afdian_order';
export const AFDIAN_MONTH_CARD_ITEM_DEF_ID = 'cons-monthcard-001';
export const AFDIAN_OPEN_API_DEFAULT_BASE_URL = 'https://ifdian.net';
export const AFDIAN_MESSAGE_RETRY_DELAYS_SECONDS = [60, 300, 1800, 7200, 86400] as const;

export type { RedeemCodeRewardItem, RedeemCodeRewardPayload };

export type AfdianWebhookSkuDetail = {
  sku_id: string;
  count: number;
  name: string;
  album_id: string;
  pic: string;
};

export type AfdianWebhookOrder = {
  out_trade_no: string;
  custom_order_id?: string;
  user_id: string;
  user_private_id?: string;
  plan_id: string;
  month: number;
  total_amount: string;
  show_amount?: string;
  status: number;
  remark?: string;
  redeem_id?: string;
  product_type?: number;
  discount?: string;
  title?: string;
  sku_detail?: AfdianWebhookSkuDetail[];
  address_person?: string;
  address_phone?: string;
  address_address?: string;
};

export type AfdianWebhookPayload = {
  ec: number;
  em: string;
  sign: string;
  data: {
    type: 'order';
    order: AfdianWebhookOrder;
  };
};

export type AfdianWebhookPayloadInput = {
  ec?: number;
  em?: string;
  sign?: string;
  data?: {
    type?: string;
    order?: Partial<AfdianWebhookOrder>;
  };
};

export type AfdianOpenApiEnvelope<TData extends object> = {
  ec: number;
  em: string;
  data: TData;
};

export type AfdianPlanRewardConfig =
  | {
      kind: 'item';
      unit: 'month' | 'sku_count';
      itemDefId: string;
      quantityPerUnit: number;
    }
  | {
      kind: 'spirit_stones';
      unit: 'sku_count';
      amountPerUnit: number;
    };

export type AfdianPlanConfig = {
  reward: AfdianPlanRewardConfig;
};

export type AfdianLogFieldValue = string | number | boolean | null | undefined;

export const AFDIAN_PLAN_CONFIGS: Readonly<Record<string, AfdianPlanConfig>> = {
  [AFDIAN_MONTH_CARD_PLAN_ID]: {
    reward: {
      kind: 'item',
      unit: 'sku_count',
      itemDefId: AFDIAN_MONTH_CARD_ITEM_DEF_ID,
      quantityPerUnit: 1,
    },
  },
  [AFDIAN_SPIRIT_STONE_PRODUCT_PLAN_ID]: {
    reward: {
      kind: 'spirit_stones',
      unit: 'sku_count',
      amountPerUnit: 30000,
    },
  },
  [AFDIAN_ADVANCED_RECRUIT_TOKEN_PRODUCT_PLAN_ID]: {
    reward: {
      kind: 'item',
      unit: 'sku_count',
      itemDefId: PARTNER_RECRUIT_CUSTOM_BASE_MODEL_TOKEN_ITEM_DEF_ID,
      quantityPerUnit: 1,
    },
  },
  [AFDIAN_DUNWU_TOKEN_PRODUCT_PLAN_ID]: {
    reward: {
      kind: 'item',
      unit: 'sku_count',
      itemDefId: TECHNIQUE_RESEARCH_COOLDOWN_BYPASS_TOKEN_ITEM_DEF_ID,
      quantityPerUnit: 1,
    },
  },
};

export const getAfdianOpenApiBaseUrl = (): string => {
  const raw = String(process.env.AFDIAN_OPEN_API_BASE_URL ?? AFDIAN_OPEN_API_DEFAULT_BASE_URL).trim();
  return raw.replace(/\/+$/u, '') || AFDIAN_OPEN_API_DEFAULT_BASE_URL;
};

export const getAfdianPlanConfig = (planId: string): AfdianPlanConfig | null => {
  const normalizedPlanId = planId.trim();
  if (!normalizedPlanId) {
    return null;
  }
  return AFDIAN_PLAN_CONFIGS[normalizedPlanId] ?? null;
};

const computeAfdianSkuPurchaseCount = (order: AfdianWebhookOrder): number => {
  if (!Array.isArray(order.sku_detail) || order.sku_detail.length <= 0) {
    throw new Error('爱发电商品订单缺少有效 sku_detail');
  }

  let totalCount = 0;
  for (const sku of order.sku_detail) {
    if (!Number.isInteger(sku.count) || sku.count <= 0) {
      throw new Error('爱发电商品订单 sku_detail.count 必须为正整数');
    }
    totalCount += sku.count;
  }

  if (totalCount <= 0) {
    throw new Error('爱发电商品订单 sku_detail.count 汇总后必须大于 0');
  }

  return totalCount;
};

const computeAfdianRewardUnits = (
  rewardConfig: AfdianPlanRewardConfig,
  order: AfdianWebhookOrder,
): number => {
  if (rewardConfig.unit === 'month') {
    return order.month;
  }
  return computeAfdianSkuPurchaseCount(order);
};

export const buildAfdianOrderRewardPayload = (
  planConfig: AfdianPlanConfig,
  order: AfdianWebhookOrder,
): RedeemCodeRewardPayload => {
  const rewardUnits = computeAfdianRewardUnits(planConfig.reward, order);
  if (planConfig.reward.kind === 'item') {
    return {
      items: [
        {
          itemDefId: planConfig.reward.itemDefId,
          quantity: planConfig.reward.quantityPerUnit * rewardUnits,
        },
      ],
    };
  }

  return {
    spiritStones: planConfig.reward.amountPerUnit * rewardUnits,
  };
};

export const buildAfdianLogContext = (fields: Record<string, AfdianLogFieldValue>): string => {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(fields)) {
    if (value === null || value === undefined) {
      continue;
    }
    if (typeof value === 'string' && !value.trim()) {
      continue;
    }
    parts.push(`${key}=${String(value)}`);
  }
  return parts.join(' ');
};

export const findAfdianOrderByOutTradeNo = (
  orders: readonly AfdianWebhookOrder[],
  outTradeNo: string,
): AfdianWebhookOrder | null => {
  const normalizedOutTradeNo = outTradeNo.trim();
  if (!normalizedOutTradeNo) {
    return null;
  }
  return orders.find((order) => order.out_trade_no.trim() === normalizedOutTradeNo) ?? null;
};

export const assertAfdianOrderMatchesWebhook = (
  webhookOrder: AfdianWebhookOrder,
  verifiedOrder: AfdianWebhookOrder,
): void => {
  const mismatchFields: string[] = [];
  if (verifiedOrder.out_trade_no !== webhookOrder.out_trade_no) mismatchFields.push('out_trade_no');
  if (verifiedOrder.user_id !== webhookOrder.user_id) mismatchFields.push('user_id');
  if (verifiedOrder.plan_id !== webhookOrder.plan_id) mismatchFields.push('plan_id');
  if (verifiedOrder.month !== webhookOrder.month) mismatchFields.push('month');
  if (verifiedOrder.total_amount !== webhookOrder.total_amount) mismatchFields.push('total_amount');
  if (verifiedOrder.status !== webhookOrder.status) mismatchFields.push('status');

  if (mismatchFields.length > 0) {
    throw new Error(`爱发电订单回查结果与 webhook 不一致：${mismatchFields.join(', ')}`);
  }
};

export const hasAfdianWebhookOrderPayload = (
  payload: AfdianWebhookPayloadInput,
): payload is AfdianWebhookPayloadInput & {
  data: {
    type: 'order';
    order: Partial<AfdianWebhookOrder>;
  };
} => {
  return payload.data?.type === 'order' && Boolean(payload.data.order);
};

export const buildAfdianOpenApiSign = (input: {
  token: string;
  userId: string;
  paramsText: string;
  ts: number;
}): string => {
  const signText = `${input.token}params${input.paramsText}ts${String(input.ts)}user_id${input.userId}`;
  return createHash('md5').update(signText).digest('hex');
};

export const buildAfdianRedeemCodeMessage = (code: string): string => {
  return [
    '感谢你支持《九州修仙录》！',
    '这是为你生成的赞助兑换码：',
    code,
    '进入游戏后，在“设置 - 兑换码”中输入即可领取对应赞助奖励。',
  ].join('\n');
};

export const computeAfdianMessageRetryAt = (
  nextAttemptCount: number,
  now: Date = new Date(),
): Date | null => {
  const delaySeconds = AFDIAN_MESSAGE_RETRY_DELAYS_SECONDS[nextAttemptCount - 1];
  if (!delaySeconds) return null;
  return new Date(now.getTime() + delaySeconds * 1000);
};
