import { query, withTransaction } from '../../config/database.js';
import { enqueueCharacterItemGrant } from '../shared/characterItemGrantDeltaService.js';
import { applyCharacterRewardDeltas, createCharacterRewardDelta } from '../shared/characterRewardSettlement.js';
import {
  asFiniteNonNegativeInt,
  asNonEmptyString,
  ensureCharacterAchievementPoints,
  normalizeRewards,
  parseClaimedThresholds,
} from './shared.js';
import type {
  AchievementClaimTitle,
  AchievementRewardConfig,
  AchievementRewardView,
  ClaimAchievementResult,
  ClaimPointRewardResult,
  PointRewardDef,
  PointRewardListResult,
} from './types.js';
import {
  getAchievementDefinitions,
  getAchievementPointsRewardDefinitions,
  getItemDefinitionsByIds,
  getTitleDefinitions,
} from '../staticConfigLoader.js';
import { BusinessError } from '../../middleware/BusinessError.js';
import { grantPermanentTitleTx } from './titleOwnership.js';
import { lockCharacterRewardSettlementTargets } from '../shared/characterRewardTargetLock.js';

type AchievementClaimTransitionRow = {
  previous_status: string | null;
  claimed_achievement_id: string | null;
};

type AchievementPointsClaimTransitionRow = {
  total_points: number | string | null;
  claimed_thresholds: unknown;
  claimed_threshold: number | string | null;
};

/**
 * 成就领取服务
 *
 * 作用：处理成就奖励领取与成就点数奖励领取
 * 不做：不处理成就进度更新（由 progress.ts 负责）
 *
 * 数据流：
 * - claimAchievement：先统一锁定奖励目标（背包互斥锁 + characters 行锁）→ 锁定成就记录 → 发放奖励 → 更新状态为已领取
 * - claimAchievementPointsReward：先统一锁定奖励目标 → 锁定点数记录 → 发放奖励 → 更新已领取阈值列表
 *
 * 边界条件：
 * 1) 使用 @Transactional 保证奖励发放与状态更新的原子性
 * 2) 奖励相关入口统一先拿角色奖励目标锁，避免先占住成就行锁、后等待背包锁时把并发请求拖到 statement timeout
 * 3) 物品发放失败时抛出异常触发回滚，避免部分奖励发放成功但状态未更新
 */
class AchievementClaimService {
  /**
   * 统一锁定成就领奖目标
   *
   * 作用：
   * - 复用共享的奖励目标锁顺序，先拿背包互斥锁，再锁 `characters` 行；
   * - 避免 claimAchievement / claimAchievementPointsReward 各自散落同样的锁协议。
   *
   * 输入/输出：
   * - 输入：单个角色 ID。
   * - 输出：Promise<void>，成功即表示后续奖励写入不会再在背包锁与角色行锁之间反向等待。
   *
   * 数据流：
   * - 领取入口先调用本方法；
   * - 本方法转调 `lockCharacterRewardSettlementTargets([characterId])`；
   * - 后续成就表锁、货币更新、物品入包都沿用同一事务里的既定锁顺序。
   *
   * 关键边界条件与坑点：
   * 1) 这里只处理单角色场景，但仍复用批量锁工具，避免再维护一套单独实现。
   * 2) 必须在进入 `FOR UPDATE character_achievement*` 之前调用，否则无法消除“先锁成就记录再等背包锁”的超时链路。
   */
  private async lockClaimRewardTarget(characterId: number): Promise<void> {
    await lockCharacterRewardSettlementTargets([characterId]);
  }

  private asRewardType(value: unknown): 'silver' | 'spirit_stones' | 'exp' | 'item' | null {
    const raw = asNonEmptyString(value);
    if (!raw) return null;
    if (raw === 'silver') return 'silver';
    if (raw === 'spirit_stones') return 'spirit_stones';
    if (raw === 'exp') return 'exp';
    if (raw === 'item') return 'item';
    return null;
  }

  private async loadItemMetaMap(
    itemIds: string[],
  ): Promise<Map<string, { name: string; icon: string | null }>> {
    const dedup = Array.from(new Set(itemIds.map((id) => id.trim()).filter(Boolean)));
    const out = new Map<string, { name: string; icon: string | null }>();
    if (dedup.length === 0) return out;
    const defs = getItemDefinitionsByIds(dedup);
    for (const id of dedup) {
      const def = defs.get(id);
      if (!def) continue;
      out.set(id, { name: asNonEmptyString(def.name) ?? id, icon: asNonEmptyString(def.icon) });
    }
    return out;
  }

