import { query, withTransaction } from '../config/database.js';
import { Transactional } from '../decorators/transactional.js';
import { getGameServer } from '../game/gameServer.js';
import { BusinessError } from '../middleware/BusinessError.js';
import { updateAchievementProgress } from './achievementService.js';
import { addCharacterCurrenciesExact } from './inventory/shared/consume.js';
import { consumeSpecificItemInstance } from './inventory/shared/consume.js';
import { invalidateStaminaCache } from './staminaCacheService.js';
import {
  DEFAULT_MONTH_CARD_ITEM_DEF_ID,
  getMonthCardBenefitValues,
  getMonthCardDefinitionById,
  type MonthCardBenefitValues,
} from './shared/monthCardBenefits.js';
import { loadCharacterIdByUserIdDirect } from './shared/characterId.js';
import {
  loadProjectedCharacterItemInstanceById,
  loadProjectedCharacterItemInstancesByLocation,
} from './shared/characterItemInstanceMutationService.js';

export type MonthCardStatusResult = {
  success: boolean;
  message: string;
  data?: {
    monthCardId: string;
    name: string;
    description: string | null;
    durationDays: number;
    dailySpiritStones: number;
    priceSpiritStones: number;
    benefits: MonthCardBenefitValues;
    active: boolean;
    expireAt: string | null;
    daysLeft: number;
    today: string;
    lastClaimDate: string | null;
    canClaim: boolean;
    spiritStones: number;
  };
};

export type MonthCardUseItemResult = {
  success: boolean;
  message: string;
  data?: {
    monthCardId: string;
    expireAt: string;
    daysLeft: number;
  };
};

export type MonthCardClaimResult = {
  success: boolean;
  message: string;
  data?: {
    monthCardId: string;
    date: string;
    rewardSpiritStones: number;
    spiritStones: number;
  };
};

type MonthCardClaimTransitionRow = {
  ownership_id: number | string | null;
  previous_expire_at: Date | string | null;
  previous_last_claim_date: Date | string | null;
  claimed_ownership_id: number | string | null;
};

type MonthCardUseTransitionRow = {
  expire_at: Date | string;
};

const pad2 = (n: number) => String(n).padStart(2, '0');

const buildDateKey = (d: Date) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;

const normalizeDateKey = (v: unknown) => {
  if (v instanceof Date) return buildDateKey(v);
  if (typeof v === 'string') return v.slice(0, 10);
  return '';
};

const asNumber = (v: unknown, fallback: number) => {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
  return Number.isFinite(n) ? n : fallback;
};

const defaultDailySpiritStones = 10000;

const claimMonthCardOwnershipRewardTx = async (
  characterId: number,
  monthCardId: string,
  todayKey: string,
): Promise<{
  claimed: boolean;
  ownershipId: number;
  previousExpireAt: Date | null;
  previousLastClaimDateKey: string;
}> => {
  const res = await query<MonthCardClaimTransitionRow>(
    `
      WITH current_ownership AS (
        SELECT id, expire_at, last_claim_date
        FROM month_card_ownership
        WHERE character_id = $1 AND month_card_id = $2
        LIMIT 1
      ),
      claimed_ownership AS (
        UPDATE month_card_ownership
        SET last_claim_date = $3::date,
            updated_at = NOW()
        WHERE id = (SELECT id FROM current_ownership LIMIT 1)
          AND expire_at > NOW()
          AND (last_claim_date IS NULL OR last_claim_date <> $3::date)
        RETURNING id
      )
      SELECT
        (SELECT id FROM current_ownership LIMIT 1) AS ownership_id,
        (SELECT expire_at FROM current_ownership LIMIT 1) AS previous_expire_at,
        (SELECT last_claim_date FROM current_ownership LIMIT 1) AS previous_last_claim_date,
        (SELECT id FROM claimed_ownership LIMIT 1) AS claimed_ownership_id
    `,
    [characterId, monthCardId, todayKey],
  );
  const row = res.rows[0];
  return {
    claimed: asNumber(row?.claimed_ownership_id, 0) > 0,
    ownershipId: asNumber(row?.ownership_id, 0),
    previousExpireAt: row?.previous_expire_at ? new Date(row.previous_expire_at) : null,
    previousLastClaimDateKey: normalizeDateKey(row?.previous_last_claim_date),
  };
};

