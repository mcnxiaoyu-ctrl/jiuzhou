/**
 * 伙伴坊市挂单生命周期共享模块
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：集中管理伙伴坊市列表缓存失效，以及 active 挂单取消后的状态更新与手续费退回。
 * 2. 做什么：让坊市服务与伙伴回收脚本复用同一份“取消挂单”实现，避免 SQL、退款口径与缓存失效逻辑分叉。
 * 3. 不做什么：不处理伙伴上架参数校验、不决定谁有权限触发取消，也不负责伙伴删除或交易购买。
 *
 * 输入/输出：
 * - 输入：挂单 ID、可选的预期卖家角色 ID。
 * - 输出：统一的取消结果对象，包含是否成功、卖家角色 ID 与退回手续费金额。
 *
 * 数据流/状态流：
 * 调用方传入 listingId -> 锁定 `market_partner_listing` active 记录 -> 更新为 cancelled
 * -> 退回 `listing_fee_silver` -> 失效伙伴坊市列表缓存 -> 返回取消结果。
 *
 * 复用设计说明：
 * - 伙伴坊市服务的主动下架与伙伴回收脚本的强制回收都依赖同一条挂单终止链路，因此把状态更新、手续费退回、缓存失效统一收口。
 * - 坊市列表版本失效也放在这里，保证所有修改挂单状态的入口都能命中同一份 Redis 版本键。
 *
 * 关键边界条件与坑点：
 * 1. 这里只允许取消 `status='active'` 的挂单，历史 `sold/cancelled` 记录绝不能重复退手续费。
 * 2. 取消挂单必须先 `FOR UPDATE` 锁住目标行，再更新状态并退费；否则并发购买和回收会出现重复操作。
 */
import { query } from '../../config/database.js';
import {
    addCharacterCurrenciesExact,
} from '../inventory/shared/consume.js';
import { createCacheVersionManager } from './cacheVersion.js';

export type CancelActivePartnerMarketListingResult =
    | {
        success: true;
        sellerCharacterId: number;
        refundFeeSilver: bigint;
    }
    | {
        success: false;
        message: string;
    };

type PartnerMarketListingRow = {
    id: number;
    seller_character_id: number;
    status: string;
    listing_fee_silver: string | number | bigint;
};

export const partnerMarketListingsCacheVersion = createCacheVersionManager('partner-market:listings');

export const invalidatePartnerMarketListingsCache = async (): Promise<void> => {
    await partnerMarketListingsCacheVersion.bumpVersion();
};

export const cancelActivePartnerMarketListing = async (params: {
    listingId: number;
    expectedSellerCharacterId?: number;
}): Promise<CancelActivePartnerMarketListingResult> => {
    const listingResult = await query<PartnerMarketListingRow>(
        `
          SELECT id, seller_character_id, status, listing_fee_silver
          FROM market_partner_listing
          WHERE id = $1
          FOR UPDATE
        `,
        [params.listingId],
    );
    if (listingResult.rows.length <= 0) {
        return { success: false, message: '上架记录不存在' };
    }

    const listing = listingResult.rows[0];
    if (
        params.expectedSellerCharacterId !== undefined
        && Number(listing.seller_character_id) !== params.expectedSellerCharacterId
    ) {
        return { success: false, message: '上架记录归属异常' };
    }
    if (String(listing.status) !== 'active') {
        return { success: false, message: '该上架记录不可下架' };
    }

    await query(
        `
          UPDATE market_partner_listing
          SET status = 'cancelled',
              cancelled_at = NOW(),
              updated_at = NOW()
          WHERE id = $1
        `,
        [params.listingId],
    );

    const refundFeeSilver = BigInt(listing.listing_fee_silver ?? 0);
    if (refundFeeSilver > 0n) {
        const addResult = await addCharacterCurrenciesExact(listing.seller_character_id, {
            silver: refundFeeSilver,
        });
        if (!addResult.success) {
            return { success: false, message: addResult.message };
        }
    }

    await invalidatePartnerMarketListingsCache();
    return {
        success: true,
        sellerCharacterId: Number(listing.seller_character_id),
        refundFeeSilver,
    };
};