  private collectItemRewardIds(rewards: AchievementRewardConfig[]): string[] {
    const out: string[] = [];
    for (const reward of rewards) {
      if (!reward || typeof reward !== 'object') continue;
      const row = reward as Record<string, unknown>;
      if (this.asRewardType(row.type) !== 'item') continue;
      const itemDefId = asNonEmptyString(row.item_def_id);
      if (itemDefId) out.push(itemDefId);
    }
    return out;
  }

  private async applyRewardsTx(
    userId: number,
    characterId: number,
    rewards: AchievementRewardConfig[],
    obtainedFrom: 'achievement_reward' | 'achievement_points_reward',
  ): Promise<AchievementRewardView[]> {
    const itemMeta = await this.loadItemMetaMap(this.collectItemRewardIds(rewards));
    const out: AchievementRewardView[] = [];
    const rewardDelta = createCharacterRewardDelta();

    for (const reward of rewards) {
      if (!reward || typeof reward !== 'object') continue;
      const row = reward as Record<string, unknown>;
      const type = this.asRewardType(row.type);
      if (!type) continue;

      if (type === 'silver' || type === 'spirit_stones' || type === 'exp') {
        const amount = asFiniteNonNegativeInt(row.amount, 0);
        if (amount <= 0) continue;

        if (type === 'silver') rewardDelta.silver += amount;
        if (type === 'spirit_stones') rewardDelta.spiritStones += amount;
        if (type === 'exp') rewardDelta.exp += amount;
        out.push({ type, amount });
        continue;
      }

      if (type === 'item') {
        const itemDefId = asNonEmptyString(row.item_def_id);
        if (!itemDefId) continue;
        const qty = Math.max(1, asFiniteNonNegativeInt(row.qty, 1));

        const created = await enqueueCharacterItemGrant({
          characterId,
          userId,
          itemDefId,
          qty,
          obtainedFrom,
        });
        if (!created.success) {
          throw new Error(created.message || '发放成就物品失败');
        }

        const meta = itemMeta.get(itemDefId);
        out.push({
          type: 'item',
          itemDefId,
          qty,
          itemName: meta?.name ?? itemDefId,
          itemIcon: meta?.icon ?? null,
        });
      }
    }

    if (rewardDelta.exp > 0 || rewardDelta.silver > 0 || rewardDelta.spiritStones > 0) {
      await applyCharacterRewardDeltas(new Map([[characterId, rewardDelta]]));
    }

    return out;
  }

  private async getTitleInfo(titleId: string): Promise<AchievementClaimTitle | undefined> {
    const id = asNonEmptyString(titleId);
    if (!id) return undefined;
    const row = getTitleDefinitions().find((entry) => entry.id === id && entry.enabled !== false);
    if (!row) return undefined;
    return {
      id,
      name: asNonEmptyString(row.name) ?? id,
      color: asNonEmptyString(row.color),
      icon: asNonEmptyString(row.icon),
    };
  }

  private async grantTitleTx(
    characterId: number,
    titleId: string | null,
  ): Promise<AchievementClaimTitle | undefined> {
    const id = asNonEmptyString(titleId);
    if (!id) return undefined;
    const titleDef = getTitleDefinitions().find((entry) => entry.id === id && entry.enabled !== false);
    if (!titleDef) return undefined;
    await grantPermanentTitleTx(characterId, id);

    return this.getTitleInfo(id);
  }

  private async claimAchievementStatusTx(
    characterId: number,
    achievementId: string,
  ): Promise<{ claimed: boolean; previousStatus: string | null }> {
    const res = await query<AchievementClaimTransitionRow>(
      `
        WITH current_achievement AS (
          SELECT status
          FROM character_achievement
          WHERE character_id = $1
            AND achievement_id = $2
          LIMIT 1
        ),
        claimed_achievement AS (
          UPDATE character_achievement
          SET status = 'claimed',
              claimed_at = NOW(),
              updated_at = NOW()
          WHERE character_id = $1
            AND achievement_id = $2
            AND status = 'completed'
          RETURNING achievement_id
        )
        SELECT
          (SELECT status FROM current_achievement LIMIT 1) AS previous_status,
          (SELECT achievement_id FROM claimed_achievement LIMIT 1) AS claimed_achievement_id
      `,
      [characterId, achievementId],
    );
    const row = res.rows[0];
    return {
      claimed: asNonEmptyString(row?.claimed_achievement_id) === achievementId,
      previousStatus: asNonEmptyString(row?.previous_status),
    };
  }