const extendMonthCardOwnershipTx = async (
  characterId: number,
  monthCardId: string,
  durationDays: number,
): Promise<Date> => {
  const res = await query<MonthCardUseTransitionRow>(
    `
      INSERT INTO month_card_ownership (character_id, month_card_id, start_at, expire_at)
      VALUES ($1, $2, NOW(), NOW() + ($3::integer * INTERVAL '1 day'))
      ON CONFLICT (character_id, month_card_id) DO UPDATE SET
        start_at = CASE
          WHEN month_card_ownership.expire_at <= NOW() THEN NOW()
          ELSE month_card_ownership.start_at
        END,
        expire_at = CASE
          WHEN month_card_ownership.expire_at <= NOW()
            THEN NOW() + ($3::integer * INTERVAL '1 day')
          ELSE month_card_ownership.expire_at + ($3::integer * INTERVAL '1 day')
        END,
        updated_at = NOW()
      RETURNING expire_at
    `,
    [characterId, monthCardId, durationDays],
  );
  const expireAt = res.rows[0]?.expire_at;
  return expireAt instanceof Date ? expireAt : new Date(String(expireAt));
};

class MonthCardService {
  async getMonthCardStatus(userId: number, monthCardId: string): Promise<MonthCardStatusResult> {
    const charRes = await query(`SELECT id, spirit_stones FROM characters WHERE user_id = $1 LIMIT 1`, [userId]);
    if (charRes.rows.length === 0) return { success: false, message: '角色不存在' };
    const characterId = Number(charRes.rows[0].id);
    const spiritStones = Number(charRes.rows[0].spirit_stones ?? 0);

    const def = getMonthCardDefinitionById(monthCardId);
    if (!def) return { success: false, message: '月卡不存在' };
    const benefits = getMonthCardBenefitValues(monthCardId);

    const ownRes = await query(
      `
        SELECT expire_at, last_claim_date
        FROM month_card_ownership
        WHERE character_id = $1 AND month_card_id = $2
        LIMIT 1
      `,
      [characterId, monthCardId],
    );

    const now = new Date();
    const todayKey = buildDateKey(now);

    const expireAtRaw = ownRes.rows[0]?.expire_at;
    const expireAt = expireAtRaw instanceof Date ? expireAtRaw : expireAtRaw ? new Date(String(expireAtRaw)) : null;
    const lastClaimDateKey = normalizeDateKey(ownRes.rows[0]?.last_claim_date);

    const active = Boolean(expireAt && expireAt.getTime() > now.getTime());
    const daysLeft = active && expireAt ? Math.max(0, Math.ceil((expireAt.getTime() - now.getTime()) / (24 * 60 * 60 * 1000))) : 0;
    const canClaim = active && todayKey !== lastClaimDateKey;
    return {
      success: true,
      message: '获取成功',
      data: {
        monthCardId,
        name: String(def.name || ''),
        description: typeof def.description === 'string' ? def.description : null,
        durationDays: asNumber(def.duration_days, 30),
        dailySpiritStones: asNumber(def.daily_spirit_stones, defaultDailySpiritStones),
        priceSpiritStones: asNumber(def.price_spirit_stones, 0),
        benefits,
        active,
        expireAt: expireAt ? expireAt.toISOString() : null,
        daysLeft,
        today: todayKey,
        lastClaimDate: lastClaimDateKey || null,
        canClaim,
        spiritStones,
      },
    };
  }

