/**
 * 兑换码服务
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：集中维护兑换码创建、来源幂等和兑换发奖流程，避免 webhook、后台脚本、前端兑换入口各自写一套发奖逻辑。
 * 2. 做什么：把“来源单号 -> 唯一兑换码”的关系固定在服务层，消除同一订单重复生成新码的问题。
 * 3. 不做什么：不处理爱发电 HTTP 通信、不处理私信重试调度，也不决定前端提示样式。
 *
 * 输入/输出：
 * - 输入：来源类型/来源ID/奖励载荷，或用户ID/角色ID/兑换码字符串。
 * - 输出：创建结果、兑换结果与已发放的奖励明细。
 *
 * 数据流/状态流：
 * webhook 服务 -> getOrCreateCodeBySource -> redeem_code；
 * 前端兑换接口 -> redeemCode -> 系统奖励邮件 -> redeem_code 标记已兑换。
 *
 * 关键边界条件与坑点：
 * 1. 兑换必须在事务中先原子抢占兑换资格，再发奖励邮件，避免并发请求把同一份奖励发两次。
 * 2. 奖励载荷是服务端单一数据源，兑换入口只能消费这份配置，不能在路由层重新拼奖励。
 * 3. 兑换码奖励通过系统邮件投递，并复用通用奖励载荷，避免即时发奖和邮件附件各维护一套规则。
 */
import { randomBytes } from 'node:crypto';

import { query } from '../config/database.js';
import { Transactional } from '../decorators/transactional.js';
import { mailService } from './mailService.js';
import type { RewardResult } from './mainQuest/types.js';
import type { RedeemCodeRewardPayload } from './afdian/shared.js';
import {
  buildGrantRewardsInput,
  buildGrantedRewardPreview,
  normalizeGrantedRewardPayload,
} from './shared/rewardPayload.js';

type RedeemCodeRow = {
  code: string;
  reward_payload: RedeemCodeRewardPayload | null;
  existing_status: string | null;
  redeemed: boolean;
};

type RedeemCodeCreateRow = {
  id: number | string;
  code: string;
  created: boolean;
};

export type RedeemCodeConsumeResult = {
  success: boolean;
  message: string;
  data?: {
    code: string;
    rewards: RewardResult[];
  };
};

const REDEEM_CODE_PREFIX = 'JZ';
const REDEEM_CODE_LENGTH_BYTES = 8;

const normalizeRedeemCode = (code: string): string => {
  return code.trim().toUpperCase();
};

const generateRedeemCode = (): string => {
  return `${REDEEM_CODE_PREFIX}${randomBytes(REDEEM_CODE_LENGTH_BYTES).toString('hex').toUpperCase()}`;
};

const buildRedeemCodeRewardMailTitle = (): string => {
  return '兑换码奖励已送达';
};

const buildRedeemCodeRewardMailContent = (code: string): string => {
  return `你已成功兑换兑换码 ${code}，奖励已通过系统邮件发放，请及时领取。`;
};

const getOrCreateRedeemCodeRow = async (input: {
  sourceType: string;
  sourceRefId: string;
  rewardPayload: RedeemCodeRewardPayload;
}): Promise<{ id: number; code: string; created: boolean }> => {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const code = generateRedeemCode();
    const result = await query<RedeemCodeCreateRow>(
      `
        WITH attempted_insert AS (
          INSERT INTO redeem_code (code, source_type, source_ref_id, reward_payload)
          VALUES ($1, $2, $3, $4::jsonb)
          ON CONFLICT DO NOTHING
          RETURNING id, code, TRUE AS created
        )
        SELECT id, code, created
        FROM attempted_insert
        UNION ALL
        SELECT id, code, FALSE AS created
        FROM redeem_code
        WHERE source_type = $2 AND source_ref_id = $3
        LIMIT 1
      `,
      [code, input.sourceType, input.sourceRefId, JSON.stringify(input.rewardPayload)],
    );
    if (result.rows.length > 0) {
      const row = result.rows[0];
      return {
        id: Number(row.id),
        code: String(row.code),
        created: row.created === true,
      };
    }
  }

  throw new Error('生成兑换码失败，请稍后重试');
};

class RedeemCodeService {
  @Transactional
  async getOrCreateCodeBySource(input: {
    sourceType: string;
    sourceRefId: string;
    rewardPayload: RedeemCodeRewardPayload;
  }): Promise<{ id: number; code: string; created: boolean }> {
    return getOrCreateRedeemCodeRow(input);
  }

  @Transactional
  async redeemCode(
    userId: number,
    characterId: number,
    code: string,
  ): Promise<RedeemCodeConsumeResult> {
    const normalizedCode = normalizeRedeemCode(code);
    if (!normalizedCode) {
      return { success: false, message: '兑换码不能为空' };
    }

    const codeResult = await query<RedeemCodeRow>(
      `
        WITH existing_code AS (
          SELECT code, reward_payload, status
          FROM redeem_code
          WHERE code = $1
          LIMIT 1
        ),
        redeemed_code AS (
          UPDATE redeem_code
          SET status = 'redeemed',
              redeemed_by_user_id = $2,
              redeemed_by_character_id = $3,
              redeemed_at = NOW(),
              updated_at = NOW()
          WHERE code = $1
            AND status = 'created'
          RETURNING code, reward_payload
        )
        SELECT
          COALESCE(
            (SELECT code FROM redeemed_code LIMIT 1),
            (SELECT code FROM existing_code LIMIT 1)
          ) AS code,
          COALESCE(
            (SELECT reward_payload FROM redeemed_code LIMIT 1),
            (SELECT reward_payload FROM existing_code LIMIT 1)
          ) AS reward_payload,
          (SELECT status FROM existing_code LIMIT 1) AS existing_status,
          EXISTS(SELECT 1 FROM redeemed_code) AS redeemed
      `,
      [normalizedCode, userId, characterId],
    );
    const row = codeResult.rows[0];
    const redeemedCode = typeof row?.code === 'string' ? row.code : '';
    if (!redeemedCode) {
      return { success: false, message: '兑换码不存在' };
    }
    if (row?.redeemed !== true) {
      return { success: false, message: '兑换码已使用' };
    }

    const normalizedRewardPayload = normalizeGrantedRewardPayload(
      row.reward_payload ?? null,
    );
    const rewardPreview = buildGrantedRewardPreview(normalizedRewardPayload);

    const mailResult = await mailService.sendMail({
      recipientUserId: userId,
      recipientCharacterId: characterId,
      senderType: 'system',
      senderName: '系统',
      mailType: 'reward',
      title: buildRedeemCodeRewardMailTitle(),
      content: buildRedeemCodeRewardMailContent(redeemedCode),
      attachRewards: normalizedRewardPayload,
      source: 'redeem_code',
      sourceRefId: redeemedCode,
      metadata: {
        redeemCode: redeemedCode,
        grantRewardsInput: buildGrantRewardsInput(normalizedRewardPayload),
      },
    });
    if (!mailResult.success) {
      throw new Error(mailResult.message || '奖励邮件发送失败');
    }

    return {
      success: true,
      message: '兑换成功，奖励已通过邮件发放',
      data: {
        code: redeemedCode,
        rewards: rewardPreview,
      },
    };
  }
}

export const redeemCodeService = new RedeemCodeService();