  private async claimAchievementPointsThresholdTx(
    characterId: number,
    threshold: number,
  ): Promise<{ claimed: boolean; totalPoints: number; claimedThresholds: number[] }> {
    const res = await query<AchievementPointsClaimTransitionRow>(
      `
        WITH current_points AS (
          SELECT total_points, claimed_thresholds
          FROM character_achievement_points
          WHERE character_id = $1
          LIMIT 1
        ),
        updated_points AS (
          UPDATE character_achievement_points
          SET claimed_thresholds = (
                SELECT COALESCE(jsonb_agg(value::int ORDER BY value::int), '[]'::jsonb)
                FROM (
                  SELECT DISTINCT value
                  FROM (
                    SELECT jsonb_array_elements_text(COALESCE((SELECT claimed_thresholds FROM current_points LIMIT 1), '[]'::jsonb)) AS value
                    UNION ALL
                    SELECT $2::text AS value
                  ) AS merged_values
                ) AS dedup_values
              ),
              updated_at = NOW()
          WHERE character_id = $1
            AND total_points >= $2
            AND NOT COALESCE(claimed_thresholds, '[]'::jsonb) @> to_jsonb(ARRAY[$2]::int[])
          RETURNING $2 AS claimed_threshold
        )
        SELECT
          (SELECT total_points FROM current_points LIMIT 1) AS total_points,
          (SELECT claimed_thresholds FROM current_points LIMIT 1) AS claimed_thresholds,
          (SELECT claimed_threshold FROM updated_points LIMIT 1) AS claimed_threshold
      `,
      [characterId, threshold],
    );
    const row = res.rows[0];
    return {
      claimed: asFiniteNonNegativeInt(row?.claimed_threshold, -1) === threshold,
      totalPoints: asFiniteNonNegativeInt(row?.total_points, 0),
      claimedThresholds: parseClaimedThresholds(row?.claimed_thresholds),
    };
  }