  @Transactional
  async useMonthCardItem(
    userId: number,
    monthCardId: string,
    options?: { itemInstanceId?: number; itemDefId?: string },
  ): Promise<MonthCardUseItemResult> {
    const monthCardDef = getMonthCardDefinitionById(monthCardId);
    if (!monthCardDef) {
      return { success: false, message: '月卡不存在或未启用' };
    }

    const durationDays = asNumber(monthCardDef.duration_days, 30);

    const characterId = await loadCharacterIdByUserIdDirect(userId);
    if (!characterId) {
      return { success: false, message: '角色不存在' };
    }

    const itemDefId = options?.itemDefId || DEFAULT_MONTH_CARD_ITEM_DEF_ID;

    let itemInstanceRow: { id: number; qty: number } | null = null;
    if (Number.isInteger(options?.itemInstanceId) && Number(options?.itemInstanceId) > 0) {
      const instance = await loadProjectedCharacterItemInstanceById(
        characterId,
        Number(options?.itemInstanceId),
      );
      if (instance && instance.item_def_id === itemDefId && instance.location === 'bag') {
        itemInstanceRow = { id: instance.id, qty: Number(instance.qty) };
      }
    } else {
      const bagItems = await loadProjectedCharacterItemInstancesByLocation(characterId, 'bag');
      const instance = bagItems
        .filter((item) => item.item_def_id === itemDefId)
        .sort((left, right) => left.created_at.getTime() - right.created_at.getTime())[0];
      if (instance) {
        itemInstanceRow = { id: instance.id, qty: Number(instance.qty) };
      }
    }

    if (!itemInstanceRow || !Number.isFinite(itemInstanceRow.qty) || itemInstanceRow.qty <= 0) {
      return { success: false, message: '背包中没有可用的月卡道具' };
    }
    const consumeResult = await consumeSpecificItemInstance(characterId, itemInstanceRow.id, 1);
    if (!consumeResult.success) {
      return { success: false, message: consumeResult.message };
    }

    const now = new Date();
    const nextExpireAt = await extendMonthCardOwnershipTx(characterId, monthCardId, durationDays);
    await updateAchievementProgress(characterId, 'monthcard:activate', 1);
    await invalidateStaminaCache(characterId);
    void getGameServer().pushCharacterUpdate(userId);

    const daysLeft = Math.max(0, Math.ceil((nextExpireAt.getTime() - now.getTime()) / (24 * 60 * 60 * 1000)));
    return {
      success: true,
      message: '使用成功',
      data: {
        monthCardId,
        expireAt: nextExpireAt.toISOString(),
        daysLeft,
      },
    };
  }

  async claimMonthCardReward(userId: number, monthCardId: string): Promise<MonthCardClaimResult> {
    const monthCardDef = getMonthCardDefinitionById(monthCardId);
    if (!monthCardDef) {
      return { success: false, message: '月卡不存在或未启用' };
    }

    const characterId = await loadCharacterIdByUserIdDirect(userId);
    if (!characterId) {
      return { success: false, message: '角色不存在' };
    }

    const reward = asNumber(monthCardDef.daily_spirit_stones, defaultDailySpiritStones);
    const todayKey = buildDateKey(new Date());

    try {
      return await withTransaction(async () => {
        const claimTransition = await claimMonthCardOwnershipRewardTx(characterId, monthCardId, todayKey);
        if (!claimTransition.claimed) {
          if (claimTransition.ownershipId <= 0) {
            return { success: false, message: '未激活月卡' };
          }
          const expireAt = claimTransition.previousExpireAt;
          if (!expireAt || expireAt.getTime() <= Date.now()) {
            return { success: false, message: '月卡已到期' };
          }
          if (claimTransition.previousLastClaimDateKey === todayKey) {
            return { success: false, message: '今日已领取' };
          }
          return { success: false, message: '月卡领取状态异常' };
        }

        const claimRecordResult = await query<{ id: number | string | null }>(
          `
            INSERT INTO month_card_claim_record (character_id, month_card_id, claim_date, reward_spirit_stones)
            VALUES ($1, $2, $3::date, $4)
            ON CONFLICT (character_id, month_card_id, claim_date) DO NOTHING
            RETURNING id
          `,
          [characterId, monthCardId, todayKey, reward],
        );
        if (claimRecordResult.rows.length === 0) {
          throw new BusinessError('今日已领取');
        }

        const addResult = await addCharacterCurrenciesExact(
          characterId,
          {
            spiritStones: BigInt(reward),
          },
          { includeRemaining: true },
        );
        if (!addResult.success) {
          throw new BusinessError(addResult.message);
        }

        return {
          success: true,
          message: '领取成功',
          data: {
            monthCardId,
            date: todayKey,
            rewardSpiritStones: reward,
            spiritStones: Number(addResult.remaining?.spiritStones ?? 0n),
          },
        };
      });
    } catch (error) {
      if (error instanceof BusinessError) {
        return { success: false, message: error.message };
      }
      throw error;
    }
  }
}

export const monthCardService = new MonthCardService();