  async claimAchievement(
    userId: number,
    characterId: number,
    achievementId: string,
  ): Promise<ClaimAchievementResult> {
    const uid = asFiniteNonNegativeInt(userId, 0);
    const cid = asFiniteNonNegativeInt(characterId, 0);
    const aid = asNonEmptyString(achievementId);
    if (!uid) return { success: false, message: '未登录' };
    if (!cid) return { success: false, message: '角色不存在' };
    if (!aid) return { success: false, message: '成就ID不能为空' };

    const achievementDef = getAchievementDefinitions().find((entry) => entry.id === aid && entry.enabled !== false);
    if (!achievementDef) {
      return { success: false, message: '成就不存在或未解锁' };
    }
    try {
      return await withTransaction(async () => {
        await this.lockClaimRewardTarget(cid);
        const claimTransition = await this.claimAchievementStatusTx(cid, aid);
        if (!claimTransition.claimed) {
          if (claimTransition.previousStatus === null) {
            return { success: false, message: '成就不存在或未解锁' };
          }
          if (claimTransition.previousStatus === 'claimed') {
            return { success: false, message: '奖励已领取' };
          }
          return { success: false, message: '成就尚未完成' };
        }

        const rewards = normalizeRewards(achievementDef.rewards);
        const rewardViews = await this.applyRewardsTx(uid, cid, rewards, 'achievement_reward');
        const title = await this.grantTitleTx(cid, asNonEmptyString(achievementDef.title_id));

        return {
          success: true,
          message: 'ok',
          data: {
            achievementId: aid,
            rewards: rewardViews,
            ...(title ? { title } : {}),
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

  private async toPointRewardDef(
    row: Record<string, unknown>,
    totalPoints: number,
    claimedThresholds: number[],
  ): Promise<PointRewardDef | null> {
    const id = asNonEmptyString(row.id);
    if (!id) return null;

    const threshold = asFiniteNonNegativeInt(row.points_threshold, -1);
    if (threshold < 0) return null;

    const rewards = normalizeRewards(row.rewards);
    const itemMeta = await this.loadItemMetaMap(this.collectItemRewardIds(rewards));
    const rewardViews: AchievementRewardView[] = [];

    for (const reward of rewards) {
      if (!reward || typeof reward !== 'object') continue;
      const entry = reward as Record<string, unknown>;
      const type = this.asRewardType(entry.type);
      if (!type) continue;
      if (type === 'item') {
        const itemDefId = asNonEmptyString(entry.item_def_id);
        if (!itemDefId) continue;
        const qty = Math.max(1, asFiniteNonNegativeInt(entry.qty, 1));
        const meta = itemMeta.get(itemDefId);
        rewardViews.push({
          type,
          itemDefId,
          qty,
          itemName: meta?.name ?? itemDefId,
          itemIcon: meta?.icon ?? null,
        });
        continue;
      }
      const amount = asFiniteNonNegativeInt(entry.amount, 0);
      if (amount <= 0) continue;
      rewardViews.push({ type, amount });
    }

    const claimed = claimedThresholds.includes(threshold);
    const titleId = asNonEmptyString(row.title_id);
    const title = titleId ? await this.getTitleInfo(titleId) : undefined;

    return {
      id,
      threshold,
      name: asNonEmptyString(row.name) ?? id,
      description: String(row.description ?? ''),
      rewards: rewardViews,
      ...(title ? { title } : {}),
      claimable: totalPoints >= threshold && !claimed,
      claimed,
    };
  }

  async getAchievementPointsRewards(characterId: number): Promise<PointRewardListResult> {
    const cid = asFiniteNonNegativeInt(characterId, 0);
    if (!cid) return { totalPoints: 0, claimedThresholds: [], rewards: [] };

    await ensureCharacterAchievementPoints(cid);

    const pointsRes = await query(
      `
      SELECT total_points, claimed_thresholds
      FROM character_achievement_points
      WHERE character_id = $1
      LIMIT 1
    `,
      [cid],
    );

    const pointRow = (pointsRes.rows?.[0] ?? {}) as Record<string, unknown>;
    const totalPoints = asFiniteNonNegativeInt(pointRow.total_points, 0);
    const claimedThresholds = parseClaimedThresholds(pointRow.claimed_thresholds);

    const rewards: PointRewardDef[] = [];
    const defs = getAchievementPointsRewardDefinitions()
      .filter((entry) => entry.enabled !== false)
      .sort((left, right) => {
        const thresholdDelta = asFiniteNonNegativeInt(left.points_threshold, 0) - asFiniteNonNegativeInt(right.points_threshold, 0);
        if (thresholdDelta !== 0) return thresholdDelta;
        const leftSortWeight = asFiniteNonNegativeInt(left.sort_weight, 0);
        const rightSortWeight = asFiniteNonNegativeInt(right.sort_weight, 0);
        if (leftSortWeight !== rightSortWeight) return rightSortWeight - leftSortWeight;
        return String(left.id || '').localeCompare(String(right.id || ''));
      });

    for (const row of defs as Array<Record<string, unknown>>) {
      const parsed = await this.toPointRewardDef(row, totalPoints, claimedThresholds);
      if (parsed) rewards.push(parsed);
    }

    return {
      totalPoints,
      claimedThresholds,
      rewards,
    };
  }

  async claimAchievementPointsReward(
    userId: number,
    characterId: number,
    threshold: number,
  ): Promise<ClaimPointRewardResult> {
    const uid = asFiniteNonNegativeInt(userId, 0);
    const cid = asFiniteNonNegativeInt(characterId, 0);
    const th = asFiniteNonNegativeInt(threshold, -1);
    if (!uid) return { success: false, message: '未登录' };
    if (!cid) return { success: false, message: '角色不存在' };
    if (th < 0) return { success: false, message: '阈值无效' };

    const defRow = getAchievementPointsRewardDefinitions().find(
      (entry) => entry.enabled !== false && asFiniteNonNegativeInt(entry.points_threshold, -1) === th,
    );

    if (!defRow) {
      return { success: false, message: '点数奖励不存在' };
    }
    try {
      return await withTransaction(async () => {
        await this.lockClaimRewardTarget(cid);
        await ensureCharacterAchievementPoints(cid);
        const claimTransition = await this.claimAchievementPointsThresholdTx(cid, th);
        if (!claimTransition.claimed) {
          if (claimTransition.claimedThresholds.includes(th)) {
            return { success: false, message: '该点数奖励已领取' };
          }
          if (claimTransition.totalPoints < th) {
            return { success: false, message: '成就点数不足' };
          }
          return { success: false, message: '点数奖励不存在' };
        }

        const rewards = normalizeRewards(defRow.rewards);
        const rewardViews = await this.applyRewardsTx(uid, cid, rewards, 'achievement_points_reward');
        const title = await this.grantTitleTx(cid, asNonEmptyString(defRow.title_id));

        return {
          success: true,
          message: 'ok',
          data: {
            threshold: th,
            rewards: rewardViews,
            ...(title ? { title } : {}),
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

export const achievementClaimService = new AchievementClaimService();

// 向后兼容的命名导出
export const claimAchievement = achievementClaimService.claimAchievement.bind(achievementClaimService);
export const getAchievementPointsRewards = achievementClaimService.getAchievementPointsRewards.bind(achievementClaimService);
export const claimAchievementPointsReward = achievementClaimService.claimAchievementPointsReward.bind(achievementClaimService);
